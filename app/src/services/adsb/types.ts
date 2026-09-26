// Shared shapes for Aircraft Radar (ADS-B via HackRF One, docs/aircraft-radar.md).
// Same split as wifiradar/types.ts: hackrf-receiver.ts (real dump1090 feed)
// and demo-mode.ts (synthetic data) both produce RawAdsbMessage, so
// aircraft-tracker.ts never has to know which one is feeding it.

export type AdsbMessageKind =
  | "identification" // callsign (SBS TransmissionType 1)
  | "position" // altitude + lat/lon (TransmissionType 2/3)
  | "velocity" // ground speed + track + vertical rate (TransmissionType 4)
  | "surveillance"; // altitude + squawk (TransmissionType 5/6)

export type RawAdsbMessage = {
  kind: AdsbMessageKind;
  icao: string; // 24-bit Mode-S address, hex, uppercase (e.g. "0D1005")
  timestamp: number; // epoch ms
  callsign?: string;
  altitudeFt?: number;
  latitude?: number;
  longitude?: number;
  groundSpeedKt?: number;
  trackDeg?: number;
  verticalRateFtMin?: number;
  squawk?: string;
  onGround?: boolean;
};

export type RouteInfo = {
  flightNumber: string | null;
  origin: string | null; // IATA/ICAO airport code
  destination: string | null;
  originName: string | null;
  destinationName: string | null;
};

export type AircraftIdentity = {
  registration: string | null;
  manufacturer: string | null;
  model: string | null;
  operator: string | null;
  // Where the identity fields above came from — lets the UI/agent say
  // "Route unknown" or leave fields blank instead of inventing data.
  resolved: boolean;
};

export type Aircraft = {
  icao: string;
  callsign: string | null;
  registration: string | null;
  manufacturer: string | null;
  model: string | null;
  operator: string | null;
  flightNumber: string | null;
  origin: string | null;
  destination: string | null;
  altitudeFt: number | null;
  speedKt: number | null;
  headingDeg: number | null;
  verticalRateFtMin: number | null;
  squawk: string | null;
  onGround: boolean;
  latitude: number | null;
  longitude: number | null;
  // Null until Akbal has a GPS fix (utils/gps.ts) to compute these against.
  distanceKm: number | null;
  bearingDeg: number | null;
  approaching: boolean | null;
  firstSeen: number; // epoch ms
  lastSeen: number;
};

export type AircraftRadarMode = "live" | "demo" | "starting" | "error";

export type AircraftRadarSnapshot = {
  mode: AircraftRadarMode;
  demo: boolean;
  hardware: string | null; // e.g. "HackRF One"
  messagesPerMinute: number;
  aircraft: Aircraft[]; // sorted by distance (nulls last)
  error?: string;
};
