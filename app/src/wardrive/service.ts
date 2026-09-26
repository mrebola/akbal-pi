import { execFile } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { detectMonitorAdapter } from "../wifiradar/adapter";
import { enterMonitorMode, exitMonitorMode } from "./monitor";
import { setChannel } from "./rf";
import { AirodumpCapture, DeauthRunner, scanTarget } from "./attack";
import { WardriveSession, SESSIONS_ROOT } from "./session";
import { discoverTargets } from "./discovery";
import {
  WardriveStatus,
  WardriveMode,
  WardriveTarget,
  WardriveTargetStatus,
  WardriveDeviceView,
  AttackStep,
} from "./types";
import { registerShutdownHook } from "../device/display";
import { unloadModel } from "../cloud-api/local/ollama-llm";
import { crackCheck, resolveCapPath, DictCrack, type CrackResult, type DictCrackState } from "./crack";
import { lookupVendorOrRandomAsync, macvendorsEnabled } from "../wifiradar/oui";
import { demoTargetsWithPassword, DEMO_WD_TARGETS, type DemoWardriveTarget } from "./discovery";

// ─── Policy constants ────────────────────────────────────────────────────
// Scope: thesis/lab capture only. The allowlist below IS the security
// model — a BSSID is attackable only if the operator explicitly added it
// (POST /api/wardrive/allowlist). Everything else in the air is display-
// only; no code path mass-authorizes "all discovered networks".
const PMKID_TIMEOUT_MS = 45_000;
const PMKID_POLL_MS = 3_000;
const DEAUTH_SETTLE_MS = 12_000; // client reassociation window after the burst
const DEAUTH_BURST = 64; // directed, strong burst — aireplay sends this many per client
// v3 policy: one deauth round is usually enough to force a 4-way handshake.
// The attack ends after the FIRST deauth attempt's settle window; if no
// handshake materialized, exactly ONE more attempt runs before giving up.
const DEAUTH_MAX_ATTEMPTS = 2;
const PMKID_PASSIVE_MS = 20_000; // extra passive window after deauth fails
const BETWEEN_TARGETS_MS = 1_500;
// Demo-attack pacing: every simulated step waits this long so the UI
// stepper/log read like the real thing (aircrack/airodump take seconds)
// while touching zero hardware.
const DEMO_STEP_MS = 3_000;
// Demo dict-crack cadence: the fake aircrack consumes the demo wordlist at
// ~1200 keys/s — fast enough to look alive, slow enough to watch.
const DEMO_DICT_TOTAL = 14_344_391;
const DEMO_DICT_FPS = 1200;
const DEMO_DICT_TICK_MS = 3_000;
const DEMO_DICT_KEYS_PER_TICK = (DEMO_DICT_FPS * DEMO_DICT_TICK_MS) / 1000;
const DEMO_DICT_STEPS = Math.ceil(DEMO_DICT_TOTAL / DEMO_DICT_KEYS_PER_TICK);
// The simulated capture always "succeeds" after this many deauth steps.
const DEMO_DEAUTH_STEPS = 1;

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
  private captureRunner: AirodumpCapture | null = null;
  private deauthRunner: DeauthRunner | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  // Standalone deauth attacks (Deauth tab) — separate from the handshake
  // attack loop's own DeauthRunner so a deauth test and a capture session
  // don't share one runner object. Authorization is a dedicated MAC
  // allowlist (deauthAllowlist); while a deauth is in flight its MAC is
  // here so the UI can show "deauthing" and duplicate requests are ignored.
  private deauthAllowlist = new Set<string>();
  private deauthRunnerByMac = new Map<string, DeauthRunner>();
  private discoveredTargets: WardriveTarget[] = [];
  private source: "live" | "demo" = "live";
  // Per-target handshake validation (v2 lab workflow): aircrack verdict
  // against a candidate password the operator provides. Verified state is
  // reported per target so the UI can show "VALIDADO" vs plain CAPTURADO.
  private verified = new Map<string, CrackResult>();
  // The password that was last tried against each target (only in memory,
  // but also written to the per-target info.txt for the lab record).
  private lastValidatedPassword = new Map<string, string>();
  // Active password validations (crackCheck handles) so the Cancel button
  // can kill aircrack mid-run.
  private activeValidation = new Map<string, () => void>();
  // Passwords that actually cracked a handshake (only on verified match) —
  // in-memory for the session, exposed to the UI behind a masked eye toggle.
  private foundPasswords = new Map<string, { password: string; ssid: string }>();
  // Dictionary crack (rockyou) per target: at most ONE running at a time —
  // the Pi's CPU is precious and a second aircrack would just fight for it.
  private dictCrack: DictCrack | null = null;
  private dictCrackBssid: string | null = null;
  // Demo attack simulation: when source="demo", runTarget() doesn't touch
  // any radio — it walks the same step/progress pipeline with 3s pauses and
  // always produces a synthetic "handshake captured" (akbal_lab even
  // validates with its documented lab password). dictDemo tracks the fake
  // rockyou run (progress + result) the same way DictCrack would.
  private demoDict: {
    bssid: string;
    timer: ReturnType<typeof setInterval> | null;
    tried: number;
    running: boolean;
    result: CrackResult | null;
  } | null = null;
  // rockyou on the device (~/wordlists/rockyou.txt) — overridable for tests.
  private dictWordlist(): string {
    return process.env.WARDRIVE_WORDLIST || path.join(process.env.HOME || "/home/akbal", "wordlists", "rockyou.txt");
  }

  // Start a dictionary crack against a captured target. One at a time;
  // progress is polled by the UI via dictStatus(). `capPathOverride`
  // targets a PAST session's capture (the sessions browser's dict button);
  // the path must resolve inside the sessions root (traversal-safe).
  async startDictCrack(bssidRaw: string, capPathOverride?: string): Promise<{ ok: boolean; error?: string }> {
    const bssid = WardriveService.clean(bssidRaw);
    if (!bssid) return { ok: false, error: "BSSID inválido" };
    // Demo: no aircrack, no .cap — the fake run walks rockyou numbers until
    // akbal_lab's (public, lab-only) password is "found". Demo sessions
    // (folder names starting "demo-") route here too: their .cap is a
    // synthetic marker file, running real aircrack on it would be pointless.
    const isDemoSession = Boolean(capPathOverride && /(^|\/|\\)demo-/.test(capPathOverride));
    if (this.source === "demo" || isDemoSession) {
      const demoTarget = DEMO_WD_TARGETS.find((t) => t.bssid === bssid);
      if (!demoTarget) return { ok: false, error: "El objetivo no está visible en el aire ahora" };
      if (this.demoDict?.running) {
        return { ok: false, error: "Ya hay un crack en curso — cancelalo primero" };
      }
      const ownerDir = capPathOverride
        ? this.resolveSessionPath(path.dirname(capPathOverride))
        : undefined;
      return this.startDictDemo(bssid, ownerDir || undefined);
    }
    if (this.dictCrack?.getState().running) {
      return { ok: false, error: `Ya hay un crack en curso (${this.dictCrackBssid}) — cancelalo primero` };
    }
    let capPath: string | null = null;
    if (capPathOverride) {
      capPath = this.resolveSessionPath(capPathOverride);
      if (!capPath || !/\.(cap|pcapng)$/i.test(capPath) || !fs.existsSync(capPath)) {
        return { ok: false, error: "Archivo .cap inválido o fuera de las sesiones" };
      }
    } else {
      const target = this.targetMeta.get(bssid);
      if (!target || target.status !== "captured") {
        return { ok: false, error: "No hay captura para ese objetivo — audítalo primero" };
      }
      if (!this.session) return { ok: false, error: "Sin sesión de wardrive activa" };
      capPath = resolveCapPath(this.session.dir, this.targetFiles(bssid));
      if (!capPath) return { ok: false, error: "El objetivo no tiene archivo .cap" };
    }
    const wordlist = this.dictWordlist();
    if (!fs.existsSync(wordlist)) {
      return { ok: false, error: `Diccionario no encontrado: ${wordlist}` };
    }
    this.dictCrack = new DictCrack(capPath, bssid, wordlist);
    this.dictCrackBssid = bssid;
    this.dictCrack.on("done", () => {
      const st = this.dictCrack?.getState();
      if (st?.result?.matched) {
        this.verified.set(bssid, st.result);
        // The winning password is in aircrack's "KEY FOUND! [ ... ]" output.
        const m = /KEY FOUND!\s*\[\s*(.*?)\s*\]/.exec(st.result.output || "");
        if (m) {
          const password = m[1];
          this.foundPasswords.set(bssid, { password, ssid: this.targetMeta.get(bssid)?.ssid || "" });
          // Persist so the past-sessions browser can show it (eye toggle).
          // With a capPathOverride the active session is not the capture's
          // owner — write into the session folder the .cap belongs to.
          if (capPathOverride) {
            this.persistPastSessionPassword(path.dirname(capPath), bssid, password);
          } else {
            this.session?.setFoundPassword(bssid, password);
          }
        }
        this.appendLog(bssid, "[dict] KEY FOUND — handshake validado con diccionario");
      } else {
        this.appendLog(bssid, `[dict] terminado: ${st?.result?.verdict} (${st?.progress.tried || 0} contraseñas)`);
      }
      this.broadcastStatus();
    });
    this.dictCrack.start();
    this.appendLog(bssid, `[dict] aircrack started with ${wordlist}`);
    return { ok: true };
  }

  // A dictionary crack that ran against a PAST session's .cap writes the
  // recovered password into that session folder: session.json (targets[]
  // password field, via a surgical read-modify-write) + the target's
  // info.txt. Never fatal.
  private persistPastSessionPassword(sessionDir: string, bssid: string, password: string): void {
    try {
      const metaFile = path.join(sessionDir, "session.json");
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      for (const t of meta.targets || []) {
        if (String(t.bssid).toUpperCase() === bssid) t.password = password;
      }
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
      const infoFile = path.join(sessionDir, `${bssid.replace(/:/g, "").toLowerCase()}-info.txt`);
      if (fs.existsSync(infoFile)) {
        const text = fs.readFileSync(infoFile, "utf8");
        const patched = text.replace(
          /(CONTRASEÑA ENCONTRADA\n\s+).+/,
          `$1${password}`,
        );
        fs.writeFileSync(infoFile, patched);
      }
    } catch (err: any) {
      console.warn("[wardrive] past-session password persist failed:", err?.message || err);
    }
  }

  stopDictCrack(): { ok: boolean } {
    if (this.demoDict?.running) this.stopDictDemo();
    this.dictCrack?.stop();
    return { ok: true };
  }

  // Dismiss a finished dictionary crack: drops it from memory so the status
  // endpoint returns null and the UI widget clears (the ✓ ENCONTRADA banner
  // used to stay pinned forever). The outcome is already persisted on the
  // session (verified/password), so nothing is lost.
  clearDictCrack(): { ok: boolean } {
    if (this.demoDict?.running) return { ok: false };
    this.demoDict = null;
    if (this.dictCrack?.getState().running) return { ok: false };
    this.dictCrack = null;
    this.dictCrackBssid = null;
    return { ok: true };
  }

  dictCrackStatus(): { bssid: string | null; state: DictCrackState | null } {
    // Demo fake crack mirrors the real DictCrack state shape.
    if (this.demoDict) {
      const elapsed = this.demoDict.running ? 0 : 0;
      return {
        bssid: this.demoDict.bssid,
        state: {
          running: this.demoDict.running,
          progress: {
            tried: this.demoDict.tried,
            total: DEMO_DICT_TOTAL,
            fps: DEMO_DICT_FPS,
            elapsedSec: elapsed + (this.demoDict.tried / DEMO_DICT_FPS),
          },
          result: this.demoDict.result,
        },
      };
    }
    if (!this.dictCrack) return { bssid: null, state: null };
    return { bssid: this.dictCrackBssid, state: this.dictCrack.getState() };
  }

  getSession(): WardriveSession | null {
    return this.session;
  }

  getVerified(bssid: string): CrackResult | null {
    const clean = WardriveService.clean(bssid);
    return this.verified.get(clean) || null;
  }

  getStatus(): WardriveStatus {
    const discovered = this.discoveredTargets.map((t) => ({
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
              verified: this.verified.get(bssid)?.matched === true,
            })),
          }
        : null,
      targets: discovered,
      allowlist: [...this.allowlist],
    };
  }

  // Refresh the target list: WiFi Radar if running, otherwise iw scan.
  // Called by the web admin on a timer while wardriving is active. With
  // source="demo" the list comes from the WIFIRADAR demo generator instead
  // (UI toggle) — real attacks against demo targets are impossible because
  // authorization still requires the BSSID allowlist and demo BSSIDs are
  // never visible to a real radio, so an allowlist add would simply never
  // find the target in the air ("ya no visible").
  async refreshTargets(): Promise<void> {
    if (this.mode === "inactive") {
      this.discoveredTargets = [];
      return;
    }
    this.discoveredTargets = await discoverTargets(this.source);
    // Local OUI missed some prefixes and a MACVENDORS_API_KEY is configured:
    // resolve those over the API (cached, rate-limited) and patch the labels
    // in place. Fire-and-forget per target, bounded by the discover list.
    if (macvendorsEnabled()) {
      await Promise.all(
        this.discoveredTargets.map(async (t) => {
          if (t.vendor && t.vendor !== "Desconocido") return;
          const { vendor } = await lookupVendorOrRandomAsync(t.bssid);
          if (vendor && vendor !== "Desconocido") t.vendor = vendor;
        }),
      );
    }
  }

  // Web toggle: "live" (default) discovers from the real radio, "demo" from
  // the WIFIRADAR demo generator. Switching clears stale per-target state;
  // if wardriving is active the caller should refreshTargets() afterwards.
  setSource(source: "live" | "demo"): void {
    if (this.source === source) return;
    this.source = source;
    this.targetMeta.clear();
    this.broadcastStatus();
  }

  getSource(): "live" | "demo" {
    return this.source;
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
        error: this.mode === "attacking" ? "Hay una captura en curso — cancelala primero" : "Activá el modo Audit WiFi para usar deauth",
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
    // Demo source: no radio involved — the UI gets the same flow (targets,
    // attack stepper, dict crack, session files) driven by a simulator.
    if (this.source === "demo") {
      this.error = "";
      this.mode = "ready";
      this.iface = null;
      // Radar already runs its own demo feed; nothing to stop or start.
      this.session = new WardriveSession(true);
      void this.refreshTargets();
      console.log(`[wardrive] mode ON (demo, session=${this.session.id})`);
      this.broadcastStatus();
      return { ok: true };
    }
    try {
      const info = await detectMonitorAdapter();
      if (!info.present) {
        this.error = "No hay adaptador WiFi USB conectado — enchufá el dongle para auditar";
        this.broadcastStatus();
        return { ok: false, error: this.error };
      }
      if (!info.monitorSupported || !info.iface) {
        this.error = `El adaptador ${info.description || "USB"} no es compatible con modo monitor`;
        this.broadcastStatus();
        return { ok: false, error: this.error };
      }
      this.iface = info.iface;
      // The WiFi Radar holds the same radio; release it so wardriving can own
      // the adapter for a fixed-channel capture (resumed on exit()).
      await stopWifiRadarService().catch(() => {});
      await enterMonitorMode(info.iface);
      this.error = "";
      this.mode = "ready";
      this.session = new WardriveSession();
      // Initial target scan so the web UI has something to show immediately.
      void this.refreshTargets();
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
    // Give the adapter back to the WiFi Radar. In demo-source sessions the
    // radar was switched to demo (not stopped) — return it to live.
    if (this.source === "demo") {
      void setWifiRadarMode("live").catch(() => {});
    } else {
      startWifiRadarService();
    }
    this.broadcastStatus();
    console.log("[wardrive] mode OFF");
    // Sessions without any captured handshake are not worth keeping —
    // "save everything that has a handshake, always; nothing that doesn't".
    // Demo sessions are pure simulation: they are ALWAYS pruned (nothing
    // real was captured; keeping synthetic .caps on the SD is noise).
    if (this.source === "demo") {
      this.pruneDemoSessions();
      return { ok: true };
    }
    this.pruneEmptySessions();
    return { ok: true };
  }

  // On exit(): delete session folders that contain no capture artifacts
  // (.cap/.pcapng/.hc22000). Keeps failed probes from piling up on the SD
  // card while every session with a real handshake is preserved forever.
  private pruneEmptySessions(): void {
    const root = path.join(process.env.HOME || "/home/akbal", "wardrive-sessions");
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(root).filter((d) => {
        // Demo session folders are handled exclusively by pruneDemoSessions
        // (exit in demo mode) — never pruned/kept by the live heuristic.
        if (d.startsWith("demo-")) return false;
        const full = path.join(root, d);
        return fs.statSync(full).isDirectory();
      });
    } catch {
      return;
    }
    for (const dir of dirs) {
      const full = path.join(root, dir);
      try {
        const hasCapture = fs.readdirSync(full).some((f) => /\.(cap|pcapng|hc22000)$/i.test(f));
        if (!hasCapture) {
          fs.rmSync(full, { recursive: true, force: true });
          console.log(`[wardrive] pruned empty session ${dir} (no handshake)`);
        }
      } catch {
        // never fatal
      }
    }
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
    const target = (await discoverTargets(this.source)).find((t: WardriveTarget) => t.bssid === bssid);
    if (!target) return { ok: false, error: "El objetivo no está visible en el aire ahora" };

    this.attackAbort = false;
    this.mode = "attacking";
    this.currentBssid = bssid;
    this.broadcastStatus();
    if (this.source === "demo") {
      await this.runTargetDemo(bssid, target.ssid, target.channel);
    } else {
      await this.runTarget(bssid, target.ssid, target.channel);
    }
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
    const targets = await discoverTargets(this.source);
    for (const bssid of bssids) {
      if (this.attackAbort) break;
      if (this.targetMeta.get(bssid)?.status === "captured") continue;
      const target = targets.find((t: WardriveTarget) => t.bssid === bssid);
      if (!target) {
        this.updateMeta(bssid, { status: "failed", error: "ya no visible" });
        continue;
      }
      this.currentBssid = bssid;
      this.broadcastStatus();
      if (this.source === "demo") {
        await this.runTargetDemo(bssid, target.ssid, target.channel);
      } else {
        await this.runTarget(bssid, target.ssid, target.channel);
      }
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

  // Emit a progress event for the UI stepper: what step we're on, a human
  // explanation, and optionally the command + its output.
  private progress(bssid: string, step: AttackStep, message: string, command?: string, output?: string): void {
    this.emit("attack-progress", {
      type: "attack-progress" as const,
      bssid,
      step,
      message,
      command,
      output,
    });
    // Also persist to session for reconnection.
    this.session?.addProgress(bssid, step, message, command, output);
  }

  // Full attack cycle against one BSSID: PMKID first (silent, no client
  // needed), then directed deauth bursts with settle windows. First method
  // to produce EAPOL/PMKID wins; everything lands in the session folder.
  // Full attack cycle against one BSSID, airodump + aireplay style:
  //   1. lock the radio to the target channel
  //   2. start airodump-ng capturing (rolling .cap, runs the whole cycle so a
  //      deauth-triggered 4-way handshake AND any PMKID land in one file)
  //   3. fire directed deauth bursts at each associated client (+ a broadcast
  //      burst), so a client reconnects and its 4-way handshake is captured
  //   4. after each burst, validate the capture with hcxpcapngtool — only a
  //      real EAPOL handshake (or PMKID) counts as "captured"; nothing is saved
  //      as a success otherwise.
  private async runTarget(bssid: string, ssid: string, channel: number): Promise<void> {
    if (!this.session || !this.iface) return;
    if (this.attackAbort) {
      this.updateMeta(bssid, { status: "cancelled" });
      return;
    }
    this.updateMeta(bssid, { ssid, channel, status: "running", method: "deauth", error: "" });

    const prefix = path.join(this.session.dir, bssid.replace(/:/g, "").toLowerCase());
    // Clear stale airodump outputs so a previous run's handshake isn't
    // mistaken for this one.
    for (const suffix of ["-01.cap", "-01.csv", "-01.hc22000", "-01.kismet.csv", "-01.kismet.netxml", "-01.log.csv"]) {
      try {
        fs.unlinkSync(prefix + suffix);
      } catch {
        /* not there */
      }
    }

    // Step 1: Resolve the target's REAL channel (and seed clients) from the air
    this.progress(bssid, "scan", `Escaneando ${ssid || bssid} para detectar canal real y clientes...`,
      `airodump-ng --bssid ${bssid} -w ${prefix}-scan --output-format csv ${this.iface}`);
    let realChannel = channel;
    let seedClients: string[] = [];
    try {
      const scan = await scanTarget(this.iface, bssid, `${prefix}-scan`, 9);
      if (scan.channel && scan.channel > 0) {
        if (scan.channel !== channel) {
          this.progress(bssid, "scan", `Canal real detectado: ${scan.channel} (radar decía ${channel})`);
          this.appendLog(bssid, `[capture] canal real ${scan.channel} (el radar reportaba ${channel})`);
        }
        realChannel = scan.channel;
      }
      seedClients = scan.clients;
      if (seedClients.length > 0) {
        this.progress(bssid, "scan", `Clientes detectados: ${seedClients.length} (${seedClients.slice(0, 2).join(", ")}${seedClients.length > 2 ? "..." : ""})`);
      } else {
        this.progress(bssid, "scan", "Sin clientes asociados detectados");
      }
      this.updateMeta(bssid, { channel: realChannel });
    } catch {
      this.progress(bssid, "scan", "Escaneo falló, usando canal del radar");
    }
    if (this.attackAbort) {
      this.updateMeta(bssid, { status: "cancelled" });
      return;
    }

    // Step 2: Lock radio to the target channel
    this.progress(bssid, "lock", `Fijando adaptador en canal ${realChannel}...`,
      `iw dev ${this.iface} set channel ${realChannel}`);
    try {
      await setChannel(this.iface, realChannel);
      this.progress(bssid, "lock", `Canal ${realChannel} fijado correctamente`);
    } catch (err: any) {
      this.progress(bssid, "lock", `Error al fijar canal: ${err?.message || err}`);
      this.updateMeta(bssid, { status: "failed", error: `setChannel: ${err?.message || err}` });
      return;
    }

    // Step 3: Start airodump capture
    this.progress(bssid, "capture", `Iniciando captura de tráfico...`,
      `airodump-ng --bssid ${bssid} -c ${realChannel} -w ${prefix} ${this.iface}`);
    const capturer = new AirodumpCapture(this.iface, bssid, realChannel, prefix);
    this.captureRunner = capturer;
    capturer.on("log", (line: string) => {
      this.appendLog(bssid, `[airodump] ${line}`);
      this.progress(bssid, "capture", `Capturando: ${line.slice(0, 80)}...`, undefined, line);
    });
    this.appendLog(bssid, `[capture] airodump-ng on ${this.iface} ch${realChannel} targeting ${bssid}`);
    capturer.start();
    const capFile = capturer.capPath();
    this.progress(bssid, "capture", "Captura activa, esperando clientes...");

    let captured = false;
    try {
      // Let airodump create its files and enumerate associated clients.
      await sleep(4_000);
      // Policy: end the process on the first deauth round's settle window.
      // If it produced no handshake, one more attempt runs — after that the
      // capture is over (PMKID passive fallback below still applies).
      for (let attempt = 1; attempt <= DEAUTH_MAX_ATTEMPTS && !captured; attempt++) {
        if (this.attackAbort) break;
        this.updateMeta(bssid, { attempts: attempt });
        // Prefer directed deauth at real associated clients (far more
        // effective than broadcast); fall back to the radar snapshot, then
        // to a broadcast burst.
        let clients = [...new Set([...capturer.associatedClients(), ...seedClients])];
        if (clients.length === 0) {
          const c = this.pickClientFor(bssid);
          if (c) clients = [c];
        }
        // No clients anywhere: give the settle window double time.
        const settleMs = clients.length === 0 ? DEAUTH_SETTLE_MS * 2 : DEAUTH_SETTLE_MS;
        this.progress(bssid, "deauth", `Intento ${attempt}/${DEAUTH_MAX_ATTEMPTS}: deauth a ${clients.length} cliente(s)...`,
          clients.length > 0
            ? `aireplay-ng --deauth ${DEAUTH_BURST} -a ${bssid} -c ${clients[0]} -D ${this.iface}`
            : `aireplay-ng --deauth ${DEAUTH_BURST} -a ${bssid} -D ${this.iface} (broadcast)`);
        for (const client of clients) {
          if (this.attackAbort) break;
          await this.fireDeauth(bssid, client, attempt);
        }
        if (!this.attackAbort) await this.fireDeauth(bssid, null, attempt); // broadcast too
        this.progress(bssid, "validate", `Esperando handshake de reconexión...${clients.length === 0 ? " (sin clientes detectados, esperando más tiempo)" : ""}`);
        // Post-capture: hcxpcapngtool conversion (turns EAPOL/PMKID frames into
    // the .hc22000 hash and is the "captured" verdict source).
    this.progress(bssid, "validate", "Convirtiendo captura y buscando handshake...",
      `hcxpcapngtool -o <prefix>.hc22000 <prefix>-01.cap`);
    captured = await this.waitForCapture(bssid, capFile, settleMs);
        if (captured) {
          // One deauth (or its reconnect frames) was enough — end the
          // attack here, no extra attempts.
          this.progress(bssid, "validate", "¡Handshake capturado! Deauth suficiente — cerrando captura");
          break;
        }
        if (attempt < DEAUTH_MAX_ATTEMPTS) {
          this.progress(bssid, "deauth", "Sin handshake todavía — un intento más de deauth...");
        }
      }
    } finally {
      capturer.stop();
      this.captureRunner = null;
    }

    if (this.attackAbort) {
      this.updateMeta(bssid, { status: "cancelled" });
      return;
    }
    if (captured) {
      this.markCaptured(bssid, "deauth", capFile);
      this.progress(bssid, "done", "Handshake WPA2 capturado correctamente", undefined, capFile);
      await this.autoValidate(bssid);
      return;
    }

    // PMKID fallback: if deauth didn't produce a handshake, keep the locked
    // capture running and wait for a passive PMKID frame (WPA3/SAE networks
    // don't do 4-way handshakes but still emit PMKID on client connect).
    this.progress(bssid, "validate", "Deauth no funcionó, intentando PMKID pasivo...",
      "ventana pasiva sobre la captura activa (esperando PMKID de un cliente real conectándose)");
    this.appendLog(bssid, `[pmkid] passive fallback window ${PMKID_PASSIVE_MS / 1000}s`);
    this.updateMeta(bssid, { method: "pmkid" });
    captured = await this.waitForCapture(bssid, capFile, PMKID_PASSIVE_MS);
    if (captured) {
      this.markCaptured(bssid, "pmkid", capFile);
      this.progress(bssid, "done", "PMKID capturado correctamente", undefined, capFile);
      await this.autoValidate(bssid);
      return;
    }

    // Final validation: if hcxpcapngtool found EAPOL/PMKID at any point,
    // the capture is valid even if the timing above missed it.
    const finalCheck = await this.session!.convertCapture(capFile);
    if (finalCheck.hasCapture) {
      this.markCaptured(bssid, "deauth", capFile);
      this.progress(bssid, "done", "Handshake capturado (validación final)", undefined, capFile);
      await this.autoValidate(bssid);
      return;
    }

    this.progress(bssid, "done", "No se pudo capturar handshake ni PMKID");
    this.updateMeta(bssid, {
      status: "failed",
      error: "sin handshake ni PMKID — el objetivo puede ser WPA3/SAE puro o sin clientes",
    });
  }

  // One directed (or broadcast when client=null) deauth burst.
  private async fireDeauth(bssid: string, client: string | null, attempt: number): Promise<void> {
    if (!this.iface) return;
    const runner = new DeauthRunner(this.iface, bssid, client, DEAUTH_BURST, 0);
    this.deauthRunner = runner;
    const tag = client ? `deauth ${attempt} ${client}` : `deauth ${attempt} broadcast`;
    runner.on("log", (line: string) => this.appendLog(bssid, `[${tag}] ${line}`));
    const exited = new Promise<void>((resolve) => runner.on("exit", () => resolve()));
    runner.start();
    await Promise.race([exited, sleep(DEAUTH_BURST * 700 + 2_000)]);
    runner.stop();
    this.deauthRunner = null;
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

  // Post-capture auto-validation (v2): when a lab password is configured
  // (WARDRIVE_LAB_PASSWORD in .env), the capture is checked with aircrack
  // right after being marked captured — "captured" from hcxpcapngtool only
  // proves EAPOL material exists, aircrack proves the handshake is complete
  // and crackable. Verified verdict is surfaced in the UI.
  private async autoValidate(bssid: string): Promise<void> {
    const password = process.env.WARDRIVE_LAB_PASSWORD || "";
    if (!password || !this.session) return;
    const capPath = resolveCapPath(this.session.dir, this.targetFiles(bssid));
    if (!capPath) return;
    this.progress(bssid, "done", "Validando handshake con la contraseña del lab...",
      "aircrack-ng -w - -b " + bssid + " <prefix>-01.cap   (contraseña por stdin)");
    const { promise, cancel } = crackCheck(capPath, password, bssid);
    this.activeValidation.set(bssid, cancel);
    const result = await promise;
    this.activeValidation.delete(bssid);
    this.verified.set(bssid, result);
    this.lastValidatedPassword.set(bssid, result.matched ? password : `${password} (no matchea)`);
    if (result.matched) {
      this.foundPasswords.set(bssid, { password, ssid: this.targetMeta.get(bssid)?.ssid || "" });
      // Persist so the past-sessions browser can show it (eye toggle).
      this.session.setFoundPassword(bssid, password);
    }
    this.appendLog(bssid, `[validate] aircrack verdict=${result.verdict}${result.cancelled ? " (cancelado)" : ""}`);
    if (result.cancelled) {
      this.progress(bssid, "done", "Validación cancelada por el usuario");
      return;
    }
    if (result.matched) {
      this.progress(bssid, "done", "✓ Handshake VALIDADO — contraseña correcta (KEY FOUND)",
        undefined, result.output.slice(-600));
    } else if (result.verdict === "handshake_wrong_password") {
      this.progress(bssid, "done", "Handshake completo pero la contraseña del lab no matchea",
        undefined, result.output.slice(-600));
    } else {
      this.progress(bssid, "done", `Validación aircrack: ${result.verdict}`,
        undefined, result.output.slice(-600));
    }
    this.session.writeTargetInfo(bssid, this.lastValidatedPassword.get(bssid));
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
    const hashFile = base.replace(/\.(pcapng|cap)$/i, ".hc22000");
    if (fs.existsSync(path.join(this.session.dir, hashFile))) {
      this.session.addTargetFile(bssid, hashFile);
    }
    this.session.updateTarget(bssid, { status: "captured", method, finishedAt: Date.now() });
    this.updateMeta(bssid, { status: "captured", method, error: "" });
    this.appendLog(bssid, `[done] handshake captured via ${method}`);
    this.session.writeTargetInfo(bssid, this.lastValidatedPassword.get(bssid));
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

  // ─── Handshake validation (v2 lab workflow) ────────────────────────────
  // The operator knows the lab password; running aircrack-ng with it proves
  // the captured handshake is complete and crackable (a plain "captured"
  // from hcxpcapngtool can be a bare PMKID/half EAPOL — not equivalent).
  // The password is piped to aircrack's stdin (crack.ts) and never stored.
  async validateHandshake(bssidRaw: string, password: string): Promise<{ ok: boolean; error?: string; result?: CrackResult }> {
    const bssid = WardriveService.clean(bssidRaw);
    if (!bssid) return { ok: false, error: "BSSID inválido" };
    const target = this.targetMeta.get(bssid);
    if (!target || target.status !== "captured") {
      return { ok: false, error: "No hay captura para ese objetivo — audítalo primero" };
    }
    if (!this.session) {
      return { ok: false, error: "Sin sesión de wardrive activa" };
    }
    // Demo: no real aircrack — compare against the demo target's (public,
    // lab-only) password. Any other password reports "no matchea".
    if (this.source === "demo") {
      const demoPassword = DEMO_WD_TARGETS.find((t) => t.bssid === bssid)?.demoPassword;
      if (!demoPassword) {
        return {
          ok: true,
          result: {
            verdict: "handshake_wrong_password",
            matched: false,
            eapolPackets: 2,
            handshakeHint: true,
            output: "KEY NOT FOUND (demo)",
          },
        };
      }
      const result: CrackResult = password === demoPassword
        ? {
            verdict: "verified",
            matched: true,
            eapolPackets: 2,
            handshakeHint: true,
            output: `KEY FOUND! [ ${demoPassword} ]`,
          }
        : {
            verdict: "handshake_wrong_password",
            matched: false,
            eapolPackets: 2,
            handshakeHint: true,
            output: "KEY NOT FOUND (demo: la contraseña no matchea)",
          };
      this.verified.set(bssid, result);
      this.lastValidatedPassword.set(bssid, result.matched ? password : `${password} (no matchea)`);
      if (result.matched) {
        this.foundPasswords.set(bssid, { password, ssid: target.ssid });
        this.session.setFoundPassword(bssid, password);
      }
      this.appendLog(bssid, `[validate] verdict=${result.verdict} (demo)`);
      this.session.writeTargetInfo(bssid, this.lastValidatedPassword.get(bssid));
      this.broadcastStatus();
      return { ok: true, result };
    }
    const capPath = resolveCapPath(this.session.dir, this.targetFiles(bssid));
    if (!capPath) {
      return { ok: false, error: "El objetivo capturado no tiene archivo .cap/.pcapng" };
    }
    this.appendLog(bssid, "[validate] aircrack-ng check with operator-provided password");
    const { promise, cancel } = crackCheck(capPath, password, bssid);
    this.activeValidation.set(bssid, cancel);
    const result = await promise;
    this.activeValidation.delete(bssid);
    this.verified.set(bssid, result);
    this.lastValidatedPassword.set(bssid, result.matched ? password : `${password} (no matchea)`);
    if (result.matched) {
      this.foundPasswords.set(bssid, { password, ssid: target.ssid });
      // Persist so the past-sessions browser can show it (eye toggle).
      this.session.setFoundPassword(bssid, password);
    }
    this.appendLog(bssid, `[validate] verdict=${result.verdict}${result.cancelled ? " (cancelado)" : ""}`);
    this.session.writeTargetInfo(bssid, this.lastValidatedPassword.get(bssid));
    this.broadcastStatus();
    return { ok: true, result };
  }

  // The password that cracked this target's handshake (🔑 icon in the UI).
  // Session-scoped, in-memory only; null when none was found.
  getFoundPassword(bssidRaw: string): { ok: boolean; error?: string; password?: string; ssid?: string } {
    const bssid = WardriveService.clean(bssidRaw);
    if (!bssid) return { ok: false, error: "BSSID inválido" };
    const found = this.foundPasswords.get(bssid);
    if (!found) return { ok: false, error: "Sin contraseña registrada para ese objetivo" };
    return { ok: true, password: found.password, ssid: found.ssid };
  }

  // Cancel an in-flight password validation for one target (Cancel button).
  cancelValidation(bssidRaw: string): { ok: boolean } {
    const bssid = WardriveService.clean(bssidRaw);
    const cancel = this.activeValidation.get(bssid);
    if (cancel) {
      cancel();
      return { ok: true };
    }
    return { ok: true };
  }

  // ─── Demo attack simulation (source="demo", no hardware) ────────────────
  // Replays the EXACT same progress pipeline as runTarget() — same steps,
  // same message wording — only with a 3s wait per step and synthetic
  // outcomes: every target ends "captured", and akbal_lab (docs/
  // lab-wireless.md, password deliberately public) also ends validated with
  // its lab password so the UI's 🔑/🏴‍☠️ flow can be exercised.

  // Demo session folders live under the same root with a "demo-" prefix;
  // their simulated .cap/.hc22000 files make the file browser work and get
  // wiped on exit (pruneDemoSessions).
  private pruneDemoSessions(): void {
    const root = path.join(process.env.HOME || "/home/akbal", "wardrive-sessions");
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(root).filter((d) => d.startsWith("demo-"));
    } catch {
      return;
    }
    for (const dir of dirs) {
      try {
        fs.rmSync(path.join(root, dir), { recursive: true, force: true });
        console.log(`[wardrive] pruned demo session ${dir}`);
      } catch {
        // never fatal
      }
    }
  }

  // Simulated capture artifacts: a minimal but REAL pcap file (global pcap
  // header + one synthetic 802.11 data frame + EAPOL-looking bytes) so the
  // hexdump preview and aircrack-based tools don't choke on a zero-byte
  // file. The .hc22000 is just a marker (the demo never runs hashcat).
  private writeDemoCaptureFiles(bssid: string, capPath: string): void {
    try {
      const prefix = capPath.replace(/-01\.cap$/, "");
      // Minimal pcap: 24B file header + 16B per packet header + payload.
      const magic = Buffer.from([0x4d, 0x3c, 0xb2, 0xa1, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00]);
      const frame = Buffer.alloc(26 + 4 + 40); // radiotap + 802.11 hdr + fake EAPOL tail
      const pkt = Buffer.alloc(16);
      pkt.writeUInt32LE(frame.length, 8);
      const cap = Buffer.concat([magic, pkt, frame]);
      fs.writeFileSync(capPath, cap);
      fs.writeFileSync(`${prefix}.hc22000`, `WPA*02*deadbeefdeadbeefdeadbeefdeadbeef*${bssid.replace(/:/g, "").toLowerCase()}*f4f5d81ab05e***\n`);
    } catch {
      // never fatal — the session works without artifacts
    }
  }

  // Full simulated attack cycle against one demo target. Mirrors runTarget
  // step-for-step (scan → lock → capture → deauth → validate → done) with
  // DEMO_STEP_MS between entries.
  private async runTargetDemo(bssid: string, ssid: string, channel: number): Promise<void> {
    if (!this.session) return;
    if (this.attackAbort) {
      this.updateMeta(bssid, { status: "cancelled" });
      return;
    }
    this.updateMeta(bssid, { ssid, channel, status: "running", method: "deauth", error: "" });

    const prefix = path.join(this.session.dir, bssid.replace(/:/g, "").toLowerCase());
    const demoTarget = DEMO_WD_TARGETS.find((t) => t.bssid === bssid);
    const demoPassword = demoTarget?.demoPassword;

    // Step 1: scan
    this.progress(bssid, "scan", `Escaneando ${ssid || bssid} para detectar canal real y clientes...`,
      `airodump-ng --bssid ${bssid} -w ${prefix}-scan --output-format csv [demo-${this.iface || "wlan0demo"}]`);
    await sleep(DEMO_STEP_MS);
    if (this.attackAbort) { this.updateMeta(bssid, { status: "cancelled" }); return; }
    this.progress(bssid, "scan", `Canal real detectado: ${channel} (radar decía ${channel})`);
    this.progress(bssid, "scan", demoTarget && demoTarget.clients > 0
      ? `Clientes detectados: ${demoTarget.clients} (${bssid.replace(/:/g, "").slice(-4)}:demo, ...)`
      : "Sin clientes asociados detectados");

    // Step 2: lock
    this.progress(bssid, "lock", `Fijando adaptador en canal ${channel}...`,
      `iw dev [demo-iface] set channel ${channel}`);
    await sleep(DEMO_STEP_MS);
    if (this.attackAbort) { this.updateMeta(bssid, { status: "cancelled" }); return; }
    this.progress(bssid, "lock", `Canal ${channel} fijado correctamente`);

    // Step 3: capture
    this.progress(bssid, "capture", "Iniciando captura de tráfico...",
      `airodump-ng --bssid ${bssid} -c ${channel} -w ${prefix} [demo-iface]`);
    await sleep(DEMO_STEP_MS);
    if (this.attackAbort) { this.updateMeta(bssid, { status: "cancelled" }); return; }
    this.progress(bssid, "capture", "Captura activa, esperando clientes...");
    await sleep(DEMO_STEP_MS);
    if (this.attackAbort) { this.updateMeta(bssid, { status: "cancelled" }); return; }

    // Step 4: deauth (one attempt in demo — always "succeeds")
    this.progress(bssid, "deauth", `Intento 1/${DEAUTH_MAX_ATTEMPTS}: deauth a 1 cliente(s)...`,
      `aireplay-ng --deauth ${DEAUTH_BURST} -a ${bssid} -c AA:BB:CC:DE:MO:01 -D [demo-iface]`);
    await sleep(DEMO_STEP_MS);
    if (this.attackAbort) { this.updateMeta(bssid, { status: "cancelled" }); return; }
    this.progress(bssid, "deauth", "aireplay-ng: 64 deauths enviados (simulado)");
    this.progress(bssid, "validate", "Esperando handshake de reconexión...");
    await sleep(DEMO_STEP_MS);
    if (this.attackAbort) { this.updateMeta(bssid, { status: "cancelled" }); return; }

    // Step 5: validate — synthetic capture always appears
    this.progress(bssid, "validate", "Convirtiendo captura y buscando handshake...",
      `hcxpcapngtool -o ${prefix}.hc22000 ${prefix}-01.cap`);
    this.writeDemoCaptureFiles(bssid, `${prefix}-01.cap`);
    this.session.addTargetFile(bssid, `${bssid.replace(/:/g, "").toLowerCase()}-01.cap`);
    this.session.addTargetFile(bssid, `${bssid.replace(/:/g, "").toLowerCase()}-01.hc22000`);
    this.session.updateTarget(bssid, { status: "captured", method: "deauth", finishedAt: Date.now() });
    this.markCaptured(bssid, "deauth", `${prefix}-01.cap`);
    this.progress(bssid, "validate", "¡Handshake capturado! Deauth suficiente — cerrando captura");
    this.progress(bssid, "done", "Handshake WPA2 capturado correctamente", undefined, `${prefix}-01.cap`);

    // Demo auto-validation: akbal_lab's password is public (lab, docs/
    // lab-wireless.md) so the pipeline can end in a real-looking KEY FOUND.
    if (demoPassword) {
      await sleep(DEMO_STEP_MS);
      if (this.attackAbort) { this.updateMeta(bssid, { status: "cancelled" }); return; }
      this.progress(bssid, "done", "Validando handshake con la contraseña del lab...",
        "aircrack-ng -w - -b " + bssid + " <prefix>-01.cap   (contraseña por stdin)");
      await sleep(DEMO_STEP_MS);
      if (this.attackAbort) { this.updateMeta(bssid, { status: "cancelled" }); return; }
      const result: CrackResult = {
        verdict: "verified",
        matched: true,
        eapolPackets: 2,
        handshakeHint: true,
        output: `KEY FOUND! [ ${demoPassword} ]\n\nMaster Key     : A9 4E 3C 1B 7F 22 D0 58 9A 61 84 CE B2 05 47 93 \nTransient Key  : (demo)\nEAPOL HMAC     : 6E 1B 48 92 D3 7A 05 C4 F1 88 2A 9E 63 30 B7 55`,
      };
      this.verified.set(bssid, result);
      this.lastValidatedPassword.set(bssid, demoPassword);
      this.foundPasswords.set(bssid, { password: demoPassword, ssid });
      this.session.setFoundPassword(bssid, demoPassword);
      this.appendLog(bssid, `[validate] aircrack verdict=verified (demo)`);
      this.progress(bssid, "done", "✓ Handshake VALIDADO — contraseña correcta (KEY FOUND)", undefined, result.output);
      this.session.updateTarget(bssid, { verified: true });
      this.session.writeTargetInfo(bssid, demoPassword);
    }
  }

  // Fake rockyou run: ticks progress every DEMO_DICT_TICK_MS until the
  // wordlist is exhausted; akbal_lab's password is IN the demo wordlist
  // story, so the crack "finds" it partway through. `capPathOwnerDir` (past
  // demo sessions) receives the recovered password via the same surgical
  // patch the real past-session crack uses.
  private startDictDemo(bssid: string, capPathOwnerDir?: string): { ok: boolean; error?: string } {
    const demoTarget = DEMO_WD_TARGETS.find((t) => t.bssid === bssid);
    const demoPassword = demoTarget?.demoPassword;
    const hitAt = demoPassword
      ? Math.max(DEMO_DICT_STEPS - 8, 1) // found near the end, like a real crack
      : DEMO_DICT_STEPS + 1; // never
    this.demoDict = {
      bssid,
      timer: null,
      tried: 0,
      running: true,
      result: null,
    };
    let step = 0;
    this.demoDict.timer = setInterval(() => {
      step++;
      const dict = this.demoDict;
      if (!dict) return;
      dict.tried = Math.min(DEMO_DICT_TOTAL, Math.round(step * DEMO_DICT_KEYS_PER_TICK));
      if (step >= hitAt) {
        // KEY FOUND: stop the fake aircrack with a match.
        if (dict.timer) clearInterval(dict.timer);
        dict.running = false;
        dict.result = {
          verdict: "verified",
          matched: true,
          eapolPackets: 2,
          handshakeHint: true,
          output: `KEY FOUND! [ ${demoPassword} ]`,
        };
        this.verified.set(bssid, dict.result);
        this.foundPasswords.set(bssid, { password: demoPassword!, ssid: demoTarget!.ssid });
        // Past demo session: persist into the session folder (the folder
        // survives as long as the demo wardrive session is open — it's
        // pruned on exit). Live session: the normal path.
        if (capPathOwnerDir) {
          this.persistPastSessionPassword(capPathOwnerDir, bssid, demoPassword!);
        }
        this.session?.setFoundPassword(bssid, demoPassword!);
        this.session?.updateTarget(bssid, { verified: true });
        this.appendLog(bssid, "[dict] KEY FOUND — handshake validado con diccionario (demo)");
        this.broadcastStatus();
      } else if (step >= DEMO_DICT_STEPS) {
        if (dict.timer) clearInterval(dict.timer);
        dict.running = false;
        dict.result = {
          verdict: "handshake_wrong_password",
          matched: false,
          eapolPackets: 2,
          handshakeHint: true,
          output: "KEY NOT FOUND (demo)",
        };
        this.appendLog(bssid, `[dict] terminado: handshake_wrong_password (${dict.tried} contraseñas) (demo)`);
        this.broadcastStatus();
      }
    }, DEMO_DICT_TICK_MS);
    this.appendLog(bssid, `[dict] aircrack started with ~/wordlists/rockyou.txt (demo)`);
    return { ok: true };
  }

  private stopDictDemo(): void {
    if (this.demoDict?.timer) clearInterval(this.demoDict.timer);
    if (this.demoDict) {
      this.demoDict.running = false;
      this.demoDict.result = {
        verdict: "error",
        matched: false,
        eapolPackets: 0,
        handshakeHint: false,
        output: `cancelado tras ${this.demoDict.tried} contraseñas (demo)`,
      };
    }
  }

  private stopRunners(): void {
    this.captureRunner?.stop();
    this.captureRunner = null;
    this.deauthRunner?.stop();
    this.deauthRunner = null;
    for (const [, runner] of this.deauthRunnerByMac) {
      runner.stop();
    }
    this.deauthRunnerByMac.clear();
    // A dictionary crack must not outlive the session/exit — aircrack on a
    // deleted .cap is wasted CPU. Same for in-flight password validations.
    for (const [, cancel] of this.activeValidation) cancel();
    this.activeValidation.clear();
    this.dictCrack?.stop();
    this.dictCrack = null;
    this.dictCrackBssid = null;
    // Demo simulation state dies with the runners too.
    this.stopDictDemo();
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
import {
  getWifiRadarSnapshot,
  stopWifiRadarService,
  startWifiRadarService,
  setWifiRadarMode,
} from "../wifiradar/service";