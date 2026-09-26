import { Aircraft, AircraftRadarMode, AircraftRadarSnapshot, RawAdsbMessage } from "./types";
import { haversineDistanceKm, initialBearingDeg } from "./geo";
import { recordAircraftSeen } from "./history";
import { resolveAircraftIdentity } from "./aircraft-database";
import { resolveRoute } from "./flight-resolver";

const AIRCRAFT_PRUNE_MS = 5 * 60_000; // drop from memory 5 min after last message
const MESSAGE_RATE_WINDOW_MS = 60_000;
// One aircraft_seen row per aircraft per this window at most — a real
// aircraft can send a position update every second or so, and logging every
// single one would grow the SQLite file fast for no analytical benefit.
const HISTORY_WRITE_INTERVAL_MS = 10_000;

// Owns all in-memory Aircraft Radar state — same role as
// wifiradar/aggregator.ts's Aggregator, fed identically by
// hackrf-receiver.ts (real dump1090 messages) or demo-mode.ts (synthetic
// ones) through ingest(). No disk I/O here; history.ts (SQLite) is a
// separate, explicit write from whoever calls ingest(), not something this
// class does itself.
export class AircraftTracker {
  private aircraft = new Map<string, Aircraft>(); // key: icao
  private messageTimestamps: number[] = [];
  private lastHistoryWriteAt = new Map<string, number>();
  private identityRequested = new Set<string>(); // icao
  private routeRequestedFor = new Map<string, string>(); // icao -> callsign already resolved/in flight

  reset(): void {
    this.aircraft.clear();
    this.messageTimestamps = [];
    this.lastHistoryWriteAt.clear();
    this.identityRequested.clear();
    this.routeRequestedFor.clear();
  }

  // Fire-and-forget: resolveAircraftIdentity/resolveRoute (aircraft-database.ts,
  // flight-resolver.ts) hit their SQLite cache first and adsbdb.com only on a
  // miss, so this is cheap for aircraft already seen before. Mutates the
  // Aircraft object in place once the promise settles — safe even if the
  // aircraft got pruned by sweep() meanwhile (mutating a detached object is
  // harmless, just doesn't show up in any future snapshot).
  private requestIdentity(aircraft: Aircraft): void {
    if (this.identityRequested.has(aircraft.icao)) return;
    this.identityRequested.add(aircraft.icao);
    void resolveAircraftIdentity(aircraft.icao).then((identity) => {
      aircraft.registration = identity.registration;
      aircraft.manufacturer = identity.manufacturer;
      aircraft.model = identity.model;
      aircraft.operator = identity.operator;
    });
  }

  private requestRoute(aircraft: Aircraft, callsign: string): void {
    if (this.routeRequestedFor.get(aircraft.icao) === callsign) return;
    this.routeRequestedFor.set(aircraft.icao, callsign);
    void resolveRoute(callsign).then((route) => {
      aircraft.flightNumber = route.flightNumber;
      aircraft.origin = route.origin;
      aircraft.destination = route.destination;
    });
  }

  private getOrCreate(icao: string, timestamp: number): Aircraft {
    let existing = this.aircraft.get(icao);
    if (!existing) {
      existing = {
        icao,
        callsign: null,
        registration: null,
        manufacturer: null,
        model: null,
        operator: null,
        flightNumber: null,
        origin: null,
        destination: null,
        altitudeFt: null,
        speedKt: null,
        headingDeg: null,
        verticalRateFtMin: null,
        squawk: null,
        onGround: false,
        latitude: null,
        longitude: null,
        distanceKm: null,
        bearingDeg: null,
        approaching: null,
        firstSeen: timestamp,
        lastSeen: timestamp,
      };
      this.aircraft.set(icao, existing);
    }
    return existing;
  }

