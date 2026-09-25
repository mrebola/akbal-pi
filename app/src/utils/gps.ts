import { execFile, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs";

const execFileAsync = promisify(execFile);

// GPS dongle position (docs/gps.md): a USB GNSS receiver (u-blox and clones,
// /dev/ttyACM0|ttyUSB0) streaming NMEA sentences. We don't require the gpsd
// daemon: gpspipe -r taps gpsd when it runs and reads the serial device
// directly otherwise — one code path for both setups. The device keeps
// running so the web GPS page has a fresh fix whenever it opens.

export type GpsSatellite = {
  prn: string; // satellite ID as reported (e.g. "G05" = GPS PRN 5)
  elevation: number; // degrees above horizon (0-90), -1 unknown
  azimuth: number; // degrees from true north (0-359), -1 unknown
  snr: number; // signal strength dB-Hz, 0 = not tracking
  used: boolean; // part of the current position solution
};

export type GpsStatus = {
  present: boolean; // a GPS dongle is plugged in
  device: string | null; // e.g. /dev/ttyACM0
  hasFix: boolean; // position solution valid
  latitude: number | null;
  longitude: number | null;
  altitudeM: number | null;
  speedKmh: number | null;
  headingDeg: number | null;
  hdop: number | null; // horizontal dilution of precision (lower = better)
  satellitesUsed: number; // in the fix (GGA field 7)
  satellitesInView: number; // tracked (GSV count)
  satellitesNeeded: number; // 4 = minimum for a 3D fix (lat/lon/alt/time)
  satellites: GpsSatellite[];
  fixTime: string | null; // ISO timestamp from the fix
  // Reverse-geocoded street address of the current fix (null while
  // unresolved or moving faster than the geocoder can keep up).
  address: string | null;
  error: string; // human-readable state when no dongle/fix
};

const EMPTY: GpsStatus = {
  present: false,
  device: null,
  hasFix: false,
  latitude: null,
  longitude: null,
  altitudeM: null,
  speedKmh: null,
  headingDeg: null,
  hdop: null,
  satellitesUsed: 0,
  satellitesInView: 0,
  satellitesNeeded: 4,
  satellites: [],
  fixTime: null,
  address: null,
  error: "Sin dongle GPS conectado",
};

// Minimum satellites for a usable 3D fix (lat/lon/alt/time). The UI shows
// "se necesitan N, hay M" against this number.
export const MIN_SATS_FOR_FIX = 4;

// ─── Dongle detection ────────────────────────────────────────────────────────
// USB GNSS receivers surface as serial devices: ttyACM* (CDC-ACM, most
// u-blox) or ttyUSB* (USB-serial bridges, CP210x/PL2303 based units).
const DEV_DIR = "/dev";

async function findGpsDevice(): Promise<string | null> {
  try {
    const entries = await fs.promises.readdir(DEV_DIR);
    const candidates = entries
      .filter((e) => /^(ttyACM\d+|ttyUSB\d+)$/.test(e))
      .sort();
    // Prefer ttyACM (u-blox style) over ttyUSB; first match wins.
    const acm = candidates.find((e) => e.startsWith("ttyACM"));
    return acm ? pathJoinDev(acm) : candidates[0] ? pathJoinDev(candidates[0]) : null;
  } catch {
    return null;
  }
}

function pathJoinDev(name: string): string {
  return `${DEV_DIR}/${name}`;
}

// ─── NMEA parsing ────────────────────────────────────────────────────────────
// Only the two sentences we need:
//   GGA — fix: time, lat/lon, fix quality, satellites used, altitude, HDOP
//   GSV — satellites in view: PRN, elevation, azimuth, SNR (per system)
//   RMC — speed/heading (cheapest source for both)

function nmeaChecksumOk(sentence: string): boolean {
  const idx = sentence.indexOf("*");
  if (idx === -1) return false;
  const body = sentence.slice(sentence.startsWith("$") ? 1 : 0, idx);
  const given = sentence.slice(idx + 1, idx + 3);
  let sum = 0;
  for (const ch of body) sum ^= ch.charCodeAt(0);
  return sum.toString(16).toUpperCase().padStart(2, "0") === given.toUpperCase();
}

// NMEA lat/lon: ddmm.mmmm / dddmm.mmmm + hemisphere → signed degrees.
function nmeaToDegrees(value: string, hemisphere: string): number | null {
  if (!value) return null;
  const num = parseFloat(value);
  if (!Number.isFinite(num)) return null;
  const degrees = Math.floor(num / 100);
  const minutes = num - degrees * 100;
  const dec = degrees + minutes / 60;
  return hemisphere === "S" || hemisphere === "W" ? -dec : dec;
}

type GgaFields = {
  time: string;
  lat: number | null;
  lon: number | null;
  quality: number; // 0 invalid, 1 GPS, 2 DGPS, 4 RTK, 6 estimated
  satellitesUsed: number;
  hdop: number | null;
  altitudeM: number | null;
};

function parseGga(fields: string[]): GgaFields | null {
  // $GPGGA,time,lat,N/S,lon,E/W,quality,numsat,hdop,alt,M,geoid,M,diff*,sum
  if (fields.length < 10) return null;
  const quality = parseInt(fields[6] || "0", 10) || 0;
  return {
    time: fields[1] || "",
    lat: nmeaToDegrees(fields[2], fields[3]),
    lon: nmeaToDegrees(fields[4], fields[5]),
    quality,
    satellitesUsed: parseInt(fields[7] || "0", 10) || 0,
    hdop: parseFloat(fields[8]) || null,
    altitudeM: parseFloat(fields[9]) || null,
  };
}

type RmcFields = {
  speedKmh: number | null; // RMC speed is knots
  headingDeg: number | null;
};

function parseRmc(fields: string[]): RmcFields | null {
  // $GPRMC,time,status,lat,N/S,lon,E/W,speed(knots),track angle,date,...
  if (fields.length < 8) return null;
  const knots = parseFloat(fields[7]);
  const track = parseFloat(fields[8]);
  return {
    speedKmh: Number.isFinite(knots) ? knots * 1.852 : null,
    headingDeg: Number.isFinite(track) ? track : null,
  };
}

// GSV: "$xxGSV,totalMsgs,msgNum,satsInView,prn,el,az,snr,..." — up to 4 sats
// per message. Talker prefix identifies the constellation (GP=GPS, GL=GLONASS,
// GA=Galileo, GB/BD=BeiDou).
function parseGsv(fields: string[], satellites: Map<string, GpsSatellite>): void {
  if (fields.length < 4) return;
  for (let base = 4; base + 3 < fields.length; base += 4) {
    const prn = fields[base];
    if (!prn) continue;
    const el = parseInt(fields[base + 1], 10);
    const az = parseInt(fields[base + 2], 10);
    const snr = parseInt(fields[base + 3], 10);
    satellites.set(prn, {
      prn,
      elevation: Number.isFinite(el) ? el : -1,
      azimuth: Number.isFinite(az) ? az : -1,
      snr: Number.isFinite(snr) ? snr : 0,
      used: false, // patched from GSA (or GGA count) below
    });
  }
}

// GSA: satellites participating in the current fix (DOP + PRN list).
function parseGsa(fields: string[], satellites: Map<string, GpsSatellite>): void {
  // $xxGSA,mode,type,prn1..prn12,pdop,hdop,vdop*sum
  for (let i = 3; i < 15 && i < fields.length; i++) {
    const prn = fields[i];
    if (!prn) continue;
    const existing = satellites.get(prn);
    if (existing) existing.used = true;
    else satellites.set(prn, { prn, elevation: -1, azimuth: -1, snr: 0, used: true });
  }
}

// ─── Live reader ─────────────────────────────────────────────────────────────
// gpspipe -r streams raw NMEA lines from gpsd; without gpsd we read the
// serial device directly (cat). Either way the reader is long-lived and
// restarts on error with a small backoff.

const READER_RESTART_MS = 5_000;
// GGA arrives ~1Hz; if nothing parses for this long the dongle stopped
// talking — treat as no-fix so the UI doesn't show a stale position.
const FIX_STALE_MS = 30_000;

type GpsLiveState = {
  lastGga: GgaFields | null;
  lastGgaAt: number;
  lastRmc: RmcFields | null;
  satellites: Map<string, GpsSatellite>;
};

class GpsNmeaReader {
  private child: import("child_process").ChildProcess | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly state: GpsLiveState = {
    lastGga: null,
    lastGgaAt: 0,
    lastRmc: null,
    satellites: new Map(),
  };

  constructor(private device: string) {}

  start(): void {
    this.stopped = false;
    this.spawn();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.killChild();
  }

  getState(): GpsLiveState {
    return this.state;
  }

  private killChild(): void {
    if (this.child) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      this.child = null;
    }
  }

  private spawn(): void {
    if (this.stopped) return;
    // gpspipe -r: raw NMEA through gpsd (works when gpsd owns the device);
    // fallback below reads the serial device directly. -n 0 = no warmup lines.
    const useGpspipe = fs.existsSync("/usr/bin/gpspipe");
    const cmd = useGpspipe ? "gpspipe" : "cat";
    const args = useGpspipe ? ["-r", "-n", "0"] : [this.device];
    let child: import("child_process").ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      this.scheduleRestart();
      return;
    }
    this.child = child;
    let pending = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (line) this.handleLine(line);
      }
    });
    child.on("error", () => this.scheduleRestart());
    child.on("close", () => {
      if (!this.stopped) this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    this.child = null;
    if (this.stopped || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, READER_RESTART_MS);
  }

  private handleLine(line: string): void {
    if (!line.startsWith("$")) return;
    if (!nmeaChecksumOk(line)) return;
    const body = line.slice(1, line.indexOf("*"));
    const fields = body.split(",");
    const type = fields[0].slice(-3); // GGA / RMC / GSV / GSA
    if (type === "GGA") {
      const parsed = parseGga(fields);
      if (parsed) {
        this.state.lastGga = parsed;
        this.state.lastGgaAt = Date.now();
      }
    } else if (type === "RMC") {
      const parsed = parseRmc(fields);
      if (parsed) this.state.lastRmc = parsed;
    } else if (type === "GSV") {
      parseGsv(fields, this.state.satellites);
    } else if (type === "GSA") {
      parseGsa(fields, this.state.satellites);
    }
  }
}

