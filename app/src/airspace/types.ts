// Shared shapes for the AIRSPACE feature — passive 802.11 visualization.
// capture.ts (real AR9271 packets) and demo-mode.ts (synthetic data) both
// produce RawFrameEvent, so aggregator.ts never has to know which one is
// feeding it. Everything downstream (WebSocket payloads, the Three.js
// frontend) is built from AccessPoint/Device/AirspaceEvent below.

export type SecurityKind = "OPEN" | "WEP" | "WPA" | "WPA2/3" | "UNKNOWN";

export type AccessPoint = {
  id: string; // stable one-way hash of the real BSSID — safe to use as a
  // frontend object-identity key even when bssid below is anonymized down
  // to just a vendor prefix, which by itself can collide between two real
  // APs from the same vendor.
  bssid: string; // already anonymized (AA:BB:CC:••:••:••) unless revealMac is set
  bssidFull: string; // real MAC, only sent to clients that asked for full MACs
  ssid: string;
  channel: number;
  rssi: number; // most recent reading, dBm
  security: SecurityKind;
  vendor: string;
  firstSeen: number; // epoch ms
  lastSeen: number;
  frames: number;
  clients: number; // count of distinct client MACs seen talking to this BSSID
};

export type Device = {
  id: string; // same rationale as AccessPoint.id, hashed from the real MAC
  mac: string; // anonymized
  macFull: string;
  vendor: string;
  rssi: number;
  associatedBssid: string | null;
  firstSeen: number;
  lastSeen: number;
  frames: number;
};

export type EventType =
  | "NEW_AP"
  | "NEW_DEVICE"
  | "OPEN_NETWORK"
  | "WEP"
  | "DUPLICATE_SSID"
  | "SECURITY_CHANGE"
  | "DEAUTH_BURST"
  | "AP_LOST";

export type EventSeverity = "info" | "warning" | "alert";

export type AirspaceEvent = {
  id: number;
  type: EventType;
  severity: EventSeverity;
  timestamp: number;
  source: string; // bssid or mac this event is about, anonymized
  description: string;
};

// What capture.ts/demo-mode.ts feed into the aggregator — intentionally
// narrower than AccessPoint/Device, just the fields a single 802.11 frame
// can tell you. "beacon" and "probe_resp" are kept as two separate variants
// (rather than one variant with kind: "beacon" | "probe_resp") so
// TypeScript can actually narrow a plain if/else-if/else chain on `.kind`
// down to a single member each time — a union'd literal on one variant
// defeats that.
type ApFrameFields = {
  bssid: string;
  ssid: string;
  channel: number;
  rssi: number;
  security: SecurityKind;
  timestamp: number;
};

export type RawFrameEvent =
  | ({ kind: "beacon" } & ApFrameFields)
  | ({ kind: "probe_resp" } & ApFrameFields)
  | {
      kind: "data";
      bssid: string;
      client: string;
      rssi: number;
      timestamp: number;
    }
  | {
      kind: "deauth";
      bssid: string;
      client: string;
      timestamp: number;
    };

export type AirspaceMode = "live" | "demo" | "starting" | "error";

export type ChannelActivity = {
  channel: number;
  frames: number; // frames observed on this channel in the last window
};

export type AirspaceSnapshot = {
  mode: AirspaceMode;
  demo: boolean;
  hardware: string | null; // e.g. "Qualcomm Atheros AR9271 802.11n"
  currentChannel: number;
  framesPerMinute: number;
  accessPoints: AccessPoint[];
  devices: Device[];
  events: AirspaceEvent[];
  channelActivity: ChannelActivity[];
  error?: string;
};
