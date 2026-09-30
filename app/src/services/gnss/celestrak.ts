import { proxyFetch } from "../../cloud-api/proxy-fetch";
import { GnssConstellationCode } from "./types";

// CelesTrak GP (General Perturbations) API — public, no key required.
// FORMAT=json returns OMM (Orbit Mean-Elements Message) objects, one per
// satellite in the group. Docs: https://celestrak.org/NORAD/documentation/gp-data-formats.php
const CELESTRAK_BASE = "https://celestrak.org/NORAD/elements/gp.php";

// CelesTrak's own group names for each constellation we can identify from
// NMEA talker prefixes (utils/gps.ts). QZSS/NAVIC are left out: CelesTrak
// has no dedicated group for them and guessing a PRN match from a mixed
// group would be worse than showing nothing.
const CONSTELLATION_GROUP: Partial<Record<GnssConstellationCode, string>> = {
  GPS: "gps-ops",
  GLONASS: "glo-ops",
  GALILEO: "galileo",
  BEIDOU: "beidou",
};

const FETCH_TIMEOUT_MS = 10_000;

export type CelesTrakEntry = {
  noradId: number;
  name: string;
  prn: string | null; // parsed out of OBJECT_NAME when present, e.g. "PRN 13" → "13"
  omm: unknown; // full OMM object, stored as-is
  epoch: string | null;
};

// GPS/Galileo/BeiDou OBJECT_NAME conventions include a "(PRN NN)" or
// "PRN NN" suffix; GLONASS entries generally don't carry a PRN/slot number
// in the name at all, so those come back with prn: null (no fabricated
// match — see service.ts, which only links entries that resolved a PRN).
const PRN_PATTERN = /PRN\s*0*([0-9]{1,2})\b/i;

function extractPrn(name: string): string | null {
  const match = PRN_PATTERN.exec(name);
  return match ? match[1] : null;
}

// Fetches one constellation's whole GP group. Never throws: any failure
// (no internet, DNS, timeout, non-200, bad JSON) resolves to null so
// callers can just skip the refresh and keep serving cached data — this is
// the one function on the "no bloquear la UI" requirement's network edge.
export async function fetchConstellationGroup(
  constellation: GnssConstellationCode,
): Promise<CelesTrakEntry[] | null> {
  const group = CONSTELLATION_GROUP[constellation];
  if (!group) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${CELESTRAK_BASE}?GROUP=${encodeURIComponent(group)}&FORMAT=json`;
    const res = await proxyFetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`[gnss/celestrak] ${group}: HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(body)) return null;

    return body
      .map((omm): CelesTrakEntry | null => {
        const noradId = Number(omm.NORAD_CAT_ID);
        const name = String(omm.OBJECT_NAME ?? "").trim();
        if (!Number.isFinite(noradId) || !name) return null;
        return {
          noradId,
          name,
          prn: extractPrn(name),
          omm,
          epoch: typeof omm.EPOCH === "string" ? omm.EPOCH : null,
        };
      })
      .filter((entry): entry is CelesTrakEntry => entry !== null);
  } catch (err) {
    // Covers abort (timeout), network errors, and JSON parse errors alike —
    // all of them mean "no fresh data this time", never a crash.
    console.warn(`[gnss/celestrak] ${group}: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
