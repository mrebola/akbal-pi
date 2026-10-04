import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

const IW = "/usr/sbin/iw";
const NET_CLASS_DIR = "/sys/class/net";

// Shared validator for a pinned-dongle value — every setPreferredAdapter()
// (wifiradar/wifi-audit/wardrive services) checks against this before
// storing it.
export const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

// A WiFi adapter usable for auditing (WiFi Radar / wardriving): a USB wireless
// interface whose driver advertises monitor mode. Detection is generic — any
// monitor-capable USB dongle works, not just the AR9271 — so swapping adapters
// "just works". The onboard wifi (not USB) is intentionally excluded so
// auditing never hijacks the Pi's own LAN connection.
export type MonitorAdapter = {
  present: boolean; // a USB wifi adapter is plugged in
  monitorSupported: boolean; // ...and it advertises monitor mode
  iface: string | null; // e.g. "wlan1" — NOT stable: the kernel/udev can
  // reassign this on any USB reconnect, including one on a DIFFERENT
  // device (confirmed live: swapping a second AR9271 in/out reshuffled
  // which name this same physical dongle got). Never persist this as an
  // identity — mac below is what's stable across reconnects.
  phy: string | null; // e.g. "phy1" — same caveat as iface
  mac: string; // "" if none — the one thing that survives a re-enumeration
  driver: string;
  description: string; // human label, e.g. "Realtek RTL8812AU" or the driver
};

const NONE: MonitorAdapter = {
  present: false,
  monitorSupported: false,
  iface: null,
  phy: null,
  mac: "",
  driver: "",
  description: "",
};

const readText = async (p: string): Promise<string> => {
  try {
    return (await fs.promises.readFile(p, "utf8")).trim();
  } catch {
    return "";
  }
};

// Is this interface on the USB bus? (external dongle vs onboard SDIO/PCI wifi)
const isUsbIface = async (iface: string): Promise<boolean> => {
  const real = await fs.promises.realpath(path.join(NET_CLASS_DIR, iface, "device")).catch(() => "");
  return real.includes("/usb");
};

const phyOf = async (iface: string): Promise<string> => {
  const real = await fs.promises
    .realpath(path.join(NET_CLASS_DIR, iface, "phy80211"))
    .catch(() => "");
  return real ? path.basename(real) : "";
};

const driverOf = async (iface: string): Promise<string> => {
  const real = await fs.promises
    .realpath(path.join(NET_CLASS_DIR, iface, "device", "driver"))
    .catch(() => "");
  return real ? path.basename(real) : "";
};

// A friendly name from the USB device's descriptors (manufacturer + product),
// falling back to the kernel driver.
const describe = async (iface: string, driver: string): Promise<string> => {
  const base = path.join(NET_CLASS_DIR, iface, "device");
  // USB net iface -> its USB interface dir; the USB *device* is one level up.
  const manu = (await readText(path.join(base, "..", "manufacturer"))) || (await readText(path.join(base, "manufacturer")));
  const prod = (await readText(path.join(base, "..", "product"))) || (await readText(path.join(base, "product")));
  const label = [manu, prod].filter(Boolean).join(" ").trim();
  return label || (driver ? `USB WiFi (${driver})` : "USB WiFi");
};

const supportsMonitor = async (phy: string): Promise<boolean> => {
  if (!phy) return false;
  try {
    const { stdout } = await execFileAsync("sudo", ["-n", IW, "phy", phy, "info"], { timeout: 8000 });
    // The "Supported interface modes" block lists one "* <mode>" per line.
    return /^\s*\*\s*monitor\s*$/im.test(stdout);
  } catch {
    // Fall back to a non-privileged read if sudo isn't available.
    try {
      const { stdout } = await execFileAsync(IW, ["phy", phy, "info"], { timeout: 8000 });
      return /^\s*\*\s*monitor\s*$/im.test(stdout);
    } catch {
      return false;
    }
  }
};

const macOf = async (iface: string): Promise<string> =>
  (await readText(path.join(NET_CLASS_DIR, iface, "address"))).toLowerCase();