let reader: GpsNmeaReader | null = null;
let readerDevice: string | null = null;

// Long-lived reader lifecycle: spawn on first status request, restart if the
// dongle is unplugged/replugged under a new device name, stop if none left.
async function ensureReader(device: string | null): Promise<void> {
  if (reader && readerDevice === device) return;
  if (reader) {
    reader.stop();
    reader = null;
    readerDevice = null;
  }
  if (!device) return;
  reader = new GpsNmeaReader(device);
  readerDevice = device;
  reader.start();
}

// ─── Public status ───────────────────────────────────────────────────────────

export async function getGpsStatus(): Promise<GpsStatus> {
  const device = await findGpsDevice();
  if (!device) {
    ensureReader(null);
    return { ...EMPTY };
  }
  await ensureReader(device);
  if (!reader) return { ...EMPTY };

  const state = reader.getState();
  const stale = state.lastGgaAt === 0 || Date.now() - state.lastGgaAt > FIX_STALE_MS;
  const gga = stale ? null : state.lastGga;
  const hasFix = Boolean(gga && gga.quality > 0 && gga.lat != null && gga.lon != null);

  const satellites = [...state.satellites.values()].sort(
    (a, b) => Number(b.used) - Number(a.used) || b.snr - a.snr,
  );
  // Some receivers (u-blox 7) never emit GSA, so no satellite is flagged
  // `used`. GGA's sats-used count is authoritative: mark the top-SNR GSV
  // satellites as part of the fix up to that count.
  const satellitesUsed = gga?.satellitesUsed ?? 0;
  if (satellitesUsed > 0 && !satellites.some((s) => s.used)) {
    const bySnr = [...satellites].sort((a, b) => b.snr - a.snr);
    for (const s of bySnr.slice(0, satellitesUsed)) {
      if (s.snr > 0) s.used = true;
    }
  }
  const satellitesInView = satellites.filter((s) => s.elevation >= 0 || s.snr > 0).length;

  const error = hasFix
    ? ""
    : device && gga && gga.quality === 0
      ? `Fix inválido — ${gga.satellitesUsed}/${MIN_SATS_FOR_FIX} satélites`
      : "Esperando datos del dongle GPS";

  // Kick a reverse-geocode when the fix moved beyond the cache radius —
  // fire-and-forget, the response never waits on the network.
  if (hasFix && gga!.lat != null && gga!.lon != null) {
    reverseGeocoder.update(gga!.lat, gga!.lon, state.lastRmc?.speedKmh ?? null);
  }

  return {
    present: true,
    device,
    hasFix,
    latitude: hasFix ? gga!.lat : null,
    longitude: hasFix ? gga!.lon : null,
    altitudeM: gga?.altitudeM ?? null,
    speedKmh: state.lastRmc?.speedKmh ?? null,
    headingDeg: state.lastRmc?.headingDeg ?? null,
    hdop: gga?.hdop ?? null,
    satellitesUsed,
    satellitesInView,
    satellitesNeeded: MIN_SATS_FOR_FIX,
    satellites,
    fixTime: hasFix && gga!.time
      ? nmeaTimeToIso(gga!.time)
      : null,
    address: hasFix ? reverseGeocoder.current() : null,
    error,
  };
}

