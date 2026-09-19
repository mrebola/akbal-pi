import {
  AccessPoint,
  Device,
  AirspaceEvent,
  EventType,
  EventSeverity,
  RawFrameEvent,
  AirspaceSnapshot,
  ChannelActivity,
  AirspaceMode,
} from "./types";
import { anonymizeMac, hashMac } from "./privacy";
import { lookupVendor } from "./oui";

const AP_LOST_TIMEOUT_MS = 60_000; // no beacon/probe-resp in 60s -> considered lost
const AP_PRUNE_MS = 5 * 60_000; // fully drop from memory 5 min after last seen
const DEVICE_PRUNE_MS = 5 * 60_000;
const MAX_EVENTS = 200;
const DEAUTH_WINDOW_MS = 5_000;
const DEAUTH_BURST_THRESHOLD = 10;
const DEAUTH_EVENT_COOLDOWN_MS = 30_000;
const CHANNEL_ACTIVITY_WINDOW_MS = 10_000;
const FRAME_RATE_WINDOW_MS = 60_000;

type InternalAp = AccessPoint & {
  deauthTimestamps: number[];
  lastDeauthEventAt: number;
  lostReported: boolean;
};

// Owns all in-memory AIRSPACE state — the only thing that ever grows or
// shrinks this state is ingest()/sweep(), fed identically by capture.ts
// (real frames) or demo-mode.ts (synthetic ones). No disk I/O anywhere in
// this file: nothing here is ever more durable than the process's memory,
// and sweep() actively prunes it so memory stays flat over a long uptime.
export class Aggregator {
  private aps = new Map<string, InternalAp>(); // key: full bssid
  private devices = new Map<string, Device>(); // key: full mac
  private apClients = new Map<string, Set<string>>(); // bssid -> client macs
  private events: AirspaceEvent[] = [];
  private nextEventId = 1;
  private frameTimestamps: number[] = [];
  private channelFrameCounts = new Map<number, number[]>();
  private ssidToFirstBssid = new Map<string, string>();

