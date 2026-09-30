import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

const IW = "/usr/sbin/iw";
const NET_CLASS_DIR = "/sys/class/net";

// A WiFi adapter usable for auditing (WiFi Radar / wardriving): a USB wireless
// interface whose driver advertises monitor mode. Detection is generic — any
// monitor-capable USB dongle works, not just the AR9271 — so swapping adapters
// "just works". The onboard wifi (not USB) is intentionally excluded so
// auditing never hijacks the Pi's own LAN connection.
export type MonitorAdapter = {
  present: boolean; // a USB wifi adapter is plugged in
  monitorSupported: boolean; // ...and it advertises monitor mode
  iface: string | null; // e.g. "wlan1"
  phy: string | null; // e.g. "phy1"
  driver: string;
  description: string; // human label, e.g. "Realtek RTL8812AU" or the driver
};

const NONE: MonitorAdapter = {
  present: false,
  monitorSupported: false,
  iface: null,
  phy: null,
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

export async function detectMonitorAdapter(preferredIface?: string | null): Promise<MonitorAdapter> {
  let ifaces: string[] = [];
  try {
    ifaces = await fs.promises.readdir(NET_CLASS_DIR);
  } catch {
    return NONE;
  }

  // The operator can pin a specific dongle for wardrive (POST
  // /api/wardrive/drive/adapter): if it's present and monitor-capable it
  // wins regardless of enumeration order; if it's missing the normal
  // detection applies (failover, never a hard failure).
  if (preferredIface) {
    const want = String(preferredIface).trim();
    if (ifaces.includes(want)) {
      const phy = await phyOf(want);
      if (phy && (await isUsbIface(want)) && (await supportsMonitor(phy))) {
        return {
          present: true,
          monitorSupported: true,
          iface: want,
          phy,
          driver: await driverOf(want),
          description: await describe(want, await driverOf(want)),
        };
      }
    }
    // Preferred dongle missing → fall through to auto-detect (never fail).
  }

  let firstUsb: MonitorAdapter | null = null;
  for (const iface of ifaces) {
    // Only wireless interfaces (have a phy80211) that live on the USB bus.
    const phy = await phyOf(iface);
    if (!phy) continue;
    if (!(await isUsbIface(iface))) continue;

    const driver = await driverOf(iface);
    const description = await describe(iface, driver);
    const monitor = await supportsMonitor(phy);
    const adapter: MonitorAdapter = {
      present: true,
      monitorSupported: monitor,
      iface,
      phy,
      driver,
      description,
    };
    if (monitor) return adapter; // best case — use it immediately
    if (!firstUsb) firstUsb = adapter; // remember a present-but-incapable one
  }

  return firstUsb || NONE;
}

export type AdapterUiEntry = {
  iface: string;
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
  preferredIface: string | null,
): Promise<{ adapters: AdapterUiEntry[]; preferred: string | null }> {
  const out: AdapterUiEntry[] = [];
  const seen = new Set<string>();
  for (const iface of await fs.promises.readdir(NET_CLASS_DIR).catch(() => [] as string[])) {
    const info = await detectMonitorAdapter(iface);
    if (info.present && info.iface === iface && !seen.has(iface)) {
      seen.add(iface);
      out.push({
        iface,
        driver: info.driver,
        description: info.description,
        monitorSupported: info.monitorSupported,
        isPreferred: preferredIface === iface,
      });
    }
  }
  const rank = (a: AdapterUiEntry) =>
    (a.monitorSupported ? 0 : 2) + (a.isPreferred ? -1 : 0) + (a.driver === "ath9k_htc" ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || a.iface.localeCompare(b.iface));
  return { adapters: out, preferred: preferredIface };
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