// NMEA hhmmss.sss UTC → ISO "HH:MM:SSZ" (date comes from RMC; UI shows the
// time only, so day rollover precision isn't needed here).
function nmeaTimeToIso(hhmmss: string): string {
  const h = hhmmss.slice(0, 2);
  const m = hhmmss.slice(2, 4);
  const s = hhmmss.slice(4, 6);
  return `${h}:${m}:${s}Z`;
}

// ─── Reverse geocoding (street address of the fix) ──────────────────────────
// Nominatim (OpenStreetMap, free, no key). Usage policy: max 1 req/s and a
// meaningful User-Agent — handled with a request timer plus a proximity
// cache so being parked in one spot costs ZERO requests, and moving only
// triggers a lookup after crossing a distance threshold.

// Re-geocode after moving more than this far from the last lookup (~40m —
// below typical GPS jitter while parked, above a couple of house fronts).
const GEO_MIN_MOVE_M = 40;
// Hard throttle: never two Nominatim calls closer than this (usage policy).
const GEO_MIN_INTERVAL_MS = 15_000;
// Give up after this long so a hung request never blocks the status poll
// (the fetch itself is awaited by the status route).
const GEO_TIMEOUT_MS = 8_000;
// While driving faster than this, the address is stale the moment it
// resolves — display it but stop burning requests every 40m.
const GEO_MAX_SPEED_KMH = 70;

