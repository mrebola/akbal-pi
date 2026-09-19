import { execFile } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { detectAr9271 } from "../wifiradar/ar9271";
import { enterMonitorMode, exitMonitorMode } from "./monitor";
import { setChannel } from "./rf";
import { PmkidRunner, DeauthRunner } from "./attack";
import { WardriveSession, SESSIONS_ROOT } from "./session";
import { discoverTargets } from "./discovery";
import {
  WardriveStatus,
  WardriveMode,
  WardriveTargetStatus,
  WardriveDeviceView,
} from "./types";
import { registerShutdownHook } from "../device/display";
import { unloadModel } from "../cloud-api/local/ollama-llm";

// ─── Policy constants ────────────────────────────────────────────────────
// Scope: thesis/lab capture only. The allowlist below IS the security
// model — a BSSID is attackable only if the operator explicitly added it
// (POST /api/wardrive/allowlist). Everything else in the air is display-
// only; no code path mass-authorizes "all discovered networks".
const PMKID_TIMEOUT_MS = 45_000;
const PMKID_POLL_MS = 3_000;
const DEAUTH_SETTLE_MS = 8_000; // client reassociation window after the burst
const DEAUTH_BURST = 5; // directed, short bursts — never the 100+ style
const DEAUTH_MAX_ATTEMPTS = 3;
const BETWEEN_TARGETS_MS = 1_500;

function sanitizeBssid(raw: string): string {
  const bssid = String(raw || "").trim().toUpperCase();
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(bssid) ? bssid : "";
}

// RAM policy: wardriving needs headroom and the LLM is useless while the
// radio is busy — unload on enter; leaving wardriving lets the normal
// flow reload the model via the usual switchModel/warmUpModel path.
async function unloadLlmMemory(): Promise<boolean> {
  try {
    await unloadModel();
    console.log("[wardrive] LLM models unloaded from memory");
    return true;
  } catch (err: any) {
    console.warn("[wardrive] model unload failed:", err?.message || err);
    return false;
  }
}

type TargetMeta = {
  ssid: string;
  channel: number;
  status: WardriveTargetStatus;
  method: "" | "pmkid" | "deauth";
  attempts: number;
  error: string;
};

export class WardriveService extends EventEmitter {
  private mode: WardriveMode = "inactive";
  private iface: string | null = null;
  private error = "";
  private modelsUnloaded = false;
  private allowlist = new Set<string>();
  private session: WardriveSession | null = null;
  private targetMeta = new Map<string, TargetMeta>();
  private currentBssid: string | null = null;
  private attackAbort = false;
  private pmkidRunner: PmkidRunner | null = null;
  private deauthRunner: DeauthRunner | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  // Standalone deauth attacks (Deauth tab) — separate from the handshake
  // attack loop's own DeauthRunner so a deauth test and a capture session
  // don't share one runner object. Authorization is a dedicated MAC
  // allowlist (deauthAllowlist); while a deauth is in flight its MAC is
  // here so the UI can show "deauthing" and duplicate requests are ignored.
  private deauthAllowlist = new Set<string>();
  private deauthRunnerByMac = new Map<string, DeauthRunner>();

  getStatus(): WardriveStatus {
    const discovered =
      this.mode === "inactive"
        ? []
        : discoverTargets().map((t: WardriveTargetShape) => ({
            ...t,
            inAllowlist: this.allowlist.has(t.bssid),
          }));
    return {
      mode: this.mode,
      modelsUnloaded: this.modelsUnloaded,
      iface: this.iface,
      error: this.error,
      session: this.session
        ? {
            id: this.session.id,
            startedAt: this.session.startedAt,
            endedAt: this.session.endedAt,
            currentBssid: this.currentBssid,
            targets: [...this.targetMeta.entries()].map(([bssid, meta]) => ({
              bssid,
              ssid: meta.ssid,
              channel: meta.channel,
              status: meta.status,
              method: meta.method,
              attempts: meta.attempts,
              startedAt: null,
              finishedAt: null,
              error: meta.error,
              files: this.targetFiles(bssid),
            })),
          }
        : null,
      targets: discovered,
      allowlist: [...this.allowlist],
    };
  }

  private targetFiles(bssid: string): string[] {
    if (!this.session) return [];
    const prefix = bssid.replace(/:/g, "").toLowerCase();
    try {
      return fs
        .readdirSync(this.session.dir)
        .filter((f) => f.startsWith(prefix))
        .map((f) => path.join(this.session!.dir, f));
    } catch {
      return [];
    }
  }

