import { AircraftTracker } from "./aircraft-tracker";
import { RawAdsbMessage } from "./types";

// Feeds the exact same AircraftTracker.ingest() path the real HackRF+dump1090
// pipeline does (see wifiradar/demo-mode.ts for the same idea applied to
// WIFIRADAR) — only the message source is fake. Aircraft fly in a straight
// line at constant speed/heading from a spawn point around Guadalajara (GDL),
// consistent with the wardrive demo mode already using akbal_lab/GDL as its
// fictional location.
const CENTER_LAT = 20.5218; // GDL airport, demo-only reference point
const CENTER_LON = -103.3111;
const KM_PER_DEG_LAT = 111.32;

const AIRLINES = [
  { icaoPrefix: "0D1", callsignPrefix: "VOI" }, // Volaris
  { icaoPrefix: "0D2", callsignPrefix: "AMX" }, // Aeroméxico
  { icaoPrefix: "0D3", callsignPrefix: "VIV" }, // Viva Aerobus
];

function randomIcao(): string {
  const airline = AIRLINES[Math.floor(Math.random() * AIRLINES.length)];
  const suffix = Math.floor(Math.random() * 0xfff)
    .toString(16)
    .padStart(3, "0");
  return `${airline.icaoPrefix}${suffix}`.toUpperCase();
}

type DemoAircraft = {
  icao: string;
  callsign: string;
  lat: number;
  lon: number;
  altitudeFt: number;
  speedKt: number;
  headingDeg: number;
  verticalRateFtMin: number;
  squawk: string;
};

function spawnAircraft(): DemoAircraft {
  const airline = AIRLINES[Math.floor(Math.random() * AIRLINES.length)];
  const distanceKm = 5 + Math.random() * 90;
  const bearing = Math.random() * 360;
  const bearingRad = (bearing * Math.PI) / 180;
  const dLat = (distanceKm * Math.cos(bearingRad)) / KM_PER_DEG_LAT;
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((CENTER_LAT * Math.PI) / 180);
  const dLon = (distanceKm * Math.sin(bearingRad)) / kmPerDegLon;
  return {
    icao: randomIcao(),
    callsign: `${airline.callsignPrefix}${1000 + Math.floor(Math.random() * 8999)}`,
    lat: CENTER_LAT + dLat,
    lon: CENTER_LON + dLon,
    altitudeFt: 3000 + Math.floor(Math.random() * 35000),
    speedKt: 180 + Math.floor(Math.random() * 300),
    headingDeg: Math.random() * 360,
    verticalRateFtMin: Math.floor(Math.random() * 2000) - 1000,
    squawk: String(1000 + Math.floor(Math.random() * 6777)).padStart(4, "0"),
  };
}

export class DemoGenerator {
  private aircraft: DemoAircraft[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private churnTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private tracker: AircraftTracker) {}

  start(): void {
    const count = 4 + Math.floor(Math.random() * 5);
    this.aircraft = Array.from({ length: count }, spawnAircraft);
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.churnTimer = setInterval(() => this.churn(), 20_000);
  }

  private tick(): void {
    const now = Date.now();
    const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((CENTER_LAT * Math.PI) / 180);
    for (const ac of this.aircraft) {
      // Advance position: 1s of flight at speedKt along headingDeg.
      const distanceKm = (ac.speedKt * 1.852) / 3600;
      const headingRad = (ac.headingDeg * Math.PI) / 180;
      ac.lat += (distanceKm * Math.cos(headingRad)) / KM_PER_DEG_LAT;
      ac.lon += (distanceKm * Math.sin(headingRad)) / kmPerDegLon;
      ac.altitudeFt = Math.max(1000, ac.altitudeFt + ac.verticalRateFtMin / 60);

      const identification: RawAdsbMessage = {
        kind: "identification",
        icao: ac.icao,
        timestamp: now,
        callsign: ac.callsign,
      };
      const position: RawAdsbMessage = {
        kind: "position",
        icao: ac.icao,
        timestamp: now,
        altitudeFt: Math.round(ac.altitudeFt),
        latitude: ac.lat,
        longitude: ac.lon,
        onGround: false,
      };
      const velocity: RawAdsbMessage = {
        kind: "velocity",
        icao: ac.icao,
        timestamp: now,
        groundSpeedKt: ac.speedKt,
        trackDeg: ac.headingDeg,
        verticalRateFtMin: ac.verticalRateFtMin,
      };
      this.tracker.ingest(identification);
      this.tracker.ingest(position);
      this.tracker.ingest(velocity);
      if (Math.random() < 0.1) {
        this.tracker.ingest({ kind: "surveillance", icao: ac.icao, timestamp: now, squawk: ac.squawk });
      }
    }
  }

  private churn(): void {
    if (this.aircraft.length < 9 && Math.random() < 0.4) {
      this.aircraft.push(spawnAircraft());
    } else if (this.aircraft.length > 3 && Math.random() < 0.25) {
      // Just stop simulating this aircraft — it ages out and gets pruned
      // by AircraftTracker.sweep(), same as a real one flying out of range.
      this.aircraft.splice(Math.floor(Math.random() * this.aircraft.length), 1);
    }
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.churnTimer) clearInterval(this.churnTimer);
    this.tickTimer = null;
    this.churnTimer = null;
  }
}