type GeoResult = {
  lat: number;
  lon: number;
  address: string | null;
  resolvedAt: number;
  failed: boolean;
};

class ReverseGeocoder {
  private last: GeoResult | null = null;
  private lastRequestAt = 0;
  private inflight = false;
  // Sequential queue marker: newest fix wins, stale lookups get dropped.
  private requestSeq = 0;

  // Current known address — returns it for any fix within GEO_MIN_MOVE_M
  // of where it was resolved, else null while a new lookup is in flight.
  current(): string | null {
    return this.last && !this.last.failed ? this.last.address : null;
  }

  // Called on every status poll with a valid fix. Decides whether to fire a
  // new reverse-geocode and starts it without blocking the response.
  update(lat: number, lon: number, speedKmh: number | null): void {
    if (this.inflight) return;
    const moved = this.last
      ? haversineM(lat, lon, this.last.lat, this.last.lon)
      : Infinity;
    const now = Date.now();
    const throttled = now - this.lastRequestAt < GEO_MIN_INTERVAL_MS;
    if (this.last && moved < GEO_MIN_MOVE_M) return; // parked: cache valid
    if (speedKmh != null && speedKmh > GEO_MAX_SPEED_KMH && this.last) {
      return; // highway: address would be stale immediately
    }
    if (throttled) return;
    this.fire(lat, lon);
  }

  private fire(lat: number, lon: number): void {
    const seq = ++this.requestSeq;
    this.inflight = true;
    this.lastRequestAt = Date.now();
    void (async () => {
      let address: string | null = null;
      let failed = false;
      try {
        address = await nominatimAddress(lat, lon);
        if (address === null) failed = true;
      } catch {
        failed = true;
      }
      this.inflight = false;
      if (seq !== this.requestSeq) return; // superseded
      this.last = { lat, lon, address, resolvedAt: Date.now(), failed };
    })();
  }
}

async function nominatimAddress(lat: number, lon: number): Promise<string | null> {
  const url =
    `https://nominatim.openstreetmap.org/reverse?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}` +
    `&format=jsonv2&zoom=18&addressdetails=1&accept-language=es`;
  const res = await fetch(url, {
    headers: {
      // Nominatim usage policy: identify the app (akbal-pi, contact-less lab use).
      "User-Agent": "akbal-pi-gps-admin/1.0 (Raspberry Pi device page)",
      "Accept-Language": "es",
    },
    signal: AbortSignal.timeout(GEO_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data: any = await res.json().catch(() => null);
  if (!data) return null;
  return composeAddress(data);
}

// Human-friendly one-liner: "Calle 123, Colonia, Ciudad, CP, País" — built
// from Nominatim's address object rather than display_name (which is long
// and includes the county/district noise).
function composeAddress(data: any): string | null {
  const a = data?.address || {};
  const parts: string[] = [];
  const street = a.road || a.pedestrian || a.footway || a.residential || a.name;
  if (street) parts.push(a.house_number ? `${street} ${a.house_number}` : street);
  if (a.suburb || a.neighbourhood) parts.push(a.suburb || a.neighbourhood);
  if (a.city || a.town || a.village || a.municipality) {
    parts.push(a.city || a.town || a.village || a.municipality);
  }
  if (a.state) parts.push(a.state);
  if (a.postcode) parts.push(a.postcode);
  if (a.country) parts.push(a.country);
  const composed = parts.filter(Boolean).join(", ");
  return composed || data?.display_name || null;
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export const reverseGeocoder = new ReverseGeocoder();