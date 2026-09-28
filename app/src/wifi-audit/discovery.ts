import { getWifiRadarSnapshot } from "../wifiradar/service";
import { lookupVendorOrRandom } from "../wifiradar/oui";
import { WardriveTarget } from "./types";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

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

// Fallback iw scan when the WiFi Radar is stopped (wardrive mode has the
// radio). Uses the main interface (wlan0) for a one-shot scan.
async function iwScanFallback(): Promise<WardriveTarget[]> {
  try {
    const { stdout } = await execFileAsync("sudo", ["-n", "iw", "dev", "wlan0", "scan"], {
      timeout: 10_000,
    });
    return parseIwScan(stdout);
  } catch {
    return [];
  }
}

function parseIwScan(output: string): WardriveTarget[] {
  const targets: WardriveTarget[] = [];
  const blocks = output.split(/^BSS /m).slice(1);
  for (const block of blocks) {
    const bssidMatch = /^([0-9a-f:]{17})/.exec(block);
    const ssidMatch = /SSID: (.+)$/m.exec(block);
    const signalMatch = /signal: ([-\d.]+)/.exec(block);
    const chanMatch = /DS Parameter set: channel (\d+)/.exec(block);
    const secMatch = /(WPA2|WPA3|RSN|WPA)/.exec(block);
    if (!bssidMatch) continue;
    const bssid = bssidMatch[1].toUpperCase();
    const rssi = signalMatch ? parseFloat(signalMatch[1]) : -100;
    targets.push({
      bssid,
      ssid: ssidMatch ? ssidMatch[1].trim() : "",
      vendor: lookupVendorOrRandom(bssid).vendor,
      channel: chanMatch ? parseInt(chanMatch[1], 10) : 0,
      rssi,
      security: secMatch ? secMatch[1] : "UNKNOWN",
      clients: 0, // iw scan doesn't show clients
      distanceMeters: estimateDistanceMeters(rssi),
      inAllowlist: false,
      attackable: rssi >= USABLE_DBM,
    });
  }
  return targets.sort((a, b) => {
    const strongDelta = Number(b.rssi >= STRONG_DBM) - Number(a.rssi >= STRONG_DBM);
    if (strongDelta !== 0) return strongDelta;
    return b.rssi - a.rssi;
  });
}

// Demo source for wardriving: a STATIC synthetic target list (stable BSSIDs
// so the allowlist/session flow survives polling and page reloads — the
// radar's DemoGenerator churns random MACs, useless for an attack workflow).
// Includes akbal_lab, the dedicated lab AP (docs/lab-wireless.md): its
// password is deliberately public/weak so the demo can run the full
// capture → validate → show-password pipeline end to end.
export type DemoWardriveTarget = WardriveTarget & { demoPassword?: string };

export const DEMO_WD_TARGETS: DemoWardriveTarget[] = [
  {
    bssid: "F4:F5:D8:1A:B0:5E",
    ssid: "akbal_lab",
    vendor: "TP-Link",
    channel: 1,
    rssi: -42,
    security: "WPA2",
    clients: 1,
    distanceMeters: 2.5,
    inAllowlist: false,
    attackable: true,
    // Lab-only by design: deliberately weak/public (docs/lab-wireless.md),
    // used so the demo dictionary crack ends in a KEY FOUND like the real
    // lab pipeline does. Never a real network's password.
    demoPassword: "123456789",
  },
  {
    bssid: "B8:27:EB:7C:44:01",
    ssid: "CasaVerde_5G",
    vendor: "Raspberry Pi Trading",
    channel: 6,
    rssi: -58,
    security: "WPA2",
    clients: 2,
    distanceMeters: 8.1,
    inAllowlist: false,
    attackable: true,
  },
  {
    bssid: "3C:5A:B4:92:6D:C3",
    ssid: "Oficina_Norte",
    vendor: "TP-Link",
    channel: 11,
    rssi: -51,
    security: "WPA2",
    clients: 0,
    distanceMeters: 4.4,
    inAllowlist: false,
    attackable: true,
  },
  {
    bssid: "00:1A:11:AF:30:77",
    ssid: "CyberCafe_WiFi",
    vendor: "Wistron Neweb",
    channel: 3,
    rssi: -66,
    security: "WEP",
    clients: 0,
    distanceMeters: 14.2,
    inAllowlist: false,
    attackable: true,
  },
  {
    bssid: "AC:63:BE:05:D1:9A",
    ssid: "GuestNetwork",
    vendor: "Beholder",
    channel: 9,
    rssi: -63,
    security: "OPEN",
    clients: 1,
    distanceMeters: 19.5,
    inAllowlist: false,
    attackable: true,
  },
  {
    bssid: "F8:8F:CA:44:18:2F",
    ssid: "Vecino_2.4G",
    vendor: "Sercomm",
    channel: 1,
    rssi: -79,
    security: "WPA2/3",
    clients: 0,
    distanceMeters: 46.3,
    inAllowlist: false,
    attackable: false,
  },
];

function demoTargets(): WardriveTarget[] {
  return DEMO_WD_TARGETS.map(({ demoPassword: _pw, ...t }) => t);
}

export function demoTargetsWithPassword(): DemoWardriveTarget[] {
  return DEMO_WD_TARGETS;
}

export async function discoverTargets(source?: "live" | "demo"): Promise<WardriveTarget[]> {
  if (source === "demo") {
    return demoTargets();
  }
  const snapshot = getWifiRadarSnapshot(true);
  // If the radar is running (has APs), use it — it's richer (clients, OUI, etc).
  if (snapshot.accessPoints.length > 0) {
    return snapshot.accessPoints.map((ap) => ({
      bssid: ap.bssidFull.toUpperCase(),
      ssid: ap.ssid,
      vendor: ap.vendor || lookupVendorOrRandom(ap.bssidFull).vendor,
      channel: ap.channel,
      rssi: ap.rssi,
      security: ap.security,
      clients: ap.clients ?? 0,
      distanceMeters: estimateDistanceMeters(ap.rssi),
      inAllowlist: false, // filled in by the service
      attackable: ap.rssi >= USABLE_DBM,
    }));
  }
  // Radar stopped (wardrive mode owns the radio): fall back to iw scan.
  return await iwScanFallback();
}