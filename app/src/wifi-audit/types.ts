// Types for the WARDRIVE capture feature (thesis/lab use): targeted
// handshake capture against an explicit allowlist of lab APs — see
// wifi-audit/service.ts for why there is no "attack everything" mode.

export type WardriveTarget = {
  bssid: string; // full MAC, uppercase — the allowlist key
  ssid: string;
  vendor: string; // OUI lookup with Random-MAC detection (wifiradar/oui.ts)
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
  verified: boolean; // handshake validated with aircrack against a known password (v2)
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
  | { type: "target-update"; bssid: string; status: WardriveTargetStatus; method: string; error: string }
  | { type: "attack-progress"; bssid: string; step: AttackStep; message: string; command?: string; output?: string };

// Step-by-step attack progress for the UI: explains what's happening and
// shows the exact command being run + its output.
export type AttackStep =
  | "scan"      // 1. scanning for target channel/clients
  | "lock"      // 2. locking radio to channel
  | "capture"   // 3. airodump running
  | "deauth"    // 4. sending deauth
  | "validate"  // 5. checking for handshake
  | "done";     // 6. final result

export const ATTACK_STEPS: Record<AttackStep, string> = {
  scan: "Escaneando red objetivo",
  lock: "Fijando canal del adaptador",
  capture: "Capturando tráfico (airodump-ng)",
  deauth: "Enviando deauth a clientes",
  validate: "Validando handshake capturado",
  done: "Resultado final",
};

// Inventory entry for Crack Station: one captured handshake (live or past
// session) with what's known about it. Crack Station itself is a separate
// admin page (/crack-station) that draws from BOTH capture tools —
// `source` says which one produced this entry (they share the same
// ~/wardrive-sessions root, see handshakeInventory() in service.ts).
export type HandshakeEntry = {
  sessionId: string; // session folder name (the id)
  bssid: string;
  ssid: string;
  hasHandshake: boolean;
  password: string | null; // already cracked, if any
  verified: boolean;
  live: boolean; // belongs to the in-progress session
  capFile: string | null; // capture file name (relative to the session dir)
  source: "wifi-audit" | "wardrive";
};

// Mask brute-force recipe (Crack Station, web UI): pattern where '@' =
// dígito (0-9) and '#' = minúscula (a-z), everything else is a literal
// (compiled to `crunch <len> <len> -t <pattern>` by wifi-audit/crack.ts).
// autoMacSuffix tells the UI to append the last 4 hex chars of the target's
// BSSID when launching (AXTEL XTREMO-style default-password recipes).
export type MaskPreset = {
  id: string; // builtin-* = shipped ones; m-<timestamp> = operator-created
  name: string;
  description: string; // how the password is built + which equipment
  pattern: string;
  autoMacSuffix: boolean;
};

// Client-device view for the Deauth tab (wifi-audit/discovery.ts). One
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