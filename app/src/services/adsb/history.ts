import path from "path";
import Database from "better-sqlite3";
import { dataDir } from "../../utils/dir";
import { Aircraft } from "./types";

// One SQLite file for the whole Aircraft Radar module: aircraft_seen (the
// spec's requested history table) and aircraft_lookup_cache (ICAO/callsign
// resolution cache — see aircraft-database.ts/flight-resolver.ts). Sits
// next to the rest of the project's runtime state (utils/dir.ts's dataDir,
// same directory as recordings/images/chat_history).
const db = new Database(path.join(dataDir, "aircraft-radar.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS aircraft_seen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    icao TEXT NOT NULL,
    callsign TEXT,
    registration TEXT,
    lat REAL,
    lon REAL,
    altitude INTEGER,
    speed INTEGER,
    heading INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_aircraft_seen_icao ON aircraft_seen(icao);
  CREATE INDEX IF NOT EXISTS idx_aircraft_seen_timestamp ON aircraft_seen(timestamp);

  CREATE TABLE IF NOT EXISTS aircraft_lookup_cache (
    icao TEXT PRIMARY KEY,
    registration TEXT,
    manufacturer TEXT,
    model TEXT,
    operator TEXT,
    resolved_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS route_lookup_cache (
    callsign TEXT PRIMARY KEY,
    flight_number TEXT,
    origin TEXT,
    destination TEXT,
    origin_name TEXT,
    destination_name TEXT,
    resolved_at INTEGER NOT NULL
  );
`);

// Schema evolution: "near" marks captures taken inside the sighting zone
// around Akbal, at the moment they were recorded (see zone.ts). Rows older
// than this migration have no recorded zone, so they default to 0.
{
  const cols = db.prepare(`PRAGMA table_info(aircraft_seen)`).all() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === "near")) {
    db.exec(`ALTER TABLE aircraft_seen ADD COLUMN near INTEGER NOT NULL DEFAULT 0`);
    console.log("[aircraft-radar] history migrated: aircraft_seen.near");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_aircraft_seen_near ON aircraft_seen(near, timestamp)`);
  // Distance from Akbal at capture time; null when Akbal had no known position.
  if (cols.length > 0 && !cols.some((c) => c.name === "distance_km")) {
    db.exec(`ALTER TABLE aircraft_seen ADD COLUMN distance_km REAL`);
    console.log("[aircraft-radar] history migrated: aircraft_seen.distance_km");
  }
}

// Schema evolution: operating airline name, from the same adsbdb.com
// callsign response route_lookup_cache already stores — additive-only
// (same pattern as wardrive/drive-db.ts), safe on a device with an existing
// cache from before this field existed.
{
  const cols = db.prepare(`PRAGMA table_info(route_lookup_cache)`).all() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === "airline_name")) {
    db.exec(`ALTER TABLE route_lookup_cache ADD COLUMN airline_name TEXT`);
    console.log("[aircraft-radar] history migrated: route_lookup_cache.airline_name");
  }
}

const insertSeenStmt = db.prepare(`
  INSERT INTO aircraft_seen (timestamp, icao, callsign, registration, lat, lon, altitude, speed, heading, near, distance_km)
  VALUES (@timestamp, @icao, @callsign, @registration, @lat, @lon, @altitude, @speed, @heading, @near, @distance_km)
`);

// Called from aircraft-tracker.ts whenever a position update lands — not on
// every raw ADS-B message (identification/velocity-only messages carry no
// new position), so the table grows at roughly one row per aircraft per
// position report instead of one per Mode-S frame.
export function recordAircraftSeen(aircraft: Aircraft, near: boolean, distanceKm: number | null): void {
  insertSeenStmt.run({
    near: near ? 1 : 0,
    distance_km: distanceKm,
    timestamp: aircraft.lastSeen,
    icao: aircraft.icao,
    callsign: aircraft.callsign,
    registration: aircraft.registration,
    lat: aircraft.latitude,
    lon: aircraft.longitude,
    altitude: aircraft.altitudeFt,
    speed: aircraft.speedKt,
    heading: aircraft.headingDeg,
  });
}

export type AircraftSeenRow = {
  id: number;
  timestamp: number;
  icao: string;
  callsign: string | null;
  registration: string | null;
  lat: number | null;
  lon: number | null;
  altitude: number | null;
  speed: number | null;
  heading: number | null;
  near: number;
  distance_km: number | null;
};

// GET /api/aircraft/history and the agent's "¿qué aviones pasaron en los
// últimos N minutos?" tool both read through here.
export function getRecentHistory(sinceMs: number, limit = 500): AircraftSeenRow[] {
  return db
    .prepare(`SELECT * FROM aircraft_seen WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?`)
    .all(sinceMs, limit) as AircraftSeenRow[];
}

