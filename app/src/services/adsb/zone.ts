import { haversineDistanceKm } from "./geo";

export const DEFAULT_SIGHTING_RADIUS_KM = 10;
export const SIGHTING_WINDOW_MS = 24 * 60 * 60 * 1000;

// Radius of the zone around Akbal's position (ADSB_SIGHTING_RADIUS_KM). A bad
// value falls back to the default instead of silently emptying the list.
export const sightingRadiusKm = (): number => {
  const value = parseFloat(process.env.ADSB_SIGHTING_RADIUS_KM || "");
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SIGHTING_RADIUS_KM;
};

// True when the aircraft's reported position is inside the zone. Without a
// known own position there is no zone, so nothing is inside.
export const isInZone = (
  lat: number,
  lon: number,
  own: { lat: number; lon: number } | null,
  radiusKm: number,
): boolean => own !== null && haversineDistanceKm(own.lat, own.lon, lat, lon) <= radiusKm;

// Distance from Akbal to a capture, in km, or null when Akbal's position is not
// known. Stored with each capture so the list can show how far it was.
export const distanceToOwnKm = (
  lat: number,
  lon: number,
  own: { lat: number; lon: number } | null,
): number | null => (own === null ? null : haversineDistanceKm(own.lat, own.lon, lat, lon));
