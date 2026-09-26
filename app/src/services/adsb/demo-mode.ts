import { AircraftTracker } from "./aircraft-tracker";
import { RawAdsbMessage } from "./types";
import { getGpsStatus } from "../../utils/gps";

// Feeds the exact same AircraftTracker.ingest() path the real HackRF+dump1090
// pipeline does (see wifiradar/demo-mode.ts for the same idea applied to
// WIFIRADAR) — only the message source is fake. Aircraft fly in a straight
// line at constant speed/heading from a spawn point around Akbal's own
// current position (real GPS fix if there is one, GPS's own demo fix if
// that's what's active, falling back to Guadalajara/GDL — consistent with
// the wardrive demo mode's akbal_lab/GDL fictional location — only when
// there's no GPS position at all).
//
// Centering on GPS_DEFAULT unconditionally used to be the bug here: GPS's
// own demo mode defaults to a fix in Mexico City (utils/gps.ts's DEMO_FIX),
// ~450km from GDL. AircraftTracker.updatePosition() computes each
// aircraft's distance/bearing from Akbal's *actual* reported position, so
// a demo GPS fix in CDMX + aircraft scattered 5-90km around a hardcoded
// GDL center meant every aircraft was ~450km away — past the radar's
// 100km outer ring, so every point clamped to the same max radius, and all
// within the same ~10° angular sliver (a 90km-wide cluster viewed from
// 450km away subtends a narrow angle) — exactly the "all in a line"
// symptom. Centering the spawn point on wherever Akbal currently reports
// itself (whatever that source is) keeps the two consistent no matter
// which demo/live combination is active.
const GDL_DEFAULT = { lat: 20.5218, lon: -103.3111 }; // GDL airport, last-resort fallback
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

function spawnAircraft(center: { lat: number; lon: number }): DemoAircraft {
  const airline = AIRLINES[Math.floor(Math.random() * AIRLINES.length)];
  const distanceKm = 5 + Math.random() * 90;
  const bearing = Math.random() * 360;
  const bearingRad = (bearing * Math.PI) / 180;
  const dLat = (distanceKm * Math.cos(bearingRad)) / KM_PER_DEG_LAT;
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180);
  const dLon = (distanceKm * Math.sin(bearingRad)) / kmPerDegLon;
  return {
    icao: randomIcao(),
    callsign: `${airline.callsignPrefix}${1000 + Math.floor(Math.random() * 8999)}`,
    lat: center.lat + dLat,
    lon: center.lon + dLon,
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
  private center = GDL_DEFAULT;

  constructor(private tracker: AircraftTracker) {}

  async start(): Promise<void> {
    try {
      const gps = await getGpsStatus();
      if (gps.latitude != null && gps.longitude != null) {
        this.center = { lat: gps.latitude, lon: gps.longitude };
      }
    } catch {
      // stay on GDL_DEFAULT
    }
    const count = 4 + Math.floor(Math.random() * 5);
    this.aircraft = Array.from({ length: count }, () => spawnAircraft(this.center));
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.churnTimer = setInterval(() => this.churn(), 20_000);
  }

  private tick(): void {
    const now = Date.now();
    const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((this.center.lat * Math.PI) / 180);
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
      this.aircraft.push(spawnAircraft(this.center));
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