export function getHistoryForIcao(icao: string, limit = 200): AircraftSeenRow[] {
  return db
    .prepare(`SELECT * FROM aircraft_seen WHERE icao = ? ORDER BY timestamp DESC LIMIT ?`)
    .all(icao.toUpperCase(), limit) as AircraftSeenRow[];
}

export type AircraftLookupCacheRow = {
  icao: string;
  registration: string | null;
  manufacturer: string | null;
  model: string | null;
  operator: string | null;
  resolved_at: number;
};

const getLookupStmt = db.prepare(`SELECT * FROM aircraft_lookup_cache WHERE icao = ?`);
const upsertLookupStmt = db.prepare(`
  INSERT INTO aircraft_lookup_cache (icao, registration, manufacturer, model, operator, resolved_at)
  VALUES (@icao, @registration, @manufacturer, @model, @operator, @resolved_at)
  ON CONFLICT(icao) DO UPDATE SET
    registration = excluded.registration,
    manufacturer = excluded.manufacturer,
    model = excluded.model,
    operator = excluded.operator,
    resolved_at = excluded.resolved_at
`);

export function getCachedAircraftLookup(icao: string): AircraftLookupCacheRow | null {
  return (getLookupStmt.get(icao.toUpperCase()) as AircraftLookupCacheRow | undefined) || null;
}

export function cacheAircraftLookup(
  icao: string,
  data: { registration: string | null; manufacturer: string | null; model: string | null; operator: string | null },
): void {
  upsertLookupStmt.run({ icao: icao.toUpperCase(), resolved_at: Date.now(), ...data });
}

export type RouteLookupCacheRow = {
  callsign: string;
  flight_number: string | null;
  origin: string | null;
  destination: string | null;
  origin_name: string | null;
  destination_name: string | null;
  airline_name: string | null;
  resolved_at: number;
};

const getRouteStmt = db.prepare(`SELECT * FROM route_lookup_cache WHERE callsign = ?`);
const upsertRouteStmt = db.prepare(`
  INSERT INTO route_lookup_cache (callsign, flight_number, origin, destination, origin_name, destination_name, airline_name, resolved_at)
  VALUES (@callsign, @flightNumber, @origin, @destination, @originName, @destinationName, @airlineName, @resolvedAt)
  ON CONFLICT(callsign) DO UPDATE SET
    flight_number = excluded.flight_number,
    origin = excluded.origin,
    destination = excluded.destination,
    origin_name = excluded.origin_name,
    destination_name = excluded.destination_name,
    airline_name = excluded.airline_name,
    resolved_at = excluded.resolved_at
`);

export function getCachedRoute(callsign: string): RouteLookupCacheRow | null {
  return (getRouteStmt.get(callsign.trim().toUpperCase()) as RouteLookupCacheRow | undefined) || null;
}

export function cacheRoute(
  callsign: string,
  data: {
    flightNumber: string | null;
    origin: string | null;
    destination: string | null;
    originName: string | null;
    destinationName: string | null;
    airlineName: string | null;
  },
): void {
  upsertRouteStmt.run({ callsign: callsign.trim().toUpperCase(), resolvedAt: Date.now(), ...data });
}

// The zone list: one row per aircraft that was captured inside the zone in the
// window, carrying its most recent zone capture. Newest first.
const zoneRecentStmt = db.prepare(`
  SELECT a.* FROM aircraft_seen a
  JOIN (
    SELECT icao, MAX(timestamp) AS last_ts
    FROM aircraft_seen
    WHERE near = 1 AND timestamp >= ?
    GROUP BY icao
  ) m ON a.icao = m.icao AND a.timestamp = m.last_ts
  WHERE a.near = 1
  ORDER BY a.timestamp DESC
  LIMIT ?
`);

export function getZoneRecent(sinceMs: number, limit = 200): AircraftSeenRow[] {
  return zoneRecentStmt.all(sinceMs, limit) as AircraftSeenRow[];
}

const sightingsStmt = db.prepare(`
  SELECT * FROM aircraft_seen
  WHERE icao = ? AND near = 1 AND timestamp >= ?
  ORDER BY timestamp DESC
  LIMIT ?
`);

export function getSightingsForIcao(icao: string, sinceMs: number, limit = 500): AircraftSeenRow[] {
  return sightingsStmt.all(icao.toUpperCase(), sinceMs, limit) as AircraftSeenRow[];
}

const pruneStmt = db.prepare(`DELETE FROM aircraft_seen WHERE timestamp < ?`);

// Drops every capture older than the window. Runs at startup and hourly, so
// the table never holds more than the window plus one hour.
export function pruneSightingsOlderThan(cutoffMs: number): number {
  return pruneStmt.run(cutoffMs).changes;
}

