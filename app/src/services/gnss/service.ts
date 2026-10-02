import { EventEmitter } from "events";
import { getGpsStatus } from "../../utils/gps";
import { fetchConstellationGroup, fetchSatcatRecord } from "./celestrak";
import {
  getOrbitalData,
  getSatcatData,
  getSatelliteMetadata,
  getUnresolvedPrns,
  isOrbitalStale,
  isSatcatStale,
  pruneOldObservations,
  recordObservation,
  setSatelliteIdentity,
  touchSatelliteSeen,
  upsertOrbitalData,
  upsertSatcatData,
} from "./db";
import { GnssConstellationCode, GnssSatelliteView, GnssSnapshot } from "./types";

// Orchestrates GNSS satellite metadata end to end (docs/gnss.md):
//   1. Read live PRN/constellation/SNR/az/el from the same NMEA adapter the
//      GPS page uses (utils/gps.ts) — same shape as AircraftRadarService
//      reading utils/gps.ts for position (services/adsb/service.ts).
//   2. Look up cached identity/orbital data in SQLite (db.ts).
//   3. If a PRN has no cached identity, or its orbital data is older than
//      REFRESH_MAX_AGE_MS, kick a background CelesTrak refresh — fire and
//      forget, the snapshot returned to callers never waits on it.
//   4. Record a historical observation per satellite per sweep.
// Offline (no internet) or CelesTrak errors just mean the refresh attempt
// fails silently (celestrak.ts never throws) and cached data keeps serving.

const SWEEP_INTERVAL_MS = 5_000;
// GPS almanacs/orbits are usable for days; CelesTrak itself only republishes
// GP data every few hours, so refreshing more than once a day per
// constellation would just hammer the API for no new information.
const REFRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Don't retry a constellation whose last refresh attempt failed (offline,
// DNS, etc.) more than once per this window — avoids a refresh attempt on
// every single 5s sweep while there's no internet.
const REFRESH_RETRY_MS = 5 * 60 * 1000;
const OBSERVATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// SATCAT facts (owner, launch date/site) are effectively permanent once a
// satellite is in service — nowhere near the orbital elements' churn, so
// this refreshes on a much longer cadence (catches a rare status/decay
// update without re-querying CelesTrak for something that almost never
// changes).
const SATCAT_REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// SATCAT has no bulk-by-constellation endpoint (unlike GP) — one HTTP call
// per satellite, so cap how many a single sweep's refresh pass fires.
const SATCAT_MAX_PER_SWEEP = 3;

class GnssService extends EventEmitter {
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private refreshInFlight = new Set<GnssConstellationCode>();
  private satcatInFlight = new Set<number>();
  private lastRefreshAttemptByConstellation = new Map<GnssConstellationCode, number>();
  private lastSnapshot: GnssSnapshot = {
    present: false,
    satellites: [],
    cacheOnly: true,
    lastRefreshAttempt: null,
    lastRefreshOk: null,
    lastRefreshError: null,
  };

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.pruneTimer = setInterval(
      () => pruneOldObservations(OBSERVATION_RETENTION_MS),
      PRUNE_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.sweepTimer = null;
    this.pruneTimer = null;
    this.started = false;
  }

  getSnapshot(): GnssSnapshot {
    return this.lastSnapshot;
  }

  private async sweep(): Promise<void> {
    const gps = await getGpsStatus();
    const now = Date.now();
    const seenConstellations = new Set<GnssConstellationCode>();

    const satellites: GnssSatelliteView[] = gps.satellites.map((sat) => {
      const constellation = sat.constellation ?? "UNKNOWN";
      seenConstellations.add(constellation);

      touchSatelliteSeen(constellation, sat.prn);
      recordObservation({
        timestamp: now,
        constellation,
        prn: sat.prn,
        snr: sat.snr,
        azimuth: sat.azimuth,
        elevation: sat.elevation,
        used: sat.used,
      });

      const meta = getSatelliteMetadata(constellation, sat.prn);
      const orbital = meta?.noradId ? getOrbitalData(meta.noradId) : null;
      const satcat = meta?.noradId ? getSatcatData(meta.noradId) : null;

      return {
        constellation,
        prn: sat.prn,
        elevation: sat.elevation,
        azimuth: sat.azimuth,
        snr: sat.snr,
        used: sat.used,
        metadata: meta ? { noradId: meta.noradId, name: meta.name } : null,
        orbital: orbital
          ? {
              epoch: orbital.epoch,
              fetchedAt: orbital.fetchedAt,
              ageMs: now - orbital.fetchedAt,
              omm: JSON.parse(orbital.ommJson),
            }
          : null,
        satcat,
      };
    });

    this.lastSnapshot = {
      present: gps.present,
      satellites,
      cacheOnly: false,
      lastRefreshAttempt: this.lastSnapshot.lastRefreshAttempt,
      lastRefreshOk: this.lastSnapshot.lastRefreshOk,
      lastRefreshError: this.lastSnapshot.lastRefreshError,
    };
    this.emit("update", this.lastSnapshot);

    // Background refresh, never awaited by the caller of getSnapshot()/sweep().
    for (const constellation of seenConstellations) {
      if (constellation === "UNKNOWN") continue;
      void this.maybeRefresh(constellation);
    }
    this.maybeRefreshSatcat(satellites);
  }

