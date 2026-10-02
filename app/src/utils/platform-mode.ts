import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import { EventEmitter } from "events";
import { setWifiRadarMode, getWifiRadarRequestedMode, stopWifiRadarService } from "../wifiradar/service";
import { exitMonitorMode } from "../wifi-audit/monitor";
import { detectMonitorAdapter } from "../wifiradar/adapter";
import { setGpsDemoMode } from "./gps";
import { setAircraftRadarMode } from "../services/adsb/service";

const execFileAsync = promisify(execFile);

// Platform-wide source mode (docs/gps.md, docs/wifiradar.md): one switch for
// the whole device. LIVE = the real hardware feeds every panel (WiFi Radar
// capture, wardrive targets, GPS dongle). DEMO = synthetic data everywhere
// AND the demo hardware gets released: the USB wifi adapter drops out of
// monitor mode and the GPS NMEA reader stops, freeing CPU and the serial
// line. Storage is never unmounted — media/music backups stay live.

export type PlatformMode = "live" | "demo";

let currentMode: PlatformMode = "live";
let switching = false;

export const platformEvents = new EventEmitter();

export function getPlatformMode(): PlatformMode {
  return currentMode;
}

function setGpsIfaceDown(iface: string): void {
  void execFileAsync("sudo", ["-n", "ip", "link", "set", iface, "down"]).catch(() => {});
}

function setGpsIfaceUp(iface: string): void {
  void execFileAsync("sudo", ["-n", "ip", "link", "set", iface, "up"]).catch(() => {});
}

// The USB wifi adapter: on demo, restore it to managed mode and bring it
// down (released from any capture). On live, bring it back up — the radar
// or wardrive services will do their own monitor-mode dance.
async function releaseWifiAdapter(): Promise<void> {
  try {
    const info = await detectMonitorAdapter();
    if (info.present && info.iface) {
      await exitMonitorMode(info.iface).catch(() => {});
      setGpsIfaceDown(info.iface);
      console.log(`[platform] wifi adapter ${info.iface} released (demo)`);
    }
  } catch (err: any) {
    console.warn("[platform] wifi release failed:", err?.message || err);
  }
}

async function rearmWifiAdapter(): Promise<void> {
  try {
    const info = await detectMonitorAdapter();
    if (info.present && info.iface) {
      setGpsIfaceUp(info.iface);
      console.log(`[platform] wifi adapter ${info.iface} re-armed (live)`);
    }
  } catch (err: any) {
    console.warn("[platform] wifi re-arm failed:", err?.message || err);
  }
}

// USB serial devices: dropping the kernel driver frees the tty.
//
// This used to assume udev (or this same function, called with "bind") would
// bring the interface back — it doesn't, and that was a real bug: unbinding
// REMOVES the interface from cdc_acm's own driver directory (that's what
// "unbound" means), so re-reading that same directory to figure out what to
// bind finds nothing — there's nothing left there to iterate. In practice
// this meant switching DEMO → LIVE silently never rebound the GPS: the mode
// flipped, the log said "cdc_acm bind done", but zero interfaces were ever
// touched, so /dev/ttyACM* stayed gone until someone rebound it by hand.
//
// Fix: "bind" doesn't trust what it itself (or any other unbind, from a
// previous process, a crash mid-switch, anything) left behind in memory —
// it scans every USB interface on the system for ones that are (a) CDC-ACM
// compatible by class (Communications 0x02 or CDC Data 0x0A, what cdc_acm
// actually claims) and (b) currently unbound (no driver symlink), and binds
// exactly those. That's self-healing regardless of *why* something ended up
// unbound, including across a service restart that happened mid-DEMO.
const CDC_ACM_INTERFACE_CLASSES = new Set(["02", "0a"]);
const USB_DEVICES_DIR = "/sys/bus/usb/devices";
const USB_IFACE_RE = /^\d+-\d+(\.\d+)*:\d+\.\d+$/;

