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
