// Types for the DRIVING wardrive feature (docs/wardrive.md): passive
// continuous discovery + opportunistic opportunistic handshake capture while
// the operator is driving. Distinct from wardrive/ (targeted lab capture):
// this module records EVERYTHING it sees and where it saw it, and only
// deauths when the opportunistic-deauth toggle is on AND the car is slow.
//
// Privacy: only full MACs live here (device-local data/wardrive-drive.db,
// outside the git tree). The web API anonymizes BSSIDs/SSIDs unless the
// client asks for ?fullMac=1 with a valid session — same policy as
// wifiradar (see wifiradar/privacy.ts).

export type DriveSecurityKind = "OPEN" | "WEP" | "WPA" | "WPA2/3" | "UNKNOWN";

// One access point as the wardrive sees it. Key: bssid.
export type DriveApView = {
  bssid: string; // full MAC (uppercase) — session-cookie UI only
  ssid: string; // "(oculta)" when never seen
  channel: number;
  rssi: number; // dBm, most recent reading
  security: DriveSecurityKind;
  vendor: string;
  firstSeenTs: number;
  lastSeenTs: number;
  packets: number;
  bestRssi: number; // strongest reading ever this session (capture gating)
  // Handshake state (network-wide knowledge, see drive-db.ts):
  handshakeKnown: boolean; // another AP of this SSID already has one
  handshakeHere: boolean; // THIS bssid has a capture in this session
  attempts: number; // deauth rounds fired at this AP this session
  eapolFrames: number; // EAPOL/PMKID frames captured from this AP this session
  status: "fresh" | "attack-scheduled" | "attacking" | "captured" | "exhausted" | "open";
};

// Live GPS position for the HUD + track.
export type DriveFix = {
  hasFix: boolean;
  latitude: number | null;
  longitude: number | null;
  speedKmh: number | null;
  headingDeg: number | null;
  hdop: number | null;
  satellitesUsed: number;
  satellitesInView: number;
  error: string;
};

// Poll payload for the driving page. Small by design (1Hz): positions are
// per-bucket (not per-point) and networks are already aggregated.
export type DriveStatus = {
  running: boolean;
  session: {
    id: string;
    startedAt: number;
    durationSec: number;
    distanceMeters: number;
    points: number;
  } | null;
  gps: DriveFix;
  iface: string | null;
  error: string;
  channel: number; // current listening channel (0 = not hopping yet)
  // Live activity ticker: what the engine is doing right now (newest
  // first). kind: "attack" | "captured" | "info"
  activity: { ts: number; text: string; kind: string }[];
  currentAttack: string | null; // "PMKID → akbal_lab" style one-liner
  stats: {
    aps: number; // APs visible right now (in-memory tracker)
    unique: number; // all-time unique SSIDs recorded (DB)
    newThisSession: number; // SSIDs seen for the first time ever
    handshakes: number; // SSIDs with handshake recorded all-time
    newHandshakes: number; // this session's new handshake SSIDs
    points: number; // track points this session
  };
  recent: DriveApView[]; // ALL APs this session, attack status first
};

// One captured-SSID row in the wardrive DB (bssid column = the AP that
// produced it, for the sessions listing only — matching is by SSID).
export type DriveHandshakeRecord = {
  ssid: string;
  bssid: string;
  security: string;
  method: "deauth" | "pmkid";
  capturedAt: number;
  sessionDir: string;
  sessionId: string;
  capFile: string;
  hashFile: string;
  lat: number | null;
  lon: number | null;
  password: string | null; // only after a rockyou hit
  cracked: 0 | 1;
};

export type DriveSessionSummary = {
  id: string;
  startedAt: number;
  endedAt: number | null;
  distanceMeters: number;
  points: number;
  networks: number; // distinct SSIDs recorded
  handshakes: number; // new handshakes captured
  hasTrack: boolean;
};

// ─── Session status per AP (in-memory during the session) ───────────────────

export type ApSessionState = {
  status: "fresh" | "attack-scheduled" | "attacking" | "captured" | "exhausted" | "open";
  attempts: number;
  lastAttackAt: number;
  lastDeauthAt: number;
  cooldownUntil: number;
  // EAPOL/PMKID captured from THIS AP during this session
  eapolFrames: number;
  captured: boolean;
  method: "" | "deauth" | "pmkid";
  capFile: string;
  hashFile: string;
  lastRssi: number;
  bestRssi: number;
  lastSeen: number;
  firstSeen: number;
  clients: Set<string>;
  channel: number;
  packets: number;
};