function listUnboundCdcAcmInterfaces(): string[] {
  if (!fs.existsSync(USB_DEVICES_DIR)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(USB_DEVICES_DIR)) {
    if (!USB_IFACE_RE.test(entry)) continue;
    const ifaceDir = `${USB_DEVICES_DIR}/${entry}`;
    if (fs.existsSync(`${ifaceDir}/driver`)) continue; // already bound (to cdc_acm or anything else)
    let cls = "";
    try {
      cls = fs.readFileSync(`${ifaceDir}/bInterfaceClass`, "utf8").trim().toLowerCase();
    } catch {
      continue;
    }
    if (CDC_ACM_INTERFACE_CLASSES.has(cls)) out.push(entry);
  }
  return out;
}

async function usbAuthRebind(action: "unbind" | "bind"): Promise<void> {
  try {
    const dir = "/sys/bus/usb/drivers/cdc_acm";
    if (!fs.existsSync(dir)) return;
    const targets = action === "unbind"
      ? fs.readdirSync(dir).filter((e) => USB_IFACE_RE.test(e))
      : listUnboundCdcAcmInterfaces();
    for (const entry of targets) {
      await execFileAsync("sudo", ["-n", "sh", "-c", `echo ${entry} > /sys/bus/usb/drivers/cdc_acm/${action}`])
        .catch((err: any) => console.warn(`[platform] cdc_acm ${action} failed for ${entry}:`, err?.message || err));
    }
    console.log(`[platform] cdc_acm ${action}: ${targets.length ? targets.join(", ") : "nothing to do"}`);
  } catch (err: any) {
    console.warn(`[platform] cdc_acm ${action} scan failed:`, err?.message || err);
  }
}

// Startup self-heal: if the process starts (or restarts) while some
// CDC-ACM device was left unbound from a previous DEMO session — including
// one that never made it back to LIVE because of the bug above — this
// brings it back without needing an explicit mode toggle. Matches the
// existing "a reboot always starts live" assumption (see
// reconcilePlatformMode below) by actually making that true for the
// hardware, not just the in-memory currentMode flag.
export async function healUsbSerialDevices(): Promise<void> {
  await usbAuthRebind("bind");
}

export async function setPlatformMode(mode: PlatformMode): Promise<{ ok: boolean; mode: PlatformMode; error?: string }> {
  if (switching) return { ok: false, mode: currentMode, error: "cambio de modo en curso" };
  if (mode === currentMode) return { ok: true, mode: currentMode };
  switching = true;
  try {
    if (mode === "demo") {
      // 1. Radar to demo (stops the dumpcap capture on the wifi adapter).
      await setWifiRadarMode("demo").catch(() => {});
      // 2. Aircraft Radar to demo (stops hackrf_transfer|dump1090).
      await setAircraftRadarMode("demo").catch(() => {});
      // 3. GPS dongle: stop the NMEA reader, park the device.
      setGpsDemoMode(true);
      // 4. WiFi adapter: out of monitor, link down (radar already released it).
      await releaseWifiAdapter();
      // 5. USB serial rebind: frees the GPS tty.
      await usbAuthRebind("unbind");
      // 6. An active wardrive session would fight the release — close it.
      currentMode = "demo";
      platformEvents.emit("mode", currentMode);
      console.log("[platform] mode → DEMO (dongles released, synthetic data everywhere)");
    } else {
      // 1. Rebind USB serial + bring the adapter link back up.
      await usbAuthRebind("bind");
      await rearmWifiAdapter();
      // 2. GPS reader restarts on the next status poll.
      setGpsDemoMode(false);
      // 3. Radar back to live.
      await setWifiRadarMode("live").catch(() => {});
      // 4. Aircraft Radar back to live.
      await setAircraftRadarMode("live").catch(() => {});
      currentMode = "live";
      platformEvents.emit("mode", currentMode);
      console.log("[platform] mode → LIVE (real hardware feeding panels)");
    }
    return { ok: true, mode: currentMode };
  } catch (err: any) {
    return { ok: false, mode: currentMode, error: err?.message || String(err) };
  } finally {
    switching = false;
  }
}

// Boot reconciliation: whichever mode the radar was left in wins (persisted
// nowhere on purpose — a reboot always starts live).
export async function reconcilePlatformMode(): Promise<void> {
  const radarMode = getWifiRadarRequestedMode();
  if (radarMode === "demo" && currentMode === "live") {
    currentMode = "demo";
    setGpsDemoMode(true);
    platformEvents.emit("mode", currentMode);
  }
}