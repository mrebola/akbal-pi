import { EventEmitter } from "events";
import { detectHackRf, AdsbReceiver } from "./hackrf-receiver";
import { AircraftTracker } from "./aircraft-tracker";
import { DemoGenerator } from "./demo-mode";
import { AircraftRadarMode, AircraftRadarSnapshot } from "./types";
import { getGpsStatus } from "../../utils/gps";

const SWEEP_INTERVAL_MS = 5_000;
const RETRY_INTERVAL_MS = 15_000;

// Orchestrates Aircraft Radar end to end: try the real HackRF+dump1090
// pipeline (hackrf_info -> hackrf_transfer|dump1090 -> SBS feed -> tracker),
// and if any step fails — no HackRF, dump1090 missing, process dies — fall
// back to DemoGenerator instead of crashing or leaving the feature dark.
// Same shape as wifiradar/service.ts's WifiRadarService; see that file's
// comments for the reasoning behind each piece (kept in sync deliberately).
export class AircraftRadarService extends EventEmitter {
  private tracker = new AircraftTracker();
  private receiver: AdsbReceiver | null = null;
  private demo: DemoGenerator | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private mode: AircraftRadarMode = "starting";
  private hardware: string | null = null;
  private lastError: string | undefined;
  private started = false;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private retrying = false;
  private requestedMode: "live" | "demo" = "live";

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.sweepTimer = setInterval(() => {
      this.tracker.sweep();
      void this.refreshGpsPosition();
    }, SWEEP_INTERVAL_MS);

    try {
      await this.tryRealCapture();
    } catch (err: any) {
      console.warn("[aircraft-radar] Real capture unavailable, using DEMO MODE:", err?.message || err);
      this.fallbackToDemo(err?.message || String(err));
      this.startRetryLoop();
    }
  }

  // Web-admin toggle: force demo (synthetic feed, no radio) or go back to
  // live capture. Returns the mode the service is in after settling.
  async setMode(requested: "demo" | "live"): Promise<AircraftRadarMode> {
    if (requested === this.requestedMode) {
      if (requested === "live" && this.mode !== "live") {
        await this.switchToLive();
      }
      return this.mode;
    }
    this.requestedMode = requested;
    if (requested === "demo") {
      this.fallbackToDemo("cambiado a demo manualmente");
      if (this.retryTimer) {
        clearInterval(this.retryTimer);
        this.retryTimer = null;
      }
    } else {
      await this.switchToLive();
    }
    return this.mode;
  }

  private async switchToLive(): Promise<void> {
    try {
      this.tracker.reset();
      await this.tryRealCapture();
      if (this.retryTimer) {
        clearInterval(this.retryTimer);
        this.retryTimer = null;
      }
    } catch (err: any) {
      const message = err?.message || String(err);
      console.warn("[aircraft-radar] live requested but unavailable, staying in demo:", message);
      this.fallbackToDemo(message);
      this.startRetryLoop();
    }
  }

  // Polled on the same cadence as the sweep timer (not per ADS-B message —
  // see aircraft-tracker.ts's updatePosition comment for why). Errors are
  // swallowed: no GPS fix just means distance/bearing stay null, same as
  // the web GPS page's own "sin fix" state.
  private async refreshGpsPosition(): Promise<void> {
    try {
      const status = await getGpsStatus();
      const hasFix = status.hasFix && status.latitude !== null && status.longitude !== null;
      this.tracker.updatePosition(hasFix ? status.latitude : null, hasFix ? status.longitude : null);
    } catch {
      this.tracker.updatePosition(null, null);
    }
  }

  private startRetryLoop(): void {
    if (this.retryTimer || this.requestedMode === "demo") return;
    this.retryTimer = setInterval(() => {
      if (this.mode === "live" || this.retrying) return;
      this.retrying = true;
      void this.tryRealCapture()
        .then(() => {
          if (this.retryTimer) clearInterval(this.retryTimer);
          this.retryTimer = null;
          this.tracker.reset();
        })
        .catch(() => {})
        .finally(() => {
          this.retrying = false;
        });
    }, RETRY_INTERVAL_MS);
  }

  private async tryRealCapture(): Promise<void> {
    const info = await detectHackRf();
    if (!info.present) {
      throw new Error("No hay HackRF conectado por USB");
    }
    this.hardware = info.boardId ? `${info.boardId}${info.serial ? ` (${info.serial.slice(-8)})` : ""}` : "HackRF";

    this.tracker.reset();

    this.receiver = new AdsbReceiver();
    this.receiver.on("message", (msg) => this.tracker.ingest(msg));
    this.receiver.on("error", (err) => {
      console.warn("[aircraft-radar] receiver process error, falling back to demo:", err?.message || err);
      this.fallbackToDemo(String(err?.message || err));
      this.startRetryLoop();
    });
    this.receiver.on("exit", ({ code, signal }) => {
      if (this.mode === "live") {
        console.warn(`[aircraft-radar] receiver exited unexpectedly (code=${code} signal=${signal}), falling back to demo`);
        this.fallbackToDemo("hackrf_transfer/dump1090 terminó inesperadamente");
        this.startRetryLoop();
      }
    });
    this.receiver.start(parseInt(process.env.ADSB_HACKRF_GAIN || "40", 10));

    this.mode = "live";
    this.lastError = undefined;
    this.demo?.stop();
    this.demo = null;
    console.log(`[aircraft-radar] Live capture started (${this.hardware})`);
  }

  private fallbackToDemo(reason: string): void {
    this.lastError = reason;
    this.receiver?.stop();
    this.receiver = null;
    this.mode = "demo";
    this.tracker.reset(); // synthetic data must not mix with stale real state
    if (!this.demo) {
      this.demo = new DemoGenerator(this.tracker);
      this.demo.start();
    }
  }

  getSnapshot(): AircraftRadarSnapshot {
    const snapshot = this.tracker.getSnapshot(this.mode, this.mode === "demo", this.hardware);
    if (this.mode === "error" || (this.mode !== "live" && this.mode !== "demo")) {
      snapshot.error = this.lastError;
    }
    return snapshot;
  }

  getAircraft(icao: string) {
    return this.tracker.getByIcao(icao);
  }

  getMode(): AircraftRadarMode {
    return this.mode;
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.demo?.stop();
    this.demo = null;
    this.receiver?.stop();
    this.receiver = null;
    this.started = false;
  }

  getRequestedMode(): "live" | "demo" {
    return this.requestedMode;
  }
}

// Single shared instance — one HackRF, one process reading it. Started once
// from index.ts, independent of whether the web admin server is enabled so
// the physical LCD menu screen (chat-flow/aircraft-radar-mode.ts) works
// either way, same rationale as wifiradar/service.ts's shared instance.
const sharedAircraftRadarService = new AircraftRadarService();

export function startAircraftRadarService(): void {
  void sharedAircraftRadarService.start();
}

export function stopAircraftRadarService(): Promise<void> {
  return sharedAircraftRadarService.stop();
}

export function getAircraftRadarSnapshot(): AircraftRadarSnapshot {
  return sharedAircraftRadarService.getSnapshot();
}

export function getAircraftByIcao(icao: string) {
  return sharedAircraftRadarService.getAircraft(icao);
}

export function getAircraftRadarMode(): AircraftRadarMode {
  return sharedAircraftRadarService.getMode();
}

export async function setAircraftRadarMode(requested: "demo" | "live"): Promise<AircraftRadarMode> {
  return sharedAircraftRadarService.setMode(requested);
}

export function getAircraftRadarRequestedMode(): "live" | "demo" {
  return sharedAircraftRadarService.getRequestedMode();
}
