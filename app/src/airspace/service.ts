import { EventEmitter } from "events";
import { detectAr9271 } from "./ar9271";
import { enterMonitorMode, exitMonitorMode, getAvailable24GhzChannels } from "./monitor-control";
import { Ar9271Capture } from "./capture";
import { ChannelHopper } from "./channel-hopper";
import { Aggregator } from "./aggregator";
import { DemoGenerator } from "./demo-mode";
import { AirspaceMode, AirspaceSnapshot } from "./types";

const SWEEP_INTERVAL_MS = 5_000;

// Orchestrates AIRSPACE end to end: try the real AR9271 pipeline
// (detect -> monitor mode -> channel hop -> tshark capture -> aggregator),
// and if any step fails — no dongle, monitor mode rejected, tshark missing
// — fall back to DemoGenerator instead of crashing or leaving the feature
// dark. Both paths feed the same Aggregator, so everything downstream
// (snapshots, events, the frontend) is identical either way except for the
// `demo: true` flag.
export class AirspaceService extends EventEmitter {
  private aggregator = new Aggregator();
  private capture: Ar9271Capture | null = null;
  private hopper: ChannelHopper | null = null;
  private demo: DemoGenerator | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private monitorIface: string | null = null;
  private mode: AirspaceMode = "starting";
  private hardware: string | null = null;
  private lastError: string | undefined;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.sweepTimer = setInterval(() => this.aggregator.sweep(), SWEEP_INTERVAL_MS);

    try {
      const info = await detectAr9271();
      if (!info.present || !info.iface || !info.phy) {
        throw new Error("AR9271 no detectada (lsusb) o sin interfaz de red asociada");
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
        console.warn("[airspace] capture process error, falling back to demo:", err?.message || err);
        this.fallbackToDemo(String(err?.message || err));
      });
      this.capture.on("exit", ({ code, signal }) => {
        if (this.mode === "live") {
          console.warn(`[airspace] tshark exited unexpectedly (code=${code} signal=${signal}), falling back to demo`);
          this.fallbackToDemo("tshark terminó inesperadamente");
        }
      });
      this.capture.start(info.iface);

      this.hopper = new ChannelHopper(info.iface, channels);
      this.hopper.start();

      this.mode = "live";
      console.log(`[airspace] Live capture started on ${info.iface} (${info.phy}), ${channels.length} channels`);
    } catch (err: any) {
      console.warn("[airspace] Real capture unavailable, using DEMO MODE:", err?.message || err);
      this.fallbackToDemo(err?.message || String(err));
    }
  }

  private fallbackToDemo(reason: string): void {
    this.lastError = reason;
    void this.teardownRealCapture();
    if (!this.demo) {
      this.demo = new DemoGenerator(this.aggregator);
      this.demo.start();
    }
    this.mode = "demo";
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
    this.capture?.removeAllListeners();
    this.capture?.stop();
    this.capture = null;
    if (this.monitorIface) {
      const iface = this.monitorIface;
      this.monitorIface = null;
      await exitMonitorMode(iface).catch((err) =>
        console.warn(`[airspace] failed to restore ${iface} to managed mode:`, err?.message || err),
      );
    }
  }

  getSnapshot(revealFullMac = false): AirspaceSnapshot {
    const currentChannel = this.hopper?.getCurrentChannel() || 0;
    const snapshot = this.aggregator.getSnapshot(this.mode, this.mode === "demo", this.hardware, currentChannel, revealFullMac);
    if (this.mode === "error" || (this.mode !== "live" && this.mode !== "demo")) {
      snapshot.error = this.lastError;
    }
    return snapshot;
  }

  getMode(): AirspaceMode {
    return this.mode;
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.demo?.stop();
    this.demo = null;
    await this.teardownRealCapture();
    this.started = false;
  }
}
