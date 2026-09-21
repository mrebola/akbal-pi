import { EventEmitter } from "events";
import { detectMonitorAdapter } from "./adapter";
import { enterMonitorMode, exitMonitorMode, getAvailable24GhzChannels } from "./monitor-control";
import { Ar9271Capture } from "./capture";
import { ChannelHopper } from "./channel-hopper";
import { Aggregator } from "./aggregator";
import { DemoGenerator } from "./demo-mode";
import { WifiRadarMode, WifiRadarSnapshot } from "./types";

const SWEEP_INTERVAL_MS = 5_000;
const RETRY_INTERVAL_MS = 15_000;

// Orchestrates WIFIRADAR end to end: try the real AR9271 pipeline
// (detect -> monitor mode -> channel hop -> tshark capture -> aggregator),
// and if any step fails — no dongle, monitor mode rejected, tshark missing
// — fall back to DemoGenerator instead of crashing or leaving the feature
// dark. Both paths feed the same Aggregator, so everything downstream
// (snapshots, events, the frontend) is identical either way except for the
// `demo: true` flag.
export class WifiRadarService extends EventEmitter {
  private aggregator = new Aggregator();
  private capture: Ar9271Capture | null = null;
  private hopper: ChannelHopper | null = null;
  private demo: DemoGenerator | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private monitorIface: string | null = null;
  private mode: WifiRadarMode = "starting";
  private hardware: string | null = null;
  private lastError: string | undefined;
  private started = false;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private retrying = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.sweepTimer = setInterval(() => this.aggregator.sweep(), SWEEP_INTERVAL_MS);

    // One-shot: if the dongle is missing (unplugged, or wardriving still
    // holding it) this falls back to demo and used to stay there forever —
    // plugging the adapter back in never brought real capture back without a
    // full service restart. The retry timer below recovers it automatically.
    try {
      await this.tryRealCapture();
    } catch (err: any) {
      console.warn("[wifiradar] Real capture unavailable, using DEMO MODE:", err?.message || err);
      this.fallbackToDemo(err?.message || String(err));
      this.startRetryLoop();
    }
  }

  private startRetryLoop(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      if (this.mode === "live" || this.retrying) return;
      this.retrying = true;
      void this.tryRealCapture()
        .then(() => {
          // Live capture is back: purge everything the demo generator
          // synthesized so the snapshot only shows real networks again.
          if (this.retryTimer) clearInterval(this.retryTimer);
          this.retryTimer = null;
          this.aggregator.reset();
        })
        .catch(() => {})
        .finally(() => {
          this.retrying = false;
        });
    }, RETRY_INTERVAL_MS);
  }

  private async tryRealCapture(): Promise<void> {
    const info = await detectMonitorAdapter();
    if (!info.present) {
      throw new Error("No hay adaptador WiFi USB conectado");
    }
    if (!info.monitorSupported || !info.iface || !info.phy) {
      throw new Error(`El adaptador ${info.description || "USB"} no es compatible con modo monitor`);
    }
    this.hardware = info.description;
    const channels = await getAvailable24GhzChannels(info.phy);
    if (channels.length === 0) {
      throw new Error("El driver no reportó canales de 2.4GHz disponibles");
    }
    await enterMonitorMode(info.iface);
    this.monitorIface = info.iface;

    this.capture = new Ar9271Capture();
    this.capture.on("frame", (frame) => this.aggregator.ingest(frame));
    this.capture.on("error", (err) => {
      console.warn("[wifiradar] capture process error, falling back to demo:", err?.message || err);
      this.fallbackToDemo(String(err?.message || err));
      this.startRetryLoop();
    });
    this.capture.on("exit", ({ code, signal }) => {
      if (this.mode === "live") {
        console.warn(`[wifiradar] tshark exited unexpectedly (code=${code} signal=${signal}), falling back to demo`);
        this.fallbackToDemo("tshark terminó inesperadamente");
        this.startRetryLoop();
      }
    });
    this.capture.start(info.iface);

    this.hopper = new ChannelHopper(info.iface, channels);
    this.hopper.start();

    this.mode = "live";
    this.lastError = undefined;
    this.demo?.stop();
    this.demo = null;
    console.log(`[wifiradar] Live capture started on ${info.iface} (${info.phy}), ${channels.length} channels`);
  }

  private fallbackToDemo(reason: string): void {
    this.lastError = reason;
    void this.teardownRealCapture();
    this.mode = "demo";
    if (!this.demo) {
      this.demo = new DemoGenerator(this.aggregator);
      this.demo.start();
    }
  }

  // Async and awaited by stop() (shutdown path) so the process doesn't
  // exit mid-flight through exitMonitorMode's three sequential `sudo`
  // calls — a fire-and-forget .catch() here isn't enough: Node exiting
  // abandons whichever step in that sequence hadn't started yet, which is
  // exactly what left wlan1 stuck in monitor mode in testing before this
  // was awaited. fallbackToDemo() (not a shutdown path, nothing waiting on
  // it) is fine calling this without awaiting the result.
  private async teardownRealCapture(): Promise<void> {
    this.hopper?.stop();
    this.hopper = null;
    // NOT removeAllListeners() before stop(): killing the process can
    // still emit an "error" event on it afterward (e.g. EPIPE from its
    // now-dead stdout), which capture.ts forwards as "error" on this
    // EventEmitter — and Node throws an *uncaught* exception if "error"
    // fires with zero listeners. Confirmed the hard way: this crashed the
    // whole app during shutdown. capture.stop() itself sets running=false
    // first, and capture.ts's own handlers already check that flag before
    // forwarding anything post-stop — no need to strip listeners here too.
    this.capture?.stop();
    this.capture = null;
    if (this.monitorIface) {
      const iface = this.monitorIface;
      this.monitorIface = null;
      await exitMonitorMode(iface).catch((err) =>
        console.warn(`[wifiradar] failed to restore ${iface} to managed mode:`, err?.message || err),
      );
    }
  }

  getSnapshot(revealFullMac = false): WifiRadarSnapshot {
    const currentChannel = this.hopper?.getCurrentChannel() || 0;
    const snapshot = this.aggregator.getSnapshot(this.mode, this.mode === "demo", this.hardware, currentChannel, revealFullMac);
    if (this.mode === "error" || (this.mode !== "live" && this.mode !== "demo")) {
      snapshot.error = this.lastError;
    }
    return snapshot;
  }

  getMode(): WifiRadarMode {
    return this.mode;
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    // Wardrive calls stopWifiRadarService() to take the dongle; a live retry
    // left running here would re-grab the adapter mid-session and fight
    // wardrive's own capture for it.
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.demo?.stop();
    this.demo = null;
    await this.teardownRealCapture();
    this.started = false;
  }
}

// Single shared instance — the AR9271 can only be captured by one thing at
// a time, so the web WIFIRADAR page (web-admin-server.ts) and the physical
// device's own "WiFi Radar" menu screen (chat-flow/wifi-radar-mode.ts) both
// read from this same running capture instead of each starting their own
// (which would fight over the interface). Started once from index.ts,
// independent of whether the web admin server is enabled — the physical
// menu should work either way.
const sharedWifiRadarService = new WifiRadarService();

export function startWifiRadarService(): void {
  void sharedWifiRadarService.start();
}

export function stopWifiRadarService(): Promise<void> {
  return sharedWifiRadarService.stop();
}

export function getWifiRadarSnapshot(revealFullMac = false): WifiRadarSnapshot {
  return sharedWifiRadarService.getSnapshot(revealFullMac);
}

export function getWifiRadarMode(): WifiRadarMode {
  return sharedWifiRadarService.getMode();
}
