import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

// Qualcomm Atheros AR9271 802.11n's USB vendor:product ID — stable across
// every AR9271 dongle (Alfa, TP-Link TL-WN722N v1, etc.), unlike the
// network interface name which depends on enumeration order.
const AR9271_USB_ID = "0cf3:9271";

const IW = "/usr/sbin/iw";
const NET_CLASS_DIR = "/sys/class/net";

export type Ar9271Info = {
  present: boolean;
  iface: string | null; // e.g. "wlan1"
  phy: string | null; // e.g. "phy1"
  description: string;
};

async function findAr9271Interface(): Promise<{ iface: string; phy: string } | null> {
  // The AR9271 always loads the ath9k_htc kernel driver — checking that
  // (via the /sys/class/net/<iface>/device/driver symlink) is chipset-exact,
  // unlike matching on MAC vendor prefix (dongles from different brands
  // ship different OUIs on the same chipset) or "whichever phy isn't
  // phy0" (interface/phy numbering isn't guaranteed stable across reboots).
  let ifaces: string[] = [];
  try {
    ifaces = await fs.promises.readdir(NET_CLASS_DIR);
  } catch {
    return null;
  }
  for (const iface of ifaces) {
    const driverPath = path.join(NET_CLASS_DIR, iface, "device", "driver");
    const realDriverPath = await fs.promises.realpath(driverPath).catch(() => "");
    if (!realDriverPath.endsWith("ath9k_htc")) continue;
    // .../device/net/<iface>/phy80211 -> .../class/ieee80211/phyN, whose
    // basename is the phy name `iw` expects ("phy1").
    const phyRealPath = await fs.promises
      .realpath(path.join(NET_CLASS_DIR, iface, "phy80211"))
      .catch(() => "");
    const phyName = phyRealPath ? path.basename(phyRealPath) : "";
    if (phyName) {
      return { iface, phy: phyName };
    }
  }
  return null;
}

export async function detectAr9271(): Promise<Ar9271Info> {
  try {
    const { stdout } = await execFileAsync("lsusb");
    const present = stdout.toLowerCase().includes(AR9271_USB_ID);
    if (!present) {
      return { present: false, iface: null, phy: null, description: "" };
    }
    const found = await findAr9271Interface();
    return {
      present: true,
      iface: found?.iface || null,
      phy: found?.phy || null,
      description: "Qualcomm Atheros AR9271 802.11n",
    };
  } catch (err) {
    console.warn("[airspace] detectAr9271 failed:", err);
    return { present: false, iface: null, phy: null, description: "" };
  }
}
