import { getCachedRoute, cacheRoute } from "./history";
import { RouteInfo } from "./types";

// Callsign -> flight number + origin/destination airport, via adsbdb.com's
// free callsign endpoint (no API key). Same cache-first shape as
// aircraft-database.ts. A callsign that doesn't resolve — a general aviation
// tail number, private jet, or one adsbdb.com just doesn't have — reports
// "Route unknown" per spec instead of a guess.
const ADSDB_CALLSIGN_URL = "https://api.adsbdb.com/v0/callsign/";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // routes can change tail/schedule day to day
const REQUEST_TIMEOUT_MS = 5000;
const MIN_REQUEST_INTERVAL_MS = 500;

let lastRequestAt = 0;
let backoffUntil = 0;
const inflight = new Map<string, Promise<RouteInfo>>();

export const ROUTE_UNKNOWN: RouteInfo = {
  flightNumber: null,
  origin: null,
  destination: null,
  originName: null,
  destinationName: null,
};

function onlineLookupEnabled(): boolean {
  return (process.env.ADSB_LOOKUP_ONLINE_ENABLED || "true").toLowerCase() !== "false";
}

type AdsbdbCallsignResponse = {
  response:
    | {
        flightroute: {
          callsign_iata?: string;
          callsign_icao?: string;
          origin?: { icao_code?: string; iata_code?: string; name?: string };
          destination?: { icao_code?: string; iata_code?: string; name?: string };
        };
      }
    | string;
};

// `definitive` distinguishes a genuine "adsbdb has no route for this
// callsign" (404, or a response missing origin/destination) — worth caching
// for the full TTL — from a transient failure (offline/timeout/rate-limited/
// bad JSON), which must NOT be cached long-term: see aircraft-database.ts's
// fetchFromAdsbdb for the same distinction and why it matters.
async function fetchFromAdsbdb(callsign: string): Promise<{ route: RouteInfo; definitive: boolean }> {
  const now = Date.now();
  if (now < backoffUntil) return { route: ROUTE_UNKNOWN, definitive: false };
  const gap = now - lastRequestAt;
  if (gap < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - gap));
  }
  lastRequestAt = Date.now();
  try {
    const res = await fetch(`${ADSDB_CALLSIGN_URL}${callsign}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return { route: ROUTE_UNKNOWN, definitive: true };
    if (!res.ok) {
      backoffUntil = Date.now() + 10_000;
      return { route: ROUTE_UNKNOWN, definitive: false };
    }
    const body = (await res.json()) as AdsbdbCallsignResponse;
    if (typeof body.response === "string") return { route: ROUTE_UNKNOWN, definitive: true };
    const { flightroute } = body.response;
    if (!flightroute.origin || !flightroute.destination) return { route: ROUTE_UNKNOWN, definitive: true };
    return {
      route: {
        flightNumber: flightroute.callsign_iata?.trim() || flightroute.callsign_icao?.trim() || null,
        origin: flightroute.origin.iata_code?.trim() || flightroute.origin.icao_code?.trim() || null,
        destination: flightroute.destination.iata_code?.trim() || flightroute.destination.icao_code?.trim() || null,
        originName: flightroute.origin.name?.trim() || null,
        destinationName: flightroute.destination.name?.trim() || null,
      },
      definitive: true,
    };
  } catch {
    backoffUntil = Date.now() + 10_000;
    return { route: ROUTE_UNKNOWN, definitive: false };
  }
}

export async function resolveRoute(callsign: string): Promise<RouteInfo> {
  const key = callsign.trim().toUpperCase();
  if (!key) return ROUTE_UNKNOWN;

  const cached = getCachedRoute(key);
  if (cached && Date.now() - cached.resolved_at < CACHE_TTL_MS) {
    return {
      flightNumber: cached.flight_number,
      origin: cached.origin,
      destination: cached.destination,
      originName: cached.origin_name,
      destinationName: cached.destination_name,
    };
  }
  if (!onlineLookupEnabled()) return ROUTE_UNKNOWN;

  const existing = inflight.get(key);
  if (existing) return existing;
  const job = (async () => {
    const { route, definitive } = await fetchFromAdsbdb(key);
    if (definitive) cacheRoute(key, route);
    return route;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

// Human-readable route string for display/agent answers — spec's exact
// "Route unknown" fallback wording when either end can't be resolved.
export function formatRoute(route: RouteInfo): string {
  if (!route.origin || !route.destination) return "Route unknown";
  return `${route.origin} → ${route.destination}`;
}
