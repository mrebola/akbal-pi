import { getWifiRadarSnapshot } from "../wifiradar/service";
import { WardriveTarget } from "./types";

// Discovery: the wardrive module does NOT run its own scanner — it reads
// the live WIFIRADAR capture (shared WifiRadarService singleton, already
// handling the AR9271, monitor mode and channel hopping) and reshapes its
// snapshot into attack targets. This keeps one radio doing one thing and
// means wardriving always sees the same air picture the radar screens do.
//
// IMPORTANT: everything discovered here is only *displayed*. Attacking
// requires the BSSID to be in the explicit allowlist first — see
// service.ts. There is intentionally no "attack all discovered" path.

// Handshake capture needs a stable, reasonably strong signal. These are
// lab-tuned ordering thresholds, not hard gates: any target can be attacked
// if it's allowlisted, this only drives the "attackable" flag and sort order.
const STRONG_DBM = -55;
const USABLE_DBM = -75;

// Rough RSSI->distance estimate (log-distance path loss, same model as
// utils/wifi.ts). Order-of-magnitude only, not a real measurement.
const RSSI_AT_1M_DBM = -40;
const PATH_LOSS_EXPONENT = 2.7;
function estimateDistanceMeters(dbm: number): number {
  const meters = Math.pow(10, (RSSI_AT_1M_DBM - dbm) / (10 * PATH_LOSS_EXPONENT));
  return Math.round(meters * 10) / 10;
}

export function discoverTargets(): WardriveTarget[] {
  const snapshot = getWifiRadarSnapshot(true);
  const targets: WardriveTarget[] = snapshot.accessPoints.map((ap) => ({
    bssid: ap.bssidFull.toUpperCase(),
    ssid: ap.ssid,
    channel: ap.channel,
    rssi: ap.rssi,
    security: ap.security,
    clients: ap.clients ?? 0,
    distanceMeters: estimateDistanceMeters(ap.rssi),
    inAllowlist: false, // filled in by the service
    attackable: ap.rssi >= USABLE_DBM,
  }));
  return targets.sort((a, b) => {
    const strongDelta = Number(b.rssi >= STRONG_DBM) - Number(a.rssi >= STRONG_DBM);
    if (strongDelta !== 0) return strongDelta;
    return b.rssi - a.rssi;
  });
}