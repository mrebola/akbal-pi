import { getZoneRecent } from "../services/adsb/history";
import { SIGHTING_WINDOW_MS } from "../services/adsb/zone";
import { getWifiRadarSnapshot } from "../wifiradar/service";
import { getGpsStatus } from "../utils/gps";
import { getSystemStats } from "../utils/system-stats";
import { getDriveWardriveService } from "../wardrive/service";
import { toAccessPointRows } from "./ap-rows";
import type { AircraftRow, AccessPointRow, GnssRow, WardriveRow, SystemRow } from "./format";

// Each reader returns structured rows, never tool text. Formatters turn them
// into fixed text, so the numbers come from the services, not from a model.

export const readAircraft = (now: number): AircraftRow[] =>
  getZoneRecent(now - SIGHTING_WINDOW_MS).map((r) => ({
    icao: r.icao,
    callsign: r.callsign,
    registration: r.registration,
    timestamp: r.timestamp,
    altitude: r.altitude,
    speed: r.speed,
  }));

export const readWifi = (query: string): AccessPointRow[] =>
  toAccessPointRows(getWifiRadarSnapshot().accessPoints, query);

export const readGnss = async (): Promise<GnssRow | null> => {
  const g = await getGpsStatus();
  return { hasFix: Boolean(g.hasFix), satellitesUsed: g.satellitesUsed ?? null, hdop: g.hdop ?? null };
};

// The drive status carries distance and points; networks and handshakes live in
// the session summaries, so they stay null here and print as "—".
export const readWardrive = (): WardriveRow | null => {
  const status = getDriveWardriveService().getStatus();
  return {
    active: status.running,
    distanceM: status.session?.distanceMeters ?? null,
    networks: null,
    handshakes: null,
  };
};

export const readSystem = async (now: number): Promise<SystemRow> => {
  const [gps, stats] = await Promise.all([getGpsStatus(), getSystemStats()]);
  return {
    radarMode: getWifiRadarSnapshot().mode,
    gpsFix: Boolean(gps.hasFix),
    clock: new Date(now).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }),
    memUsedPct: stats.ram.percent,
  };
};
