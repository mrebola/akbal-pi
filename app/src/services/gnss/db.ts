import path from "path";
import Database from "better-sqlite3";
import { dataDir } from "../../utils/dir";
import { GnssConstellationCode, GnssOrbitalRecord, GnssSatelliteMetadata } from "./types";

// One SQLite file for GNSS (same pattern as services/adsb/history.ts and
// wardrive/drive-db.ts). Three tables, deliberately split:
//   - gnss_satellite_metadata: permanent identity (constellation/PRN/name),
//     changes almost never.
//   - gnss_orbital_data: the orbital elements themselves (OMM/JSON), which
//     go stale and get replaced wholesale on refresh — separate table so
//     re-fetching an orbit never touches the identity row.
//   - gnss_observations: historical sky-plot readings (docs/gnss.md).
const db = new Database(path.join(dataDir, "gnss.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS gnss_satellite_metadata (
    constellation TEXT NOT NULL,
    prn TEXT NOT NULL,
    norad_id INTEGER,
    name TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (constellation, prn)
  );

  CREATE TABLE IF NOT EXISTS gnss_orbital_data (
    norad_id INTEGER PRIMARY KEY,
    omm_json TEXT NOT NULL,
    epoch TEXT,
    fetched_at INTEGER NOT NULL,
    source TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gnss_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    constellation TEXT NOT NULL,
    prn TEXT NOT NULL,
    snr INTEGER NOT NULL,
    azimuth INTEGER NOT NULL,
    elevation INTEGER NOT NULL,
    used INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gnss_obs_timestamp ON gnss_observations(timestamp);
  CREATE INDEX IF NOT EXISTS idx_gnss_obs_prn ON gnss_observations(constellation, prn);
`);

// ─── Metadata (permanent) ───────────────────────────────────────────────────

const getMetadataStmt = db.prepare(
  `SELECT * FROM gnss_satellite_metadata WHERE constellation = ? AND prn = ?`,
);

export function getSatelliteMetadata(
  constellation: GnssConstellationCode,
  prn: string,
): GnssSatelliteMetadata | null {
  const row = getMetadataStmt.get(constellation, prn) as
    | {
        constellation: GnssConstellationCode;
        prn: string;
        norad_id: number | null;
        name: string | null;
        first_seen: number;
        last_seen: number;
      }
    | undefined;
  if (!row) return null;
  return {
    constellation: row.constellation,
    prn: row.prn,
    noradId: row.norad_id,
    name: row.name,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

const touchMetadataStmt = db.prepare(`
  INSERT INTO gnss_satellite_metadata (constellation, prn, norad_id, name, first_seen, last_seen)
  VALUES (@constellation, @prn, NULL, NULL, @now, @now)
  ON CONFLICT(constellation, prn) DO UPDATE SET last_seen = @now
`);

// Called on every observation so first_seen/last_seen stay accurate even
// before any CelesTrak match exists.
export function touchSatelliteSeen(constellation: GnssConstellationCode, prn: string): void {
  touchMetadataStmt.run({ constellation, prn, now: Date.now() });
}

const setIdentityStmt = db.prepare(`
  INSERT INTO gnss_satellite_metadata (constellation, prn, norad_id, name, first_seen, last_seen)
  VALUES (@constellation, @prn, @noradId, @name, @now, @now)
  ON CONFLICT(constellation, prn) DO UPDATE SET
    norad_id = @noradId,
    name = @name,
    last_seen = @now
`);

// Called once CelesTrak resolves a PRN to a NORAD id + name.
export function setSatelliteIdentity(
  constellation: GnssConstellationCode,
  prn: string,
  noradId: number,
  name: string | null,
): void {
  setIdentityStmt.run({ constellation, prn, noradId, name, now: Date.now() });
}

// PRNs we've observed locally but never matched to a NORAD id — the ones
// worth spending a CelesTrak lookup on.
export function getUnresolvedPrns(
  constellation: GnssConstellationCode,
): Pick<GnssSatelliteMetadata, "prn">[] {
  return db
    .prepare(
      `SELECT prn FROM gnss_satellite_metadata WHERE constellation = ? AND norad_id IS NULL`,
    )
    .all(constellation) as Pick<GnssSatelliteMetadata, "prn">[];
}

// ─── Orbital data (replaced wholesale on refresh) ──────────────────────────

const getOrbitalStmt = db.prepare(`SELECT * FROM gnss_orbital_data WHERE norad_id = ?`);

export function getOrbitalData(noradId: number): GnssOrbitalRecord | null {
  const row = getOrbitalStmt.get(noradId) as
    | { norad_id: number; omm_json: string; epoch: string | null; fetched_at: number; source: string }
    | undefined;
  if (!row) return null;
  return {
    noradId: row.norad_id,
    ommJson: row.omm_json,
    epoch: row.epoch,
    fetchedAt: row.fetched_at,
    source: row.source as "celestrak",
  };
}

const upsertOrbitalStmt = db.prepare(`
  INSERT INTO gnss_orbital_data (norad_id, omm_json, epoch, fetched_at, source)
  VALUES (@noradId, @ommJson, @epoch, @fetchedAt, @source)
  ON CONFLICT(norad_id) DO UPDATE SET
    omm_json = @ommJson,
    epoch = @epoch,
    fetched_at = @fetchedAt,
    source = @source
`);

export function upsertOrbitalData(record: GnssOrbitalRecord): void {
  upsertOrbitalStmt.run(record);
}

export function isOrbitalStale(noradId: number, maxAgeMs: number): boolean {
  const record = getOrbitalData(noradId);
  if (!record) return true;
  return Date.now() - record.fetchedAt > maxAgeMs;
}

// ─── Historical observations ────────────────────────────────────────────────

const insertObservationStmt = db.prepare(`
  INSERT INTO gnss_observations (timestamp, constellation, prn, snr, azimuth, elevation, used)
  VALUES (@timestamp, @constellation, @prn, @snr, @azimuth, @elevation, @used)
`);

export function recordObservation(obs: {
  timestamp: number;
  constellation: GnssConstellationCode;
  prn: string;
  snr: number;
  azimuth: number;
  elevation: number;
  used: boolean;
}): void {
  insertObservationStmt.run({ ...obs, used: obs.used ? 1 : 0 });
}

export function getRecentObservations(sinceMs: number, limit = 1000) {
  return db
    .prepare(
      `SELECT * FROM gnss_observations WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(sinceMs, limit);
}

// Best-effort housekeeping so the observations table doesn't grow forever
// on a device that's never rebooted — called from service.ts's sweep, not
// on every write (cheap DELETE, no need to run it per-poll).
export function pruneOldObservations(olderThanMs: number): void {
  db.prepare(`DELETE FROM gnss_observations WHERE timestamp < ?`).run(Date.now() - olderThanMs);
}