  private pushEvent(
    type: EventType,
    severity: EventSeverity,
    source: string,
    description: string,
  ): void {
    this.events.push({ id: this.nextEventId++, type, severity, timestamp: Date.now(), source, description });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  private recordChannelFrame(channel: number, timestamp: number): void {
    const arr = this.channelFrameCounts.get(channel) || [];
    arr.push(timestamp);
    const cutoff = timestamp - CHANNEL_ACTIVITY_WINDOW_MS;
    while (arr.length && arr[0] < cutoff) arr.shift();
    this.channelFrameCounts.set(channel, arr);
  }

  ingest(frame: RawFrameEvent): void {
    this.frameTimestamps.push(frame.timestamp);
    const cutoff = frame.timestamp - FRAME_RATE_WINDOW_MS;
    while (this.frameTimestamps.length && this.frameTimestamps[0] < cutoff) this.frameTimestamps.shift();

    if (frame.kind === "beacon" || frame.kind === "probe_resp") {
      this.recordChannelFrame(frame.channel, frame.timestamp);
      this.ingestApFrame(frame);
    } else if (frame.kind === "data") {
      this.ingestClientFrame(frame);
    } else if (frame.kind === "deauth") {
      this.ingestDeauth(frame);
    }
  }

  private ingestApFrame(
    frame: Extract<RawFrameEvent, { kind: "beacon" }> | Extract<RawFrameEvent, { kind: "probe_resp" }>,
  ): void {
    const existing = this.aps.get(frame.bssid);
    if (!existing) {
      const ap: InternalAp = {
        id: hashMac(frame.bssid),
        bssid: anonymizeMac(frame.bssid),
        bssidFull: frame.bssid,
        ssid: frame.ssid,
        channel: frame.channel,
        rssi: frame.rssi,
        security: frame.security,
        vendor: lookupVendor(frame.bssid),
        firstSeen: frame.timestamp,
        lastSeen: frame.timestamp,
        frames: 1,
        clients: 0,
        deauthTimestamps: [],
        lastDeauthEventAt: 0,
        lostReported: false,
      };
      this.aps.set(frame.bssid, ap);
      this.pushEvent("NEW_AP", "info", ap.bssid, `Nuevo AP "${ap.ssid}" en canal ${ap.channel}`);
      if (frame.security === "OPEN") {
        this.pushEvent("OPEN_NETWORK", "warning", ap.bssid, `Red abierta "${ap.ssid}"`);
      } else if (frame.security === "WEP") {
        this.pushEvent("WEP", "warning", ap.bssid, `Red WEP "${ap.ssid}" (cifrado obsoleto)`);
      }
      if (frame.ssid && frame.ssid !== "(oculta)") {
        const priorBssid = this.ssidToFirstBssid.get(frame.ssid);
        if (priorBssid && priorBssid !== frame.bssid) {
          this.pushEvent(
            "DUPLICATE_SSID",
            "warning",
            ap.bssid,
            `SSID "${frame.ssid}" visto en más de un BSSID`,
          );
        } else if (!priorBssid) {
          this.ssidToFirstBssid.set(frame.ssid, frame.bssid);
        }
      }
      return;
    }
    if (existing.security !== frame.security) {
      this.pushEvent(
        "SECURITY_CHANGE",
        "warning",
        existing.bssid,
        `"${existing.ssid}" cambió de ${existing.security} a ${frame.security}`,
      );
      existing.security = frame.security;
    }
    existing.rssi = frame.rssi;
    existing.channel = frame.channel;
    existing.lastSeen = frame.timestamp;
    existing.frames += 1;
    existing.lostReported = false;
    if (frame.ssid && frame.ssid !== "(oculta)" && existing.ssid === "(oculta)") {
      existing.ssid = frame.ssid;
    }
  }

  private ingestClientFrame(frame: Extract<RawFrameEvent, { kind: "data" }>): void {
    const ap = this.aps.get(frame.bssid);
    let clientSet = this.apClients.get(frame.bssid);
    if (!clientSet) {
      clientSet = new Set();
      this.apClients.set(frame.bssid, clientSet);
    }
    clientSet.add(frame.client);
    if (ap) ap.clients = clientSet.size;

    const existing = this.devices.get(frame.client);
    if (!existing) {
      const device: Device = {
        id: hashMac(frame.client),
        mac: anonymizeMac(frame.client),
        macFull: frame.client,
        vendor: lookupVendor(frame.client),
        rssi: frame.rssi,
        associatedBssid: ap ? ap.bssid : null,
        firstSeen: frame.timestamp,
        lastSeen: frame.timestamp,
        frames: 1,
      };
      this.devices.set(frame.client, device);
      this.pushEvent(
        "NEW_DEVICE",
        "info",
        device.mac,
        `Nuevo dispositivo cerca de ${ap ? ap.ssid : "AP desconocido"}`,
      );
      return;
    }
    existing.rssi = frame.rssi;
    existing.lastSeen = frame.timestamp;
    existing.frames += 1;
    if (ap) existing.associatedBssid = ap.bssid;
  }

  private ingestDeauth(frame: Extract<RawFrameEvent, { kind: "deauth" }>): void {
    const ap = this.aps.get(frame.bssid);
    if (!ap) return;
    ap.deauthTimestamps.push(frame.timestamp);
    const cutoff = frame.timestamp - DEAUTH_WINDOW_MS;
    while (ap.deauthTimestamps.length && ap.deauthTimestamps[0] < cutoff) ap.deauthTimestamps.shift();
    if (
      ap.deauthTimestamps.length >= DEAUTH_BURST_THRESHOLD &&
      frame.timestamp - ap.lastDeauthEventAt > DEAUTH_EVENT_COOLDOWN_MS
    ) {
      ap.lastDeauthEventAt = frame.timestamp;
      this.pushEvent(
        "DEAUTH_BURST",
        "alert",
        ap.bssid,
        `Ráfaga de deauth en "${ap.ssid}" — posible interferencia o ataque cercano`,
      );
    }
  }

  // Called periodically (see service.ts) to catch APs that stopped
  // beaconing and prune old entries so memory stays flat over a long
  // uptime instead of growing forever.
  sweep(): void {
    const now = Date.now();
    for (const [bssid, ap] of this.aps) {
      const age = now - ap.lastSeen;
      if (age > AP_LOST_TIMEOUT_MS && !ap.lostReported) {
        ap.lostReported = true;
        this.pushEvent("AP_LOST", "info", ap.bssid, `AP "${ap.ssid}" ya no responde`);
      }
      if (age > AP_PRUNE_MS) {
        this.aps.delete(bssid);
        this.apClients.delete(bssid);
      }
    }
    for (const [mac, device] of this.devices) {
      if (now - device.lastSeen > DEVICE_PRUNE_MS) {
        this.devices.delete(mac);
      }
    }
  }

  getSnapshot(
    mode: AirspaceMode,
    demo: boolean,
    hardware: string | null,
    currentChannel: number,
    revealFullMac: boolean,
  ): AirspaceSnapshot {
    const now = Date.now();
    const framesPerMinute = this.frameTimestamps.filter((t) => t > now - FRAME_RATE_WINDOW_MS).length;
    const channelActivity: ChannelActivity[] = [...this.channelFrameCounts.entries()]
      .map(([channel, timestamps]) => ({
        channel,
        frames: timestamps.filter((t) => t > now - CHANNEL_ACTIVITY_WINDOW_MS).length,
      }))
      .filter((entry) => entry.frames > 0)
      .sort((a, b) => a.channel - b.channel);

    const toPublicAp = (ap: InternalAp): AccessPoint => ({
      id: ap.id,
      bssid: ap.bssid,
      bssidFull: revealFullMac ? ap.bssidFull : ap.bssid,
      ssid: ap.ssid,
      channel: ap.channel,
      rssi: ap.rssi,
      security: ap.security,
      vendor: ap.vendor,
      firstSeen: ap.firstSeen,
      lastSeen: ap.lastSeen,
      frames: ap.frames,
      clients: ap.clients,
    });
    const toPublicDevice = (d: Device): Device => ({
      ...d,
      macFull: revealFullMac ? d.macFull : d.mac,
    });

    return {
      mode,
      demo,
      hardware,
      currentChannel,
      framesPerMinute,
      accessPoints: [...this.aps.values()].map(toPublicAp),
      devices: [...this.devices.values()].map(toPublicDevice),
      events: this.events.slice(-50),
      channelActivity,
    };
  }
}