  // SATCAT: one HTTP call per NORAD id (no bulk endpoint), so this only
  // fires for satellites actually in view right now, capped per sweep, and
  // skips anything already in flight or fetched within SATCAT_REFRESH_MAX_AGE_MS.
  private maybeRefreshSatcat(satellites: GnssSatelliteView[]): void {
    let fired = 0;
    for (const sat of satellites) {
      if (fired >= SATCAT_MAX_PER_SWEEP) return;
      const noradId = sat.metadata?.noradId;
      if (!noradId || this.satcatInFlight.has(noradId)) continue;
      if (!isSatcatStale(noradId, SATCAT_REFRESH_MAX_AGE_MS)) continue;

      fired++;
      this.satcatInFlight.add(noradId);
      void fetchSatcatRecord(noradId)
        .then((record) => {
          if (record) upsertSatcatData(record);
        })
        .finally(() => this.satcatInFlight.delete(noradId));
    }
  }

  private async maybeRefresh(constellation: GnssConstellationCode): Promise<void> {
    if (this.refreshInFlight.has(constellation)) return;

    const unresolved = getUnresolvedPrns(constellation);
    const needsIdentity = unresolved.length > 0;
    const needsOrbitalRefresh = !needsIdentity && this.anyOrbitalStale(constellation);
    if (!needsIdentity && !needsOrbitalRefresh) return;

    const lastAttempt = this.lastRefreshAttemptByConstellation.get(constellation) ?? 0;
    if (Date.now() - lastAttempt < REFRESH_RETRY_MS) return;

    this.refreshInFlight.add(constellation);
    this.lastRefreshAttemptByConstellation.set(constellation, Date.now());
    this.lastSnapshot = { ...this.lastSnapshot, lastRefreshAttempt: Date.now() };

    try {
      const entries = await fetchConstellationGroup(constellation);
      if (!entries) {
        this.lastSnapshot = {
          ...this.lastSnapshot,
          lastRefreshOk: false,
          lastRefreshError: "sin conexión o CelesTrak no disponible",
        };
        return;
      }

      const byPrn = new Map(entries.filter((e) => e.prn).map((e) => [e.prn as string, e]));
      for (const { prn } of unresolved) {
        const entry = byPrn.get(prn.replace(/^0+/, "") || "0");
        if (!entry) continue;
        setSatelliteIdentity(constellation, prn, entry.noradId, entry.name);
        upsertOrbitalData({
          noradId: entry.noradId,
          ommJson: JSON.stringify(entry.omm),
          epoch: entry.epoch,
          fetchedAt: Date.now(),
          source: "celestrak",
        });
      }

      // Refresh orbital data for already-identified satellites too, keyed
      // by NORAD id (independent of PRN matching above).
      for (const entry of entries) {
        if (isOrbitalStale(entry.noradId, REFRESH_MAX_AGE_MS)) {
          upsertOrbitalData({
            noradId: entry.noradId,
            ommJson: JSON.stringify(entry.omm),
            epoch: entry.epoch,
            fetchedAt: Date.now(),
            source: "celestrak",
          });
        }
      }

      this.lastSnapshot = { ...this.lastSnapshot, lastRefreshOk: true, lastRefreshError: null };
    } catch (err) {
      // fetchConstellationGroup already swallows its own errors, but keep
      // this as a hard backstop so a background refresh can never take the
      // sweep loop down with it.
      this.lastSnapshot = {
        ...this.lastSnapshot,
        lastRefreshOk: false,
        lastRefreshError: (err as Error).message,
      };
    } finally {
      this.refreshInFlight.delete(constellation);
    }
  }

  private anyOrbitalStale(constellation: GnssConstellationCode): boolean {
    // Cheap heuristic: if we have zero identified satellites for this
    // constellation there's nothing to check staleness against — that
    // case is already covered by needsIdentity above via getUnresolvedPrns.
    const view = this.lastSnapshot.satellites.filter((s) => s.constellation === constellation);
    if (view.length === 0) return false;
    return view.some((s) => !s.orbital || s.orbital.ageMs > REFRESH_MAX_AGE_MS);
  }
}

const sharedGnssService = new GnssService();

export function startGnssService(): void {
  void sharedGnssService.start();
}

export function stopGnssService(): void {
  sharedGnssService.stop();
}

export function getGnssSnapshot(): GnssSnapshot {
  return sharedGnssService.getSnapshot();
}

export { getRecentObservations as getGnssHistory } from "./db";