  // Each SBS message type only carries a slice of an aircraft's state
  // (identification -> callsign, position -> alt/lat/lon, velocity ->
  // speed/heading/vrate, surveillance -> alt/squawk) — ingest() merges
  // whatever this message brought into the existing record instead of
  // replacing it, same "narrow union, merge don't replace" shape as
  // wifiradar/aggregator.ts's ingestApFrame.
  ingest(msg: RawAdsbMessage): void {
    this.messageTimestamps.push(msg.timestamp);
    const cutoff = msg.timestamp - MESSAGE_RATE_WINDOW_MS;
    while (this.messageTimestamps.length && this.messageTimestamps[0] < cutoff) this.messageTimestamps.shift();

    const aircraft = this.getOrCreate(msg.icao, msg.timestamp);
    aircraft.lastSeen = msg.timestamp;
    this.requestIdentity(aircraft);

    if (msg.callsign !== undefined) {
      aircraft.callsign = msg.callsign;
      this.requestRoute(aircraft, msg.callsign);
    }
    if (msg.altitudeFt !== undefined) aircraft.altitudeFt = msg.altitudeFt;
    if (msg.latitude !== undefined) aircraft.latitude = msg.latitude;
    if (msg.longitude !== undefined) aircraft.longitude = msg.longitude;
    if (msg.groundSpeedKt !== undefined) aircraft.speedKt = msg.groundSpeedKt;
    if (msg.trackDeg !== undefined) aircraft.headingDeg = msg.trackDeg;
    if (msg.verticalRateFtMin !== undefined) aircraft.verticalRateFtMin = msg.verticalRateFtMin;
    if (msg.squawk !== undefined) aircraft.squawk = msg.squawk;
    if (msg.onGround !== undefined) aircraft.onGround = msg.onGround;

    // Only a position message actually changes what aircraft_seen records
    // (lat/lon) — logging on every identification/velocity message too
    // would just repeat the same position with a different timestamp.
    if (msg.kind === "position" && msg.latitude !== undefined && msg.longitude !== undefined) {
      const lastWrite = this.lastHistoryWriteAt.get(msg.icao) || 0;
      if (msg.timestamp - lastWrite >= HISTORY_WRITE_INTERVAL_MS) {
        this.lastHistoryWriteAt.set(msg.icao, msg.timestamp);
        recordAircraftSeen(aircraft);
      }
    }
  }

  // Called periodically (see service.ts) to prune aircraft that stopped
  // transmitting, so memory stays flat over a long uptime.
  sweep(): void {
    const now = Date.now();
    for (const [icao, aircraft] of this.aircraft) {
      if (now - aircraft.lastSeen > AIRCRAFT_PRUNE_MS) {
        this.aircraft.delete(icao);
        this.lastHistoryWriteAt.delete(icao);
      }
    }
  }

  // Recomputes distance/bearing/approaching for every aircraft against
  // Akbal's current GPS fix (utils/gps.ts) — called on a timer from
  // service.ts, not per-message, since a GPS fix barely moves between two
  // ADS-B messages a few hundred ms apart. null lat/lon (no fix yet) clears
  // these back to null instead of leaving stale numbers on screen.
  updatePosition(gpsLat: number | null, gpsLon: number | null): void {
    for (const aircraft of this.aircraft.values()) {
      if (gpsLat === null || gpsLon === null || aircraft.latitude === null || aircraft.longitude === null) {
        aircraft.distanceKm = null;
        aircraft.bearingDeg = null;
        aircraft.approaching = null;
        continue;
      }
      const distance = haversineDistanceKm(gpsLat, gpsLon, aircraft.latitude, aircraft.longitude);
      const bearing = initialBearingDeg(gpsLat, gpsLon, aircraft.latitude, aircraft.longitude);
      aircraft.approaching = aircraft.distanceKm === null ? null : distance < aircraft.distanceKm;
      aircraft.distanceKm = distance;
      aircraft.bearingDeg = bearing;
    }
  }

  getAll(): Aircraft[] {
    return [...this.aircraft.values()];
  }

  getByIcao(icao: string): Aircraft | null {
    return this.aircraft.get(icao.toUpperCase()) || null;
  }

  getSnapshot(mode: AircraftRadarMode, demo: boolean, hardware: string | null): AircraftRadarSnapshot {
    const now = Date.now();
    const messagesPerMinute = this.messageTimestamps.filter((t) => t > now - MESSAGE_RATE_WINDOW_MS).length;
    const aircraft = [...this.aircraft.values()].sort((a, b) => {
      if (a.distanceKm === null && b.distanceKm === null) return 0;
      if (a.distanceKm === null) return 1;
      if (b.distanceKm === null) return -1;
      return a.distanceKm - b.distanceKm;
    });
    return { mode, demo, hardware, messagesPerMinute, aircraft };
  }
}
