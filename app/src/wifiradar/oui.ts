import fs from "fs";

// Small curated OUI (MAC vendor prefix) table — the lightweight fallback for
// when ieee-data isn't installed. The full IEEE registry (35k entries, loaded
// once from /usr/share/ieee-data/oui.csv) takes priority below when present.
const OUI_TABLE: Record<string, string> = {
  "00:1A:11": "Google",
  "3C:5A:B4": "Google",
  "F4:F5:D8": "Google",
  "A4:77:33": "Google",
  "00:17:88": "Philips",
  "B8:27:EB": "Raspberry Pi Foundation",
  "DC:A6:32": "Raspberry Pi Foundation",
  "D8:3A:DD": "Raspberry Pi Foundation",
  "E4:5F:01": "Raspberry Pi Foundation",
  "28:CD:C1": "Raspberry Pi Foundation",
  "00:0C:CA": "Qualcomm Atheros",
  "00:03:7F": "Qualcomm Atheros",
  "00:1D:D9": "Cisco",
  "00:1B:D4": "Cisco",
  "00:26:99": "Cisco",
  "F4:CF:E2": "Ubiquiti",
  "24:5A:4C": "Ubiquiti",
  "78:8A:20": "Ubiquiti",
  "DC:9F:DB": "Ubiquiti",
  "B0:19:21": "Cambium/other AP",
  "90:16:BA": "AVM (FRITZ!Box)",
  "54:13:10": "AVM (FRITZ!Box)",
  "0C:67:14": "Starlink (SpaceX)",
  "38:EB:47": "TP-Link",
  "50:C7:BF": "TP-Link",
  "AC:84:C6": "TP-Link",
  "D0:21:F9": "Ruckus/CommScope",
  "DA:21:F9": "Ruckus/CommScope",
  "00:04:EA": "Direct Networks",
  "3C:52:82": "Amazon",
  "68:37:E9": "Amazon",
  "F0:27:2D": "Amazon",
  "AC:63:BE": "Apple",
  "A4:83:E7": "Apple",
  "3C:15:C2": "Apple",
  "F0:18:98": "Apple",
  "88:A2:9E": "Apple",
  "00:C0:CA": "Alfa Network (Atheros AR9271)",
  "34:C6:DD": "EZVIZ",
  "00:1D:0F": "TCT Mobile",
  "F8:8F:CA": "Samsung",
  "5C:0A:5B": "Samsung",
  "8C:79:F5": "Samsung",
  "00:16:6C": "Samsung",
  "B4:0E:DC": "Huawei",
  "00:E0:FC": "Huawei",
  "18:65:C7": "Quantenna/ON Semi",
};

export function lookupVendor(mac: string): string {
  const prefix = mac.toUpperCase().slice(0, 8);
  return OUI_TABLE[prefix] || "Desconocido";
}

// ─── Full IEEE registry (ieee-data) ────────────────────────────────────────
// Debian's ieee-data package ships the complete OUI list as a CSV
// (/usr/share/ieee-data/oui.csv, ~35k MA-L rows). Parsed ONCE into a dict —
// ~0.1s startup, a few MB RAM, then every lookup is a plain dict hit. Zero
// subprocesses, zero per-query cost. When the file is missing the curated
// table above covers the common cases.
const IEEE_OUI_CSV = "/usr/share/ieee-data/oui.csv";
let ieeeRegistry: Map<string, string> | null = null;
let ieeeTried = false;

function loadIeeeRegistry(): Map<string, string> | null {
  if (ieeeTried) return ieeeRegistry;
  ieeeTried = true;
  try {
    const raw = fs.readFileSync(IEEE_OUI_CSV, "utf8");
    const map = new Map<string, string>();
    // Header: Registry,Assignment,Organization Name,Organization Address
    const lines = raw.split("\n");
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // CSV rows may contain quoted commas (addresses) — parse minimally:
      // the assignment is always the 2nd field, the org name the 3rd.
      // Split on ", " boundaries respecting quotes.
      const m = /^MA-L,([0-9A-Fa-f]{6}),("(?:[^"]|"")*"|[^,]*),/.exec(line);
      if (!m) continue;
      let org = m[2];
      if (org.startsWith('"')) org = org.slice(1, -1).replace(/""/g, '"');
      org = org.trim();
      if (org) map.set(m[1].toUpperCase(), org);
    }
    if (map.size > 0) ieeeRegistry = map;
  } catch {
    // ieee-data not installed — curated table only.
  }
  return ieeeRegistry;
}

