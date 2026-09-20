import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import QRCode from "qrcode";
import { persistEnvVar } from "./env-file";

const execFileAsync = promisify(execFile);

// Direct WiFi ("AP" / hotspot) mode: turns the Pi's own wifi card into an
// access point so you can reach the web admin with no internet/LAN — connect a
// phone/laptop straight to the Pi. NetworkManager (nmcli) drives it, via the
// same scoped `sudo -n nmcli` rule the rest of wifi uses.
//
// IMPORTANT: the onboard wlan0 can be a client OR an access point, not both. So
// enabling this DROPS the Pi's normal wifi connection; you rejoin the LAN by
// disabling AP mode again (from the AP web UI, or the device menu).

const runNmcli = async (args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("sudo", ["-n", "nmcli", ...args], { timeout: 25000 });
  return stdout;
};

const AP_CON_NAME = "akbal-ap";
const AP_IFACE = process.env.AP_IFACE || "wlan0";
const AP_IP = process.env.AP_IP || "10.42.0.1"; // NetworkManager shared-mode gateway
const WEB_PORT = process.env.WEB_ADMIN_PORT || "8090";

const getSsid = (): string => process.env.AP_SSID || "akbal-pi";

// Stable, easy-to-type password persisted to .env on first use (WPA needs >=8).
const getPassword = (): string => {
  let p = process.env.AP_PASSWORD || "";
  if (p.length < 8) {
    p = `akbal${Math.floor(1000 + Math.random() * 9000)}`; // e.g. "akbal4821"
    persistEnvVar("AP_PASSWORD", p);
    process.env.AP_PASSWORD = p;
  }
  return p;
};

export interface ApStatus {
  active: boolean;
  ssid: string;
  password: string;
  ip: string;
  url: string;
}

export const getApStatus = async (): Promise<ApStatus> => {
  let active = false;
  try {
    const out = await runNmcli(["-t", "-f", "NAME", "connection", "show", "--active"]);
    active = out.split("\n").some((l) => l.trim() === AP_CON_NAME);
  } catch {
    /* nmcli unavailable -> treat as inactive */
  }
  return {
    active,
    ssid: getSsid(),
    password: getPassword(),
    ip: AP_IP,
    url: `http://${AP_IP}:${WEB_PORT}`,
  };
};

export const getApQrCodes = async (
  status: ApStatus,
): Promise<{ wifiQr: string; urlQr: string }> => {
  // WIFI:...;; is the standard "scan to join a network" payload phones read.
  const wifiPayload = `WIFI:T:WPA;S:${status.ssid};P:${status.password};;`;
  const [wifiQr, urlQr] = await Promise.all([
    QRCode.toDataURL(wifiPayload, { margin: 1, width: 240 }),
    QRCode.toDataURL(status.url, { margin: 1, width: 240 }),
  ]);
  return { wifiQr, urlQr };
};

const DEVICE_WIFI_QR_PATH = path.join(os.tmpdir(), "akbal-ap-wifi-qr.png");
const DEVICE_URL_QR_PATH = path.join(os.tmpdir(), "akbal-ap-url-qr.png");

// Same "WIFI:...;;" payload as getApQrCodes' wifiQr, but rendered to a PNG
// file instead of a data URL — the physical LCD (wifi-connect-mode.ts) reads
// image files, unlike the web settings page's <img src>.
export const generateApConnectQrFile = async (status: ApStatus): Promise<string> => {
  const wifiPayload = `WIFI:T:WPA;S:${status.ssid};P:${status.password};;`;
  await QRCode.toFile(DEVICE_WIFI_QR_PATH, wifiPayload, {
    type: "png",
    width: 240,
    margin: 1,
    color: { dark: "#50ff78ff", light: "#0b0d0fff" },
  });
  return DEVICE_WIFI_QR_PATH;
};

// status.url is always the AP's own local address (http://10.42.0.1:8090),
// never a LAN/Tailscale hostname — the whole point of this screen is
// reaching the web admin with zero internet, so a phone that just joined the
// hotspot (no internet of its own yet either) can still resolve/open it.
export const generateApUrlQrFile = async (status: ApStatus): Promise<string> => {
  await QRCode.toFile(DEVICE_URL_QR_PATH, status.url, {
    type: "png",
    width: 240,
    margin: 1,
    color: { dark: "#50ff78ff", light: "#0b0d0fff" },
  });
  return DEVICE_URL_QR_PATH;
};

// How many devices are currently associated with the AP — used to
// auto-switch the device screen from "scan to join" to "scan to open the
// web" once a phone actually connects (see wifi-connect-mode.ts). `iw` is
// already in the passwordless sudoers rule the rest of wifi uses (see
// docs/wifi.md), so this needs no new permission.
export const getApClientCount = async (): Promise<number> => {
  try {
    const { stdout } = await execFileAsync("sudo", ["-n", "iw", "dev", AP_IFACE, "station", "dump"], {
      timeout: 5000,
    });
    return (stdout.match(/^Station /gm) || []).length;
  } catch {
    return 0;
  }
};

export const enableAp = async (): Promise<ApStatus> => {
  const ssid = getSsid();
  const pass = getPassword();
  // Rebuild a dedicated, named AP connection each time so it always matches the
  // current SSID/password, then bring it up (this is what drops the client wifi).
  await runNmcli(["connection", "delete", AP_CON_NAME]).catch(() => "");
  await runNmcli([
    "connection", "add", "type", "wifi", "ifname", AP_IFACE, "con-name", AP_CON_NAME,
    "autoconnect", "no", "ssid", ssid,
  ]);
  await runNmcli([
    "connection", "modify", AP_CON_NAME,
    "802-11-wireless.mode", "ap", "802-11-wireless.band", "bg",
    "ipv4.method", "shared",
    "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", pass,
  ]);
  await runNmcli(["connection", "up", AP_CON_NAME]);
  return getApStatus();
};

export const disableAp = async (): Promise<ApStatus> => {
  await runNmcli(["connection", "down", AP_CON_NAME]).catch(() => "");
  // Nudge NetworkManager to reconnect the normal (autoconnect) wifi.
  await runNmcli(["device", "connect", AP_IFACE]).catch(() => "");
  return getApStatus();
};
