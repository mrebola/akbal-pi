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
        ssid        TEXT NOT NULL,
        bssid       TEXT NOT NULL,
        security    TEXT NOT NULL,
        channel     INTEGER,
        best_rssi   INTEGER,
        lat         REAL,
        lon         REAL,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        times_seen  INTEGER NOT NULL DEFAULT 1,
        handshake   INTEGER NOT NULL DEFAULT 0,
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_method TEXT,
        handshake_bssid TEXT,
        handshake_at    INTEGER,
        PRIMARY KEY (bssid)
      );
      CREATE INDEX IF NOT EXISTS idx_networks_ssid ON networks_seen(ssid);
      CREATE INDEX IF NOT EXISTS idx_networks_first ON networks_seen(first_seen);
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
    // Schema evolution 1: the first release keyed networks by SSID; the
    // historial needs per-BSSID rows (mac, position, rssi, channel,
    // attempts). Rebuild the table preserving what's already recorded.
    let cols = this.db.prepare(`PRAGMA table_info(networks_seen)`).all() as { name: string }[];
    if (cols.length > 0 && !cols.some((c) => c.name === "bssid")) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE networks_seen_new (
          ssid        TEXT NOT NULL,
          bssid       TEXT NOT NULL,
          security    TEXT NOT NULL,
          channel     INTEGER,
          best_rssi   INTEGER,
          lat         REAL,
          lon         REAL,
          first_seen  INTEGER NOT NULL,
          last_seen   INTEGER NOT NULL,
          times_seen  INTEGER NOT NULL DEFAULT 1,
          handshake   INTEGER NOT NULL DEFAULT 0,
          attempts    INTEGER NOT NULL DEFAULT 0,
          last_method TEXT,
          handshake_bssid TEXT,
          handshake_at    INTEGER,
          PRIMARY KEY (bssid)
        );
        INSERT OR IGNORE INTO networks_seen_new (ssid, bssid, security, first_seen, last_seen, times_seen, handshake, handshake_bssid, handshake_at)
          SELECT ssid, COALESCE(handshake_bssid, 'UNKNOWN-' || HEX(ssid)), security, first_seen, last_seen, times_seen, handshake, handshake_bssid, handshake_at FROM networks_seen;
        DROP TABLE networks_seen;
        ALTER TABLE networks_seen_new RENAME TO networks_seen;
        CREATE INDEX IF NOT EXISTS idx_networks_ssid ON networks_seen(ssid);
        CREATE INDEX IF NOT EXISTS idx_networks_first ON networks_seen(first_seen);
        COMMIT;
      `);
      console.log("[wardrive] drive-db migrated: networks_seen keyed by bssid");
      cols = this.db.prepare(`PRAGMA table_info(networks_seen)`).all() as { name: string }[];
    }
    // Schema evolution 2: per-method attempt counters (PMKID windows vs
    // deauth rounds) for "already attacked with X" knowledge across sessions.
    if (cols.length > 0 && !cols.some((c) => c.name === "pmkid_attempts")) {
      this.db.exec(`
        ALTER TABLE networks_seen ADD COLUMN pmkid_attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE networks_seen ADD COLUMN deauth_attempts INTEGER NOT NULL DEFAULT 0;
      `);
      console.log("[wardrive] drive-db migrated: per-method attempt counters");
    }
  }

  // ─── networks_seen ─────────────────────────────────────────────────────

  // Upsert one AP sighting, keyed by BSSID (the MAC address the historial
  // is browsed by). Returns true when this BSSID had never been seen
  // before (a "new" find worth counting in the session stats). Position
  // and best-rssi are kept at their best-known values: the STRONGEST
  // reading and the first position it was seen at win, never the last.
  recordNetwork(rec: {
    bssid: string;
    ssid: string;
    security: string;
    channel: number;
    rssi: number;
    lat: number | null;
    lon: number | null;
  }): boolean {
    if (!rec.bssid || rec.ssid === "(oculta)") return false;
    const now = Date.now();
    try {
      const r = this.db
        .prepare(
          `INSERT INTO networks_seen
             (ssid, bssid, security, channel, best_rssi, lat, lon, first_seen, last_seen, times_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(bssid) DO UPDATE SET
             ssid = CASE WHEN excluded.ssid != '(oculta)' AND ssid = '(oculta)' THEN excluded.ssid ELSE ssid END,
             security = CASE WHEN excluded.security != 'UNKNOWN' AND security IN ('UNKNOWN','') THEN excluded.security ELSE security END,
             channel = COALESCE(NULLIF(excluded.channel, 0), channel, excluded.channel),
             best_rssi = MAX(COALESCE(best_rssi, -999), excluded.best_rssi),
             lat = COALESCE(lat, excluded.lat),
             lon = COALESCE(lon, excluded.lon),
             last_seen = excluded.last_seen,
             times_seen = times_seen + 1`,
        )
        .run(
          rec.ssid,
          rec.bssid,
          rec.security,
          rec.channel || null,
          rec.rssi || null,
          rec.lat,
          rec.lon,
          now,
          now,
        );
      return r.changes > 0;
    } catch (err) {
      console.warn("[wardrive] recordNetwork failed:", (err as Error).message);
      return false;
    }
  }

  // Count attack attempts against a BSSID, per method (PMKID windows vs
  // deauth rounds) — "already attacked with X" knowledge for subsequent
  // sessions so a round never repeats a method that already failed.
  recordAttempt(bssid: string, method: string): void {
    try {
      if (method === "pmkid") {
        this.db
          .prepare(
            `UPDATE networks_seen SET
               attempts = attempts + 1,
               pmkid_attempts = pmkid_attempts + 1,
               last_method = ?
             WHERE bssid = ?`,
          )
          .run(method, bssid);
      } else {
        this.db
          .prepare(
            `UPDATE networks_seen SET
               attempts = attempts + 1,
               deauth_attempts = deauth_attempts + 1,
               last_method = ?
             WHERE bssid = ?`,
          )
          .run(method, bssid);
      }
    } catch {
      // never fatal
    }
  }

  // Per-BSSID attack history: which methods were already tried and how
  // many times. Drives the "skip the method that already failed" rule.
  methodHistory(bssid: string): { pmkid: number; deauth: number; last: string | null } {
    const row = this.db
      .prepare(
        `SELECT pmkid_attempts, deauth_attempts, last_method FROM networks_seen WHERE bssid = ?`,
      )
      .get(bssid) as { pmkid_attempts: number; deauth_attempts: number; last_method: string | null } | undefined;
    if (!row) return { pmkid: 0, deauth: 0, last: null };
    return { pmkid: row.pmkid_attempts, deauth: row.deauth_attempts, last: row.last_method };
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
  // for fast in-memory checks during capture bursts. The source of truth
  // is the handshakes TABLE (rows only exist when an artifact was actually
  // written), not the flag on networks_seen: a deleted session removes the
  // table row and the SSID becomes fair game again.
  handshakeSsids(): Set<string> {
    const rows = this.db
      .prepare(`SELECT DISTINCT ssid FROM handshakes`)
      .all() as { ssid: string }[];
    return new Set(rows.map((r) => r.ssid));
  }

  // Self-heal: rows where handshake=1 but NO real capture exists (session
  // folders deleted from the UI left the flag orphaned). Clears the flag
  // so the SSID becomes huntable again. Returns how many were repaired.
  repairOrphanHandshakes(): number {
    try {
      const r = this.db
        .prepare(
          `UPDATE networks_seen SET handshake = 0, handshake_bssid = NULL, handshake_at = NULL
           WHERE handshake = 1
             AND bssid NOT IN (SELECT DISTINCT bssid FROM handshakes)`,
        )
        .run();
      return r.changes;
    } catch {
      return 0;
    }
  }

  // SSIDs that were ever ATTACKED in any past session (attempts > 0) — the
  // operator's recurring target list (labs). They get targeting priority
  // and a wider RSSI gate in the next sessions.
  prioritySsids(): Set<string> {
    const rows = this.db
      .prepare(`SELECT DISTINCT ssid FROM networks_seen WHERE attempts > 0`)
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
          `UPDATE networks_seen SET handshake = 1, handshake_bssid = ?, handshake_at = ?, last_method = ? WHERE ssid = ?`,
        )
        .run(rec.bssid, now, rec.method, rec.ssid);
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
          `SELECT n.bssid, n.ssid, n.security, n.channel, n.best_rssi, n.lat, n.lon, n.first_seen,
                  n.handshake, n.attempts, n.pmkid_attempts, n.deauth_attempts, n.last_method, n.handshake_bssid, n.handshake_at,
                  h.method AS hs_method, h.password, h.cracked
            FROM networks_seen n
            LEFT JOIN handshakes h ON h.bssid = n.bssid AND h.captured_at = (
              SELECT MIN(captured_at) FROM handshakes h2 WHERE h2.bssid = n.bssid)
            WHERE n.first_seen >= ? AND n.first_seen <= ?
            ORDER BY n.handshake DESC, n.first_seen DESC
            LIMIT 5000`,
        )
        .all(startedAt, Date.now() + 1000) as SessionNetworkRow[];
    } catch {
      return [];
    }
  }

  // Delete one drive session: its DB row, its track points and its
  // handshake rows (networks_seen survives — it's the global archive).
  deleteSession(sessionId: string): boolean {
    try {
      this.db.prepare(`DELETE FROM track_points WHERE session_id = ?`).run(sessionId);
      this.db.prepare(`DELETE FROM handshakes WHERE session_id = ?`).run(sessionId);
      const r = this.db.prepare(`DELETE FROM drive_sessions WHERE id = ?`).run(sessionId);
      return r.changes > 0;
    } catch {
      return false;
    }
  }

  // All-time historial export: every network ever seen, with position,
  // capture time, handshake state and the artifact file that holds it.
  historialCsv(): string {
    try {
      const rows = this.db
        .prepare(
          `SELECT n.bssid, n.ssid, n.security, n.channel, n.best_rssi, n.lat, n.lon, n.first_seen,
                  n.handshake, n.attempts, n.pmkid_attempts, n.deauth_attempts, n.last_method, n.handshake_at,
                  h.session_id, h.cap_file, h.hash_file, h.password, h.cracked
           FROM networks_seen n
           LEFT JOIN handshakes h ON h.bssid = n.bssid AND h.captured_at = (
             SELECT MIN(captured_at) FROM handshakes h2 WHERE h2.bssid = n.bssid)
           ORDER BY n.first_seen DESC
           LIMIT 20000`,
        )
        .all() as HistorialRow[];
      const lines = [
        "MAC,SSID,Canal,Senal_dBm,Latitud,Longitud,HoraCaptura,LugarCaptura,Cifrado,Handshake,Metodo,Intentos,IntentosPMKID,IntentosDeauth,ArchivoHandshake,Session,Crackeada,Contrasena",
      ];
      for (const n of rows) {
        const lugar = n.lat != null && n.lon != null ? `${n.lat.toFixed(6)},${n.lon.toFixed(6)}` : "";
        lines.push(
          [
            n.bssid || "",
            `"${String(n.ssid || "").replace(/"/g, '""')}"`,
            n.channel ?? "",
            n.best_rssi ?? "",
            n.lat != null ? n.lat.toFixed(6) : "",
            n.lon != null ? n.lon.toFixed(6) : "",
            new Date(n.first_seen).toISOString(),
            `"${n.session_id || ""}"`,
            n.security || "",
            n.handshake ? "SI" : "NO",
            n.last_method || "",
            n.attempts || 0,
            n.pmkid_attempts || 0,
            n.deauth_attempts || 0,
            n.handshake ? `"${n.hash_file || n.cap_file || ""}"` : "",
            n.cracked ? "SI" : "",
            n.password ? `"${n.password}"` : "",
          ].join(","),
        );
      }
      return lines.join("\n");
    } catch {
      return "MAC,SSID\n(error leyendo la base de datos)";
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
  bssid: string;
  ssid: string;
  security: string;
  channel: number | null;
  best_rssi: number | null;
  lat: number | null;
  lon: number | null;
  first_seen: number;
  handshake: 0 | 1;
  attempts: number;
  pmkid_attempts: number;
  deauth_attempts: number;
  last_method: string | null;
  hs_method: string | null;
  password: string | null;
  cracked: 0 | 1;
};

export const driveDb = new DriveDb();
export type HistorialRow = {
  bssid: string;
  ssid: string;
  security: string;
  channel: number | null;
  best_rssi: number | null;
  lat: number | null;
  lon: number | null;
  first_seen: number;
  handshake: 0 | 1;
  attempts: number;
  pmkid_attempts: number;
  deauth_attempts: number;
  last_method: string | null;
  handshake_at: number | null;
  session_id: string | null;
  cap_file: string | null;
  hash_file: string | null;
  password: string | null;
  cracked: 0 | 1;
};
