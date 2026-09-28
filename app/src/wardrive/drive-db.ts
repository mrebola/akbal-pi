import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// Drive-wardrive persistence (docs/wardrive.md): ONE sqlite file at
// data/wardrive-drive.db (git-ignored, runtime dir) holding:
//   networks_seen  — every SSID+security ever observed (dedup key for the
//                    "don't re-hunt this SSID" rule and the global counter)
//   handshakes     — SSIDs with a usable EAPOL/PMKID capture + which session
//                    produced it (the "already have it, skip" table)
//   drive_sessions — one row per driving session (id = folder name under
//                    ~/wardrive-sessions/drive-*)
//   track_points   — the GPS breadcrumb of each session (map polyline)
//
// Everything in here is device-local (MACs, SSIDs, positions); nothing from
// this file is ever committed — the sessions root lives under $HOME.

const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "wardrive-drive.db");

export const DRIVE_SESSIONS_ROOT = path.join(
  process.env.HOME || "/home/akbal",
  "wardrive-sessions",
);

type NetworksSeenRow = {
  ssid: string;
  security: string;
  first_seen: number;
  last_seen: number;
  times_seen: number;
  handshake: 0 | 1;
  handshake_bssid: string | null;
  handshake_at: number | null;
};

export class DriveDb {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS networks_seen (
        ssid        TEXT PRIMARY KEY,
        security    TEXT NOT NULL,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        times_seen  INTEGER NOT NULL DEFAULT 1,
        handshake   INTEGER NOT NULL DEFAULT 0,
        handshake_bssid TEXT,
        handshake_at    INTEGER
      );
      CREATE TABLE IF NOT EXISTS handshakes (
        ssid        TEXT NOT NULL,
        bssid       TEXT NOT NULL,
        security    TEXT NOT NULL,
        method      TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        session_id  TEXT NOT NULL,
        session_dir TEXT NOT NULL,
        cap_file    TEXT NOT NULL,
        hash_file   TEXT,
        lat         REAL,
        lon         REAL,
        password    TEXT,
        cracked     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (ssid, bssid, captured_at)
      );
      CREATE TABLE IF NOT EXISTS drive_sessions (
        id          TEXT PRIMARY KEY,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        distance_m  REAL NOT NULL DEFAULT 0,
        points      INTEGER NOT NULL DEFAULT 0,
        networks    INTEGER NOT NULL DEFAULT 0,
        handshakes  INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS track_points (
        session_id TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        lat        REAL NOT NULL,
        lon        REAL NOT NULL,
        speed_kmh  REAL,
        heading    REAL,
        hdop       REAL
      );
      CREATE INDEX IF NOT EXISTS idx_track_session ON track_points(session_id, ts);
    `);
  }

  // ─── networks_seen ─────────────────────────────────────────────────────

  // Returns true when this SSID had never been seen before (a "new" find
  // worth counting in the session stats). Always refreshes last_seen.
  recordNetwork(ssid: string, security: string): boolean {
    if (!ssid) return false;
    const now = Date.now();
    try {
      const r = this.db
        .prepare(
          `INSERT INTO networks_seen (ssid, security, first_seen, last_seen, times_seen, handshake)
           VALUES (?, ?, ?, ?, 1, 0)
           ON CONFLICT(ssid) DO UPDATE SET
             last_seen = excluded.last_seen,
             times_seen = times_seen + 1,
             security = CASE WHEN excluded.security != 'UNKNOWN' AND security IN ('UNKNOWN','') THEN excluded.security ELSE security END`,
        )
        .run(ssid, security, now, now);
      return r.changes > 0;
    } catch (err) {
      console.warn("[wardrive] recordNetwork failed:", (err as Error).message);
      return false;
    }
  }

  // Global "do I already have a handshake for this SSID?" check. The DB is
  // the source of truth so the rule survives process restarts.
  hasHandshake(ssid: string): boolean {
    if (!ssid || ssid === "(oculta)") return false;
    const row = this.db
      .prepare(`SELECT handshake FROM networks_seen WHERE ssid = ?`)
      .get(ssid) as { handshake: number } | undefined;
    return Boolean(row?.handshake);
  }

  // All SSIDs that already have a handshake — loaded once at session start
  // for fast in-memory checks during capture bursts.
  handshakeSsids(): Set<string> {
    const rows = this.db
      .prepare(`SELECT ssid FROM networks_seen WHERE handshake = 1`)
      .all() as { ssid: string }[];
    return new Set(rows.map((r) => r.ssid));
  }

  markHandshake(rec: {
    ssid: string;
    bssid: string;
    security: string;
    method: string;
    capFile: string;
    hashFile: string;
    sessionDir: string;
    sessionId: string;
    lat: number | null;
    lon: number | null;
  }): void {
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO handshakes
             (ssid, bssid, security, method, captured_at, session_id, session_dir, cap_file, hash_file, lat, lon)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rec.ssid,
          rec.bssid,
          rec.security,
          rec.method,
          now,
          rec.sessionId,
          rec.sessionDir,
          rec.capFile,
          rec.hashFile || null,
          rec.lat,
          rec.lon,
        );
      this.db
        .prepare(
          `UPDATE networks_seen SET handshake = 1, handshake_bssid = ?, handshake_at = ? WHERE ssid = ?`,
        )
        .run(rec.bssid, now, rec.ssid);
    } catch (err) {
      console.warn("[wardrive] markHandshake failed:", (err as Error).message);
    }
  }

  // Store the rockyou hit for a captured SSID (drives the 🏴 flag in the UI).
  setCracked(ssid: string, bssid: string, password: string): void {
    try {
      this.db
        .prepare(
          `UPDATE handshakes SET password = ?, cracked = 1
           WHERE ssid = ? AND bssid = ? AND cracked = 0`,
        )
        .run(password, ssid, bssid);
    } catch {
      // never fatal
    }
  }

  // Distinct-SSID counters for the status payload.
  stats(): { unique: number; handshakes: number } {
    const unique = (this.db.prepare(`SELECT COUNT(*) AS n FROM networks_seen`).get() as { n: number }).n;
    const handshakes = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM networks_seen WHERE handshake = 1`).get() as { n: number }
    ).n;
    return { unique, handshakes };
  }

  // Networks seen in the air right now that are still worth hunting: not
  // already handshake-covered and not OPEN (nothing to capture there).
  huntPendingSsids(): Set<string> {
    const rows = this.db
      .prepare(`SELECT ssid FROM networks_seen WHERE handshake = 0`)
      .all() as { ssid: string }[];
    return new Set(rows.map((r) => r.ssid));
  }

  // ─── sessions + track ──────────────────────────────────────────────────

  insertSession(id: string, startedAt: number): void {
    try {
      this.db
        .prepare(`INSERT OR IGNORE INTO drive_sessions (id, started_at) VALUES (?, ?)`)
        .run(id, startedAt);
    } catch {
      // never fatal
    }
  }

  updateSession(
    id: string,
    patch: { endedAt?: number | null; distanceM?: number; points?: number; networks?: number; handshakes?: number },
  ): void {
    try {
      if (patch.endedAt !== undefined) {
        this.db.prepare(`UPDATE drive_sessions SET ended_at = ? WHERE id = ?`).run(patch.endedAt, id);
      }
      if (patch.distanceM !== undefined) {
        this.db.prepare(`UPDATE drive_sessions SET distance_m = ? WHERE id = ?`).run(patch.distanceM, id);
      }
      if (patch.points !== undefined) {
        this.db.prepare(`UPDATE drive_sessions SET points = ? WHERE id = ?`).run(patch.points, id);
      }
      if (patch.networks !== undefined) {
        this.db.prepare(`UPDATE drive_sessions SET networks = ? WHERE id = ?`).run(patch.networks, id);
      }
      if (patch.handshakes !== undefined) {
        this.db.prepare(`UPDATE drive_sessions SET handshakes = ? WHERE id = ?`).run(patch.handshakes, id);
      }
    } catch {
      // never fatal
    }
  }

  // Periodic counter sync (cheap read of what the session wrote so far) —
  // used to keep the session row current without the service caring.
  sessionNetworkCount(sessionId: string): number {
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM networks_seen
           WHERE first_seen BETWEEN (SELECT started_at FROM drive_sessions WHERE id = ?) AND ?`,
        )
        .get(sessionId, Date.now()) as { n: number };
      return row.n;
    } catch {
      return 0;
    }
  }

  addTrackPoint(
    sessionId: string,
    ts: number,
    lat: number,
    lon: number,
    speedKmh: number | null,
    heading: number | null,
    hdop: number | null,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO track_points (session_id, ts, lat, lon, speed_kmh, heading, hdop)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, ts, lat, lon, speedKmh, heading, hdop);
    } catch {
      // never fatal
    }
  }

  trackPoints(sessionId: string, limit = 100_000): { ts: number; lat: number; lon: number }[] {
    try {
      return this.db
        .prepare(
          `SELECT ts, lat, lon FROM track_points WHERE session_id = ? ORDER BY ts LIMIT ?`,
        )
        .all(sessionId, limit) as { ts: number; lat: number; lon: number }[];
    } catch {
      return [];
    }
  }

  sessions(): DriveSessionRow[] {
    try {
      return this.db
        .prepare(
          `SELECT id, started_at, ended_at, distance_m, points, networks, handshakes
           FROM drive_sessions ORDER BY started_at DESC LIMIT 200`,
        )
        .all() as DriveSessionRow[];
    } catch {
      return [];
    }
  }

  sessionNetworks(sessionId: string): SessionNetworkRow[] {
    try {
      const session = this.db.prepare(`SELECT started_at FROM drive_sessions WHERE id = ?`).get(sessionId) as
        | { started_at: number }
        | undefined;
      const startedAt = session?.started_at ?? 0;
      return this.db
        .prepare(
          `SELECT n.ssid, n.security, n.handshake, n.first_seen, h.bssid, h.method, h.password, h.cracked, h.lat, h.lon
           FROM networks_seen n
           LEFT JOIN handshakes h ON h.ssid = n.ssid AND h.captured_at = (
             SELECT MIN(captured_at) FROM handshakes h2 WHERE h2.ssid = n.ssid)
           WHERE n.first_seen >= ? AND n.first_seen <= ?
           ORDER BY n.first_seen DESC
           LIMIT 3000`,
        )
        .all(startedAt, Date.now() + 1000) as SessionNetworkRow[];
    } catch {
      return [];
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // never fatal
    }
  }
}

export type DriveSessionRow = {
  id: string;
  started_at: number;
  ended_at: number | null;
  distance_m: number;
  points: number;
  networks: number;
  handshakes: number;
};

export type SessionNetworkRow = {
  ssid: string;
  security: string;
  handshake: 0 | 1;
  first_seen: number;
  bssid: string | null;
  method: string | null;
  password: string | null;
  cracked: 0 | 1;
  lat: number | null;
  lon: number | null;
};

export const driveDb = new DriveDb();