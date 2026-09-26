import { getCachedAircraftLookup, cacheAircraftLookup } from "./history";
import { AircraftIdentity } from "./types";

// ICAO24 -> registration/manufacturer/model/operator. Order of resolution:
// SQLite cache (history.ts's aircraft_lookup_cache — "base de datos local"
// once an ICAO has been seen before) -> adsbdb.com (free, no API key, opt-in
// via ADSB_LOOKUP_ONLINE_ENABLED). Same shape as wifiradar/oui.ts's
// curated-table -> macvendors.com resolution, minus the curated table: there
// is no small offline set of real tail-number registrations worth bundling
// (unlike a few thousand MAC OUI prefixes), so a fresh ICAO with no internet
// simply stays unresolved instead of guessing.
const ADSDB_AIRCRAFT_URL = "https://api.adsbdb.com/v0/aircraft/";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // registrations essentially never change
const REQUEST_TIMEOUT_MS = 5000;
const MIN_REQUEST_INTERVAL_MS = 500; // be a polite anonymous client, no key to rate-limit by

let lastRequestAt = 0;
let backoffUntil = 0;
const inflight = new Map<string, Promise<AircraftIdentity>>();

const UNRESOLVED: AircraftIdentity = {
  registration: null,
  manufacturer: null,
  model: null,
  operator: null,
  resolved: false,
};

function onlineLookupEnabled(): boolean {
  return (process.env.ADSB_LOOKUP_ONLINE_ENABLED || "true").toLowerCase() !== "false";
}

type AdsbdbAircraftResponse = {
  response:
    | {
        aircraft: {
          type?: string;
          manufacturer?: string;
          registration?: string;
          registered_owner?: string;
        };
      }
    | string;
};

async function fetchFromAdsbdb(icao: string): Promise<AircraftIdentity> {
  const now = Date.now();
  if (now < backoffUntil) return UNRESOLVED;
  const gap = now - lastRequestAt;
  if (gap < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - gap));
  }
  lastRequestAt = Date.now();
  try {
    const res = await fetch(`${ADSDB_AIRCRAFT_URL}${icao}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return UNRESOLVED;
    if (!res.ok) {
      backoffUntil = Date.now() + 10_000;
      return UNRESOLVED;
    }
    const body = (await res.json()) as AdsbdbAircraftResponse;
    if (typeof body.response === "string") return UNRESOLVED;
    const { aircraft } = body.response;
    return {
      registration: aircraft.registration?.trim() || null,
      manufacturer: aircraft.manufacturer?.trim() || null,
      model: aircraft.type?.trim() || null,
      operator: aircraft.registered_owner?.trim() || null,
      resolved: true,
    };
  } catch {
    // offline / timeout / bad JSON — back off briefly, stay silent. Never
    // invent identity fields: caller gets UNRESOLVED, not a guess.
    backoffUntil = Date.now() + 10_000;
    return UNRESOLVED;
  }
}

// Resolves an ICAO24 to its aircraft identity. Never invents data: an
// unresolved lookup returns nulls (resolved: false), which the UI/agent
// render as "desconocido" rather than a fabricated registration or model.
export async function resolveAircraftIdentity(icao: string): Promise<AircraftIdentity> {
  const key = icao.toUpperCase();
  const cached = getCachedAircraftLookup(key);
  if (cached && Date.now() - cached.resolved_at < CACHE_TTL_MS) {
    return {
      registration: cached.registration,
      manufacturer: cached.manufacturer,
      model: cached.model,
      operator: cached.operator,
      resolved: Boolean(cached.registration || cached.manufacturer || cached.model || cached.operator),
    };
  }
  if (!onlineLookupEnabled()) return cached ? { ...UNRESOLVED } : UNRESOLVED;

  const existing = inflight.get(key);
  if (existing) return existing;
  const job = (async () => {
    const identity = await fetchFromAdsbdb(key);
    cacheAircraftLookup(key, {
      registration: identity.registration,
      manufacturer: identity.manufacturer,
      model: identity.model,
      operator: identity.operator,
    });
    return identity;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
