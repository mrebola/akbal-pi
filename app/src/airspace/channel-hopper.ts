import { setChannel } from "./monitor-control";

const HOP_INTERVAL_MS = 400;

// Cycles sequentially through whatever 2.4GHz channels the driver reports
// as available (see getAvailable24GhzChannels — already regulatory-domain
// filtered). At 400ms/hop, a 13-channel sweep completes roughly every 5.2s,
// which is enough to keep beacon intervals (~100ms, so 3+ per dwell) and
// catch most APs within a couple of sweeps.
export class ChannelHopper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private index = 0;
  private currentChannel = 0;

  constructor(
    private iface: string,
    private channels: number[],
  ) {}

  start(): void {
    if (this.timer || this.channels.length === 0) return;
    this.hop();
    this.timer = setInterval(() => this.hop(), HOP_INTERVAL_MS);
  }

  private hop(): void {
    const channel = this.channels[this.index % this.channels.length];
    this.index += 1;
    this.currentChannel = channel;
    setChannel(this.iface, channel).catch((err) => {
      console.warn(`[airspace] setChannel(${channel}) failed:`, err?.message || err);
    });
  }

  getCurrentChannel(): number {
    return this.currentChannel;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