// One iface -> full MonitorAdapter (or null if it's not a USB wireless
// iface at all) — the single place that reads phy/usb/driver/mac/monitor
// for a given name, shared by both the auto-detect loop and the picker
// listing below so they can never disagree about what a given iface is.
export async function describeIfaceIfPresent(iface: string): Promise<MonitorAdapter | null> {
  const phy = await phyOf(iface);
  if (!phy) return null;
  if (!(await isUsbIface(iface))) return null;
  const driver = await driverOf(iface);
  return {
    present: true,
    monitorSupported: await supportsMonitor(phy),
    iface,
    phy,
    mac: await macOf(iface),
    driver,
    description: await describe(iface, driver),
  };
}

export async function detectMonitorAdapter(preferredMac?: string | null): Promise<MonitorAdapter> {
  let ifaces: string[] = [];
  try {
    ifaces = await fs.promises.readdir(NET_CLASS_DIR);
  } catch {
    return NONE;
  }

  // The operator can pin a specific dongle (by MAC — see AdapterUiEntry
  // below for why not by iface name) for wardrive/wifi-audit/wifi radar:
  // if it's present and monitor-capable it wins regardless of enumeration
  // order; if it's missing the normal detection applies (failover, never
  // a hard failure).
  if (preferredMac) {
    const wantMac = String(preferredMac).trim().toLowerCase();
    for (const iface of ifaces) {
      const info = await describeIfaceIfPresent(iface);
      if (info && info.mac === wantMac && info.monitorSupported) return info;
    }
    // Preferred dongle missing/not usable right now → auto-detect below.
  }

  let firstUsb: MonitorAdapter | null = null;
  for (const iface of ifaces) {
    const info = await describeIfaceIfPresent(iface);
    if (!info) continue;
    if (info.monitorSupported) return info; // best case — use it immediately
    if (!firstUsb) firstUsb = info; // remember a present-but-incapable one
  }

  return firstUsb || NONE;
}

export type AdapterUiEntry = {
  iface: string; // display only — see MonitorAdapter.iface
  mac: string; // the picker's actual <option value> / pin identity
  driver: string;
  description: string;
  monitorSupported: boolean;
  isPreferred: boolean;
};

// Shared dongle-picker listing for every feature that grabs the audit
// radio (WiFi Radar, Wifi Audit, Wardrive): every USB wifi adapter
// present, monitor-capability + whether it's the pinned one, ranked
// monitor-capable-first / pinned-first / ath9k_htc (AR9271, this
// project's reference dongle) as the default recommendation.
export async function listAdaptersForUI(
  preferredMac: string | null,
): Promise<{ adapters: AdapterUiEntry[]; preferred: string | null }> {
  const out: AdapterUiEntry[] = [];
  const wantMac = preferredMac ? preferredMac.trim().toLowerCase() : null;
  for (const iface of await fs.promises.readdir(NET_CLASS_DIR).catch(() => [] as string[])) {
    const info = await describeIfaceIfPresent(iface);
    if (!info) continue;
    out.push({
      iface,
      mac: info.mac,
      driver: info.driver,
      description: info.description,
      monitorSupported: info.monitorSupported,
      isPreferred: wantMac !== null && info.mac === wantMac,
    });
  }
  const rank = (a: AdapterUiEntry) =>
    (a.monitorSupported ? 0 : 2) + (a.isPreferred ? -1 : 0) + (a.driver === "ath9k_htc" ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || a.iface.localeCompare(b.iface));
  return { adapters: out, preferred: preferredMac };
}

// Back-compat shape for callers that used detectAr9271().
export async function detectAuditAdapter(): Promise<{
  present: boolean;
  iface: string | null;
  phy: string | null;
  description: string;
  monitorSupported: boolean;
}> {
  const a = await detectMonitorAdapter();
  return {
    present: a.present && a.monitorSupported,
    iface: a.iface,
    phy: a.phy,
    description: a.description,
    monitorSupported: a.monitorSupported,
  };
}