  // ─── Allowlist (the security boundary) ─────────────────────────────────

  private static clean(bssid: string): string {
    return sanitizeBssid(bssid);
  }

  isAllowlisted(bssid: string): boolean {
    return this.allowlist.has(WardriveService.clean(bssid));
  }

  addToAllowlist(bssid: string): boolean {
    const clean = WardriveService.clean(bssid);
    if (!clean) return false;
    this.allowlist.add(clean);
    this.broadcastStatus();
    return true;
  }

  removeFromAllowlist(bssid: string): boolean {
    const clean = WardriveService.clean(bssid);
    if (this.currentBssid === clean && this.mode === "attacking") {
      return false; // cancel the attack before deauthorizing it
    }
    const removed = this.allowlist.delete(clean);
    if (removed) this.broadcastStatus();
    return removed;
  }

  clearAllowlist(): void {
    this.allowlist.clear();
    this.broadcastStatus();
  }

  // ─── Deauth tab (client-targeted, own allowlist) ────────────────────────

  // Devices in the air, annotated with deauth authorization. Served even
  // with wardriving inactive (read-only view of the live WIFIRADAR
  // capture) — only the *attack* is mode-gated.
  listDevices(): WardriveDeviceView[] {
    const snapshot = getWifiRadarSnapshot(true);
    const ssidByBssid = new Map(
      snapshot.accessPoints.map((ap) => [ap.bssidFull.toUpperCase(), ap.ssid]),
    );
    return snapshot.devices
      .map((d) => {
        const mac = d.macFull.toUpperCase();
        const apBssid = d.associatedBssid ? d.associatedBssid.toUpperCase() : null;
        const apAuthorized = apBssid ? this.allowlist.has(apBssid) : false;
        const clientAuthorized = this.deauthAllowlist.has(mac);
        return {
          mac,
          vendor: d.vendor,
          rssi: d.rssi,
          associatedBssid: apBssid,
          associatedSsid: apBssid ? ssidByBssid.get(apBssid) || null : null,
          clientAuthorized,
          apAuthorized,
          // Deauth policy: the client's own MAC must be explicitly
          // authorized in the deauth allowlist (one click per device — no
          // "deauth everyone" path). The associated AP being in the
          // attack allowlist is displayed as context, not required.
          deauthAuthorized: clientAuthorized,
          deauthing: this.deauthRunnerByMac.has(mac),
          frames: d.frames,
          lastSeen: d.lastSeen,
        };
      })
      .sort((a, b) => b.rssi - a.rssi);
  }