// Trim unwieldy registry names ("TP-LINK TECHNOLOGIES CO.,LTD." → short and
// readable) — the registry ships legal entity names, not product brands.
function prettifyOrg(org: string): string {
  const trimmed = org
    .replace(/\s*,\s*$/, "")
    .replace(/\b(incorporated|inc|limited|ltd|llc|corporation|corp|gmbh|holdings|pte|pty)\b[.,\s]*$/gi, "")
    .replace(/\bco\.?\s*(ltd|ltd\.?)\b[.,\s]*$/gi, "")
    .replace(/\bco\b[.,\s]*$/gi, "")
    .replace(/,\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  // Title-case ALL-CAPS entries ("INGRAM MICRO SERVICES" style); keep mixed
  // case as-is ("Apple, Inc." style). Capitalize after hyphens too so
  // "TP-LINK" → "Tp-Link" instead of "Tp-link".
  if (trimmed === trimmed.toUpperCase() && trimmed.length > 3) {
    return trimmed
      .toLowerCase()
      .replace(/(^|[\s\-])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
  }
  return trimmed;
}

// Full-registry vendor lookup: ieee-data first (35k entries), curated table
// as fallback for prefixes the registry doesn't cover.
export function lookupVendorFull(mac: string): string {
  const reg = loadIeeeRegistry();
  if (reg) {
    const clean = mac.replace(/[:\-]/g, "").toUpperCase();
    const org = clean.length >= 6 ? reg.get(clean.slice(0, 6)) : undefined;
    if (org) return prettifyOrg(org);
  }
  return lookupVendor(mac);
}

// Locally-administered MAC → the second-least-significant bit of the first
// octet set. Apple/Android/Windows randomize probe frames this way; when
// set, an OUI lookup is meaningless (the prefix was random) — callers should
// label the device "Random MAC" instead of showing a vendor that isn't real.
export function isRandomizedMac(mac: string): boolean {
  const first = parseInt(mac.split(":")[0] || "", 16);
  if (Number.isNaN(first)) return false;
  return Boolean(first & 0b10);
}

// Vendor label with randomization awareness: real OUI vendor, or the
// "Random MAC" marker when the locally-administered bit is set (and the OUI
// then says nothing useful about who made the device).
export function lookupVendorOrRandom(mac: string): { vendor: string; random: boolean } {
  if (isRandomizedMac(mac)) {
    const vendor = lookupVendorFull(mac);
    return { vendor: vendor !== "Desconocido" ? `${vendor} (Random MAC)` : "Random MAC", random: true };
  }
  return { vendor: lookupVendorFull(mac), random: false };
}

// ─── macvendors.com API (last-resort remote fallback) ─────────────────────
// Order of resolution: ieee-data registry → curated table → macvendors API.
// The API covers prefixes the local sources miss (e.g. an outdated on-device
// ieee-data). Opt-in via MACVENDORS_API_KEY in .env — without the key this
// layer is inert and lookups stay 100% local/offline. Key belongs to whoever
// deploys the device (free plan at macvendors.com); it is never hardcoded.
const MACVENDORS_URL = "https://api.macvendors.com/v1/lookup/";
const MACVENDORS_TTL_MS = 24 * 60 * 60 * 1000; // prefixes never change owner
const MACVENDORS_NEG_TTL_MS = 60 * 60 * 1000; // remember 404s for 1h
const MACVENDORS_MIN_INTERVAL_MS = 1200; // free plan ~1 req/s, stay under it

const apiCache = new Map<string, { vendor: string | null; at: number }>();
let apiBackoffUntil = 0;
let apiLastRequestAt = 0;
const apiInflight = new Map<string, Promise<string | null>>();

function getMacvendorsKey(): string | undefined {
  const key = process.env.MACVENDORS_API_KEY?.trim();
  return key ? key : undefined;
}

async function fetchMacvendors(cleanMac: string): Promise<string | null> {
  const key = getMacvendorsKey();
  if (!key) return null;
  const now = Date.now();

  const cached = apiCache.get(cleanMac);
  if (cached) {
    const ttl = cached.vendor === null ? MACVENDORS_NEG_TTL_MS : MACVENDORS_TTL_MS;
    if (now - cached.at < ttl) return cached.vendor;
    apiCache.delete(cleanMac);
  }
  if (now < apiBackoffUntil) return null;

  // Serialize requests: the free plan throttles hard (429 within a second),
  // so space calls out instead of hammering from concurrent lookups.
  const gap = now - apiLastRequestAt;
  if (gap < MACVENDORS_MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MACVENDORS_MIN_INTERVAL_MS - gap));
  }

  const existing = apiInflight.get(cleanMac);
  if (existing) return existing;
  const job = (async () => {
    apiLastRequestAt = Date.now();
    try {
      const res = await fetch(`${MACVENDORS_URL}${cleanMac}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 429) {
        apiBackoffUntil = Date.now() + 30_000;
        return null;
      }
      if (res.status === 404) {
        apiCache.set(cleanMac, { vendor: null, at: Date.now() });
        return null;
      }
      if (!res.ok) {
        apiBackoffUntil = Date.now() + 10_000;
        return null;
      }
      const body = (await res.json()) as { data?: { organization_name?: string } };
      const org = body.data?.organization_name?.trim();
      const vendor = org ? prettifyOrg(org) : null;
      apiCache.set(cleanMac, { vendor, at: Date.now() });
      return vendor;
    } catch {
      // offline / timeout / bad JSON — back off briefly, stay silent
      apiBackoffUntil = Date.now() + 10_000;
      return null;
    } finally {
      apiInflight.delete(cleanMac);
    }
  })();
  apiInflight.set(cleanMac, job);
  return job;
}

// lookupVendorFullAsync: like lookupVendorFull, but when local sources miss
// and MACVENDORS_API_KEY is set, queries the API (cached, rate-limited).
// Callers that already run async (wardrive target refresh, web handlers)
// should prefer this so unknown vendors resolve over time.
export async function lookupVendorFullAsync(mac: string): Promise<string> {
  const local = lookupVendorFull(mac);
  if (local !== "Desconocido") return local;
  if (!getMacvendorsKey()) return local;
  if (isRandomizedMac(mac)) return local; // a remote lookup is just as fake
  const clean = mac.replace(/[:\-]/g, "").toUpperCase();
  if (clean.length < 6) return local;
  const remote = await fetchMacvendors(clean.slice(0, 6));
  return remote ?? local;
}

export function macvendorsEnabled(): boolean {
  return Boolean(getMacvendorsKey());
}

// Randomization-aware async variant (mirrors lookupVendorOrRandom).
export async function lookupVendorOrRandomAsync(mac: string): Promise<{ vendor: string; random: boolean }> {
  const vendor = await lookupVendorFullAsync(mac);
  if (isRandomizedMac(mac)) {
    return { vendor: vendor !== "Desconocido" ? `${vendor} (Random MAC)` : "Random MAC", random: true };
  }
  return { vendor, random: false };
}
