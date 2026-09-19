// Types for the WARDRIVE capture feature (thesis/lab use): targeted
// handshake capture against an explicit allowlist of lab APs — see
// wardrive/service.ts for why there is no "attack everything" mode.

export type WardriveTarget = {
  bssid: string; // full MAC, uppercase — the allowlist key
  ssid: string;
  channel: number;
  rssi: number; // dBm, most recent reading
  security: string; // as reported by the discovery source
  clients: number; // associated clients seen in the air
  distanceMeters: number; // rough RSSI-based estimate (order of magnitude)
  inAllowlist: boolean;
  attackable: boolean; // signal strength heuristic for UI ordering
};

export type WardriveTargetStatus = "idle" | "running" | "captured" | "failed" | "cancelled";

export type WardriveSessionTarget = {
  bssid: string;
  ssid: string;
  channel: number;
  status: WardriveTargetStatus;
  method: "" | "pmkid" | "deauth"; // which method actually produced the capture
  attempts: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string;
  files: string[]; // capture artifacts for this target, relative to the session dir
};

export type WardriveMode = "inactive" | "ready" | "scanning" | "attacking";

export type WardriveSessionInfo = {
  id: string; // <timestamp> — also the session folder name
  startedAt: number;
  endedAt: number | null;
  targets: WardriveSessionTarget[];
  currentBssid: string | null;
};

export type WardriveStatus = {
  mode: WardriveMode;
  modelsUnloaded: boolean;
  iface: string | null;
  error: string;
  session: WardriveSessionInfo | null;
  targets: WardriveTarget[]; // live scan view (air), refreshed by scan()
  allowlist: string[]; // BSSIDs currently authorized
};

export type WardriveEventPayload =
  | { type: "status"; status: WardriveStatus }
  | { type: "target-update"; bssid: string; status: WardriveTargetStatus; method: string; error: string };

// Client-device view for the Deauth tab (wardrive/discovery.ts). One
// entry per distinct client MAC the WIFIRADAR capture has seen talking.
export type WardriveDeviceView = {
  mac: string; // full MAC — this view is only ever served behind the session cookie
  vendor: string;
  rssi: number;
  associatedBssid: string | null;
  associatedSsid: string | null;
  clientAuthorized: boolean; // this client's MAC is in the deauth allowlist
  apAuthorized: boolean; // its associated AP is in the attack allowlist
  deauthAuthorized: boolean; // deauth may target this client at all
  deauthing: boolean; // deauth currently being sent to this client
  frames: number;
  lastSeen: number;
};