  // Client MACs are user-supplied strings — same strict regex as BSSIDs.
  private static cleanMac(raw: string): string {
    const mac = String(raw || "").trim().toUpperCase();
    return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) ? mac : "";
  }

  authorizeDeauth(rawMac: string): boolean {
    const mac = WardriveService.cleanMac(rawMac);
    if (!mac) return false;
    this.deauthAllowlist.add(mac);
    this.broadcastStatus();
    return true;
  }

  deauthorizeDeauth(rawMac: string): boolean {
    const mac = WardriveService.cleanMac(rawMac);
    if (!mac) return false;
    this.stopDeauth(mac);
    const removed = this.deauthAllowlist.delete(mac);
    if (removed) this.broadcastStatus();
    return removed;
  }

  // Sends DEAUTH_BURST directed deauths to ONE client and keeps the radio
  // on its associated AP's channel for a few seconds so the device actually
  // drops. Refuses: non-allowlisted clients, and clients whose associated AP
  // is itself an active handshake target (two writers on one channel).
  async deauthDevice(rawMac: string, seconds = 10): Promise<{ ok: boolean; error?: string }> {
    const mac = WardriveService.cleanMac(rawMac);
    if (!mac) return { ok: false, error: "MAC inválida" };
    if (!this.deauthAllowlist.has(mac)) {
      return { ok: false, error: "Cliente no autorizado — autorizalo primero (botón Autorizar)" };
    }
    if (this.mode !== "ready" && this.mode !== "scanning") {
      return {
        ok: false,
        error: this.mode === "attacking" ? "Hay una captura en curso — cancelala primero" : "Activá el modo wardriving para usar deauth",
      };
    }
    const snapshot = getWifiRadarSnapshot(true);
    const device = snapshot.devices.find((d) => d.macFull.toUpperCase() === mac);
    if (!device) return { ok: false, error: "El dispositivo no está visible en el aire ahora" };
    const apBssid = device.associatedBssid ? device.associatedBssid.toUpperCase() : null;
    if (!apBssid) {
      return { ok: false, error: "El dispositivo no está asociado a ninguna red — deauth no aplica" };
    }
    if (this.currentBssid === apBssid) {
      return { ok: false, error: "Ese AP está siendo atacado por la sesión de captura ahora mismo" };
    }
    const ap = snapshot.accessPoints.find((a) => a.bssidFull.toUpperCase() === apBssid);
    if (!ap) return { ok: false, error: "No se ve el AP del dispositivo" };

    this.mode = "attacking";
    this.currentBssid = apBssid;
    this.broadcastStatus();
    try {
      await setChannel(this.iface!, ap.channel);
    } catch (err: any) {
      this.mode = "ready";
      this.currentBssid = null;
      this.broadcastStatus();
      return { ok: false, error: `setChannel: ${err?.message || err}` };
    }

    const runner = new DeauthRunner(this.iface!, apBssid, mac, DEAUTH_BURST * 2, ap.channel);
    this.deauthRunnerByMac.set(mac, runner);
    runner.on("log", (line: string) => {
      console.log(`[wardrive] deauth ${mac}: ${line}`);
    });
    const exited = new Promise<void>((resolve) => runner.on("exit", () => resolve()));
    runner.start();
    // Bursts repeat while `seconds` elapses so the device stays offline for
    // the requested window, then everything stops.
    const deadline = Date.now() + Math.max(2, Math.min(60, seconds)) * 1000;
    while (Date.now() < deadline) {
      await Promise.race([exited, sleep(700)]);
      if (Date.now() >= deadline) break;
      // Re-arm one burst per loop until the window closes (the runner
      // exits after its own count; a fresh burst keeps pressure on).
      if (!this.deauthRunnerByMac.has(mac)) break;
    }
    runner.stop();
    this.deauthRunnerByMac.delete(mac);
    if (this.mode === "attacking") this.mode = "ready";
    this.currentBssid = null;
    this.broadcastStatus();
    return { ok: true };
  }

  stopDeauth(rawMac: string): { ok: boolean } {
    const mac = WardriveService.cleanMac(rawMac);
    const runner = this.deauthRunnerByMac.get(mac);
    if (runner) {
      runner.stop();
      this.deauthRunnerByMac.delete(mac);
    }
    if (this.deauthRunnerByMac.size === 0 && this.mode === "attacking" && !this.currentBssid) {
      this.mode = "ready";
    }
    this.broadcastStatus();
    return { ok: true };
  }

  // ─── Enter / exit wardriving mode ──────────────────────────────────────

  async enter(): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "inactive") return { ok: true };
    try {
      const info = await detectAr9271();
      if (!info.present || !info.iface) {
        this.error = "No hay adaptador AR9271 conectado";
        this.broadcastStatus();
        return { ok: false, error: this.error };
      }
      this.iface = info.iface;
      await enterMonitorMode(info.iface);
      this.error = "";
      this.mode = "ready";
      this.session = new WardriveSession();
      console.log(`[wardrive] mode ON (iface=${info.iface}, session=${this.session.id})`);
      this.broadcastStatus();
      void unloadLlmMemory().then((ok) => {
        this.modelsUnloaded = ok;
        this.broadcastStatus();
      });
      return { ok: true };
    } catch (err: any) {
      this.error = err?.message || String(err);
      this.mode = "inactive";
      this.iface = null;
      this.broadcastStatus();
      return { ok: false, error: this.error };
    }
  }

  async exit(): Promise<{ ok: boolean }> {
    if (this.mode === "inactive") return { ok: true };
    this.attackAbort = true;
    this.stopRunners();
    this.clearTimers();
    if (this.iface) {
      const iface = this.iface;
      this.iface = null;
      await exitMonitorMode(iface).catch((err) =>
        console.warn(`[wardrive] failed to restore ${iface}:`, err?.message || err),
      );
    }
    this.session?.end();
    this.session = null;
    this.targetMeta.clear();
    this.mode = "inactive";
    this.currentBssid = null;
    this.modelsUnloaded = false;
    this.broadcastStatus();
    console.log("[wardrive] mode OFF");
    return { ok: true };
  }

  // ─── Attacks ────────────────────────────────────────────────────────────

  async attackOne(bssidRaw: string): Promise<{ ok: boolean; error?: string }> {
    const bssid = WardriveService.clean(bssidRaw);
    if (!bssid) return { ok: false, error: "BSSID inválido" };
    if (this.mode === "attacking") return { ok: false, error: "Ya hay un ataque en curso" };
    if (this.mode !== "ready" && this.mode !== "scanning") {
      return { ok: false, error: "Wardriving no está activo" };
    }
    if (!this.isAllowlisted(bssid)) {
      return { ok: false, error: "BSSID no autorizado — agrégalo a los objetivos del lab primero" };
    }
    const target = discoverTargets().find((t) => t.bssid === bssid);
    if (!target) return { ok: false, error: "El objetivo no está visible en el aire ahora" };

    this.attackAbort = false;
    this.mode = "attacking";
    this.currentBssid = bssid;
    this.broadcastStatus();
    await this.runTarget(bssid, target.ssid, target.channel);
    this.currentBssid = null;
    if (this.mode === "attacking") this.mode = "ready";
    this.broadcastStatus();
    return { ok: true };
  }

  // Sequential attack over an explicit list. "Todo" for the UI means every
  // allowlisted target currently visible — the UI builds that list from the
  // allowlist, never from "everything discovered".
  async attackMany(bssidsRaw: string[]): Promise<{ ok: boolean; error?: string }> {
    if (this.mode === "attacking") return { ok: false, error: "Ya hay un ataque en curso" };
    if (this.mode !== "ready" && this.mode !== "scanning") {
      return { ok: false, error: "Wardriving no está activo" };
    }
    const bssids = [...new Set(bssidsRaw.map(WardriveService.clean).filter(Boolean))].filter((b) =>
      this.isAllowlisted(b),
    );
    if (bssids.length === 0) {
      return { ok: false, error: "Ningún BSSID autorizado en la lista" };
    }
    this.attackAbort = false;
    this.mode = "attacking";
    this.broadcastStatus();
    for (const bssid of bssids) {
      if (this.attackAbort) break;
      if (this.targetMeta.get(bssid)?.status === "captured") continue;
      const target = discoverTargets().find((t) => t.bssid === bssid);
      if (!target) {
        this.updateMeta(bssid, { status: "failed", error: "ya no visible" });
        continue;
      }
      this.currentBssid = bssid;
      this.broadcastStatus();
      await this.runTarget(bssid, target.ssid, target.channel);
      this.currentBssid = null;
      if (this.attackAbort) break;
      await sleep(BETWEEN_TARGETS_MS);
    }
    this.currentBssid = null;
    if (this.mode === "attacking") this.mode = "ready";
    this.broadcastStatus();
    return { ok: true };
  }

  cancelAttacks(): { ok: boolean } {
    this.attackAbort = true;
    this.stopRunners();
    this.clearTimers();
    if (this.currentBssid) {
      this.updateMeta(this.currentBssid, { status: "cancelled" });
      this.currentBssid = null;
    }
    if (this.mode === "attacking") {
      // attackOne/attackMany land the mode themselves when their loop sees
      // the abort; but if we're between awaits, fix it here too.
      this.mode = "ready";
    }
    this.broadcastStatus();
    return { ok: true };
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private updateMeta(bssid: string, patch: Partial<TargetMeta>): void {
    const meta: TargetMeta = this.targetMeta.get(bssid) || {
      ssid: "",
      channel: 0,
      status: "idle",
      method: "",
      attempts: 0,
      error: "",
    };
    Object.assign(meta, patch);
    this.targetMeta.set(bssid, meta);
    this.session?.ensureTarget(bssid, meta.ssid, meta.channel);
    if (patch.status || patch.method || patch.attempts || patch.error) {
      this.session?.updateTarget(bssid, {
        status: meta.status,
        method: meta.method,
        attempts: meta.attempts,
        error: meta.error,
      });
    }
    this.emit("target-update", {
      type: "target-update" as const,
      bssid,
      status: meta.status,
      method: meta.method,
      error: meta.error,
    });
  }

  // Full attack cycle against one BSSID: PMKID first (silent, no client
  // needed), then directed deauth bursts with settle windows. First method
  // to produce EAPOL/PMKID wins; everything lands in the session folder.
  private async runTarget(bssid: string, ssid: string, channel: number): Promise<void> {
    if (!this.session || !this.iface) return;
    if (this.attackAbort) {
      this.updateMeta(bssid, { status: "cancelled" });
      return;
    }
    this.updateMeta(bssid, { ssid, channel, status: "running", error: "" });
    // Lock the radio to the target's channel — hopping mid-attack breaks
    // hcxdumptool's AP filter and deauth timing alike.
    try {
      await setChannel(this.iface, channel);
    } catch (err: any) {
      this.updateMeta(bssid, { status: "failed", error: `setChannel: ${err?.message || err}` });
      return;
    }

    const prefix = bssid.replace(/:/g, "").toLowerCase();
    const pcapng = path.join(this.session.dir, `${prefix}.pcapng`);

    const pmkidCaptured = await this.runPmkid(bssid, pcapng);
    if (this.attackAbort) {
      this.updateMeta(bssid, { status: "cancelled" });
      return;
    }
    if (pmkidCaptured) {
      this.markCaptured(bssid, "pmkid", pcapng);
      return;
    }

    const deauthCaptured = await this.runDeauth(bssid, pcapng);
    if (this.attackAbort) {
      this.updateMeta(bssid, { status: "cancelled" });
      return;
    }
    if (deauthCaptured) {
      this.markCaptured(bssid, "deauth", pcapng);
      return;
    }
    this.updateMeta(bssid, { status: "failed", error: "sin handshake (PMKID + deauth)" });
  }

  private async runPmkid(bssid: string, pcapngPath: string): Promise<boolean> {
    if (!this.iface || !this.session) return false;
    this.updateMeta(bssid, { status: "running", method: "pmkid" });
    this.appendLog(bssid, `[pmkid] starting hcxdumptool on ${this.iface} targeting ${bssid}`);
    const runner = new PmkidRunner(this.iface, bssid, pcapngPath);
    this.pmkidRunner = runner;
    runner.on("log", (line: string) => this.appendLog(bssid, `[pmkid] ${line}`));

    // hcxdumptool runs until killed — success is detected by polling the
    // capture with hcxpcapngtool, not by the process exiting.
    const result = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const poll = async () => {
        if (settled) return;
        if (this.attackAbort) return finish(false);
        const converted = await this.session!.convertCapture(pcapngPath);
        if (converted.hasCapture) {
          if (converted.hashFile) this.session!.addTargetFile(bssid, converted.hashFile);
          return finish(true);
        }
        this.timers.push(setTimeout(poll, PMKID_POLL_MS));
      };
      this.timers.push(setTimeout(poll, PMKID_POLL_MS));
      this.timers.push(setTimeout(() => finish(false), PMKID_TIMEOUT_MS));
      runner.on("exit", () => {
        // Early exit = hcxdumptool itself failed; give the poller one last
        // chance to find a capture written just before the exit.
        setTimeout(() => {
          this.session!.convertCapture(pcapngPath).then((r) => finish(r.hasCapture));
        }, 1500);
      });
      runner.start();
    });
    runner.stop();
    this.pmkidRunner = null;
    return result;
  }

  private async runDeauth(bssid: string, pcapngPath: string): Promise<boolean> {
    if (!this.iface || !this.session) return false;
    this.updateMeta(bssid, { status: "running", method: "deauth" });
    for (let attempt = 1; attempt <= DEAUTH_MAX_ATTEMPTS; attempt++) {
      if (this.attackAbort) return false;
      this.updateMeta(bssid, { attempts: attempt });
      const client = this.pickClientFor(bssid);
      const runner = new DeauthRunner(this.iface, bssid, client, DEAUTH_BURST, 0);
      this.deauthRunner = runner;
      runner.on("log", (line: string) => this.appendLog(bssid, `[deauth ${attempt}] ${line}`));
      const exited = new Promise<void>((resolve) => runner.on("exit", () => resolve()));
      runner.start();
      await Promise.race([
        exited,
        sleep(DEAUTH_BURST * 700 + 3_000),
      ]);
      runner.stop();
      this.deauthRunner = null;
      const captured = await this.waitForCapture(bssid, pcapngPath, DEAUTH_SETTLE_MS);
      if (captured) return true;
      if (this.attackAbort) return false;
    }
    return false;
  }

  private async waitForCapture(bssid: string, pcapngPath: string, windowMs: number): Promise<boolean> {
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      if (this.attackAbort) return false;
      const converted = await this.session!.convertCapture(pcapngPath);
      if (converted.hasCapture) {
        if (converted.hashFile) this.session!.addTargetFile(bssid, converted.hashFile);
        return true;
      }
      await sleep(1_000);
    }
    return false;
  }

  // Associated client MAC from the live WIFIRADAR device table, if any —
  // directed deauth to one client is quieter than a broadcast burst.
  private pickClientFor(bssid: string): string | null {
    try {
      const snapshot = getWifiRadarSnapshot(true);
      const device = snapshot.devices.find((d) => d.associatedBssid === bssid || d.associatedBssid);
      // The aggregator anonymizes; only a full-MAC match is usable here.
      const direct = snapshot.devices.find((d) => d.macFull?.toUpperCase() && d.associatedBssid === bssid);
      if (direct) return direct.macFull.toUpperCase();
      void device;
      return null;
    } catch {
      return null;
    }
  }

  private markCaptured(bssid: string, method: "pmkid" | "deauth", pcapngPath: string): void {
    if (!this.session) return;
    const base = path.basename(pcapngPath);
    this.session.addTargetFile(bssid, base);
    const hashFile = base.replace(/\.pcapng$/, ".hc22000");
    if (fs.existsSync(path.join(this.session.dir, hashFile))) {
      this.session.addTargetFile(bssid, hashFile);
    }
    this.session.updateTarget(bssid, { status: "captured", method, finishedAt: Date.now() });
    this.updateMeta(bssid, { status: "captured", method, error: "" });
    this.appendLog(bssid, `[done] handshake captured via ${method}`);
    this.broadcastStatus();
  }

  private appendLog(bssid: string, line: string): void {
    if (!this.session) return;
    try {
      const prefix = bssid.replace(/:/g, "").toLowerCase();
      fs.appendFileSync(
        path.join(this.session.dir, `${prefix}.log`),
        `${new Date().toISOString()} ${line}\n`,
      );
    } catch {
      // Log failures never break an attack.
    }
  }

  private stopRunners(): void {
    this.pmkidRunner?.stop();
    this.pmkidRunner = null;
    this.deauthRunner?.stop();
    this.deauthRunner = null;
    for (const [, runner] of this.deauthRunnerByMac) {
      runner.stop();
    }
    this.deauthRunnerByMac.clear();
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private broadcastStatus(): void {
    this.emit("status", { type: "status" as const, status: this.getStatus() });
  }

  // File-browser path resolution: every filesystem access from the web UI
  // goes through here. Returns an absolute path only if the requested
  // relative path stays inside the sessions root — no "..", no symlink
  // escapes (both roots are realpath'd). null = refuse.
  resolveSessionPath(relativePath: string): string | null {
    const sessionsRoot = SESSIONS_ROOT;
    if (!fs.existsSync(sessionsRoot)) {
      try {
        fs.mkdirSync(sessionsRoot, { recursive: true });
      } catch {
        return null;
      }
    }
    const rootReal = fs.realpathSync(sessionsRoot);
    const cleaned = String(relativePath || "").replace(/^\/+/, "");
    if (cleaned.includes("\0")) return null;
    const candidate = path.resolve(rootReal, cleaned);
    const candidateReal = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
    if (candidateReal !== rootReal && !candidateReal.startsWith(rootReal + path.sep)) {
      return null;
    }
    return candidate;
  }

  registerShutdown(): void {
    registerShutdownHook(async () => {
      if (this.mode === "inactive") return;
      this.attackAbort = true;
      this.stopRunners();
      this.clearTimers();
      if (this.iface) {
        const iface = this.iface;
        this.iface = null;
        await exitMonitorMode(iface).catch(() => {});
      }
      this.session?.end();
      this.session = null;
      this.mode = "inactive";
    });
  }
}

type WardriveTargetShape = ReturnType<typeof discoverTargets>[number];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Single shared instance — the AR9271 is one radio and the wardrive module
// must be the only thing controlling its monitor-mode lifecycle while a
// session is active.
const sharedWardriveService = new WardriveService();

export function getWardriveService(): WardriveService {
  return sharedWardriveService;
}

// Re-exported for the web UI: needs the same full-MAC view of associated
// clients that discovery uses.
import { getWifiRadarSnapshot } from "../wifiradar/service";