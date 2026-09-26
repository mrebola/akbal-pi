import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import { EventEmitter } from "events";
import { setWifiRadarMode, getWifiRadarRequestedMode, stopWifiRadarService } from "../wifiradar/service";
import { exitMonitorMode } from "../wardrive/monitor";
import { detectMonitorAdapter } from "../wifiradar/adapter";
import { setGpsDemoMode } from "./gps";

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

// USB serial devices: dropping the kernel driver frees the tty; udev
// re-binds it when the interface comes back. Best-effort only.
async function usbAuthRebind(action: "unbind" | "bind"): Promise<void> {
  try {
    const dir = "/sys/bus/usb/drivers/cdc_acm";
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (!/^\d+-\d+(\.\d+)*:\d+\.\d+$/.test(entry)) continue; // interface dirs
      await execFileAsync("sudo", ["-n", "sh", "-c", `echo ${entry} > /sys/bus/usb/drivers/cdc_acm/${action}`])
        .catch(() => {});
    }
    console.log(`[platform] cdc_acm ${action} done`);
  } catch {
    // never fatal
  }
}

export async function setPlatformMode(mode: PlatformMode): Promise<{ ok: boolean; mode: PlatformMode; error?: string }> {
  if (switching) return { ok: false, mode: currentMode, error: "cambio de modo en curso" };
  if (mode === currentMode) return { ok: true, mode: currentMode };
  switching = true;
  try {
    if (mode === "demo") {
      // 1. Radar to demo (stops the dumpcap capture on the wifi adapter).
      await setWifiRadarMode("demo").catch(() => {});
      // 2. GPS dongle: stop the NMEA reader, park the device.
      setGpsDemoMode(true);
      // 3. WiFi adapter: out of monitor, link down (radar already released it).
      await releaseWifiAdapter();
      // 4. USB serial rebind: frees the GPS tty.
      await usbAuthRebind("unbind");
      // 5. An active wardrive session would fight the release — close it.
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