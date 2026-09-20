import { execFile } from "child_process";
import { promisify } from "util";
import dotenv from "dotenv";

dotenv.config();

const execFileAsync = promisify(execFile);

// All wifi control goes through `nmcli` (NetworkManager, the default on
// current Raspberry Pi OS). Scanning/connecting needs a polkit "auth" grant
// that a systemd service (no active login session) doesn't get by default,
// so this runs nmcli via `sudo -n` — see docs/wifi.md for the scoped
// sudoers rule that makes this work without an interactive password.
// `-n` fails fast instead of hanging if that rule isn't installed.
const NMCLI = ["sudo", "-n", "nmcli"];

async function runNmcli(args: string[]): Promise<string> {
  const [cmd, ...rest] = [...NMCLI, ...args];
  const { stdout } = await execFileAsync(cmd, rest, { timeout: 25000 });
  return stdout;
}

export type WifiNetwork = {
  ssid: string;
  signal: number;
  secure: boolean;
  saved: boolean;
  active: boolean;
};

export type WifiStatus = {
  connected: boolean;
  ssid: string | null;
};

// nmcli's `-t` (terse) output uses ":" as a field separator, and escapes a
// literal ":" inside a field as "\:" — this undoes that so an SSID with a
// colon in it doesn't get split into the wrong number of fields.
function splitTerseLine(line: string): string[] {
  return line.split(/(?<!\\):/).map((field) => field.replace(/\\:/g, ":"));
}

export async function getWifiStatus(): Promise<WifiStatus> {
  try {
    const output = await runNmcli(["-t", "-f", "active,ssid", "dev", "wifi"]);
    for (const line of output.split("\n")) {
      const [active, ssid] = splitTerseLine(line);
      if (active === "yes" && ssid) {
        return { connected: true, ssid };
      }
    }
    return { connected: false, ssid: null };
  } catch (err) {
    console.warn("[wifi] getWifiStatus failed:", err);
    return { connected: false, ssid: null };
  }
}

// Triggers a fresh scan, then lists what's in range — deduped by SSID
// (nmcli lists one row per BSSID, so a network with multiple access points
// shows once here, keeping the strongest signal), cross-referenced against
// saved connections so the caller can tell "known network back in range"
// apart from "never seen before".
export async function scanWifiNetworks(): Promise<WifiNetwork[]> {
  try {
    await runNmcli(["dev", "wifi", "rescan"]).catch(() => {
      // Rescan can fail if one just ran recently (NetworkManager rate-limits
      // it) — the list below still returns the last scan's results, so this
      // isn't fatal.
    });
    const [listOutput, profiles] = await Promise.all([
      runNmcli(["-t", "-f", "active,ssid,signal,security", "dev", "wifi", "list"]),
      listWifiConnectionProfiles(),
    ]);
    // Matched by each profile's actual SSID (see listWifiConnectionProfiles),
    // not by comparing the SSID to the connection *profile name* — those
    // aren't the same on this device (netplan names it "netplan-wlan0-warp"
    // for SSID "warp"), which silently made every saved network show up as
    // "never seen before" here.
    const savedSsids = new Set(profiles.map((p) => p.ssid));
    const bySsid = new Map<string, WifiNetwork>();
    for (const line of listOutput.split("\n")) {
      const [active, ssid, signalRaw, security] = splitTerseLine(line);
      if (!ssid) continue;
      const signal = parseInt(signalRaw, 10) || 0;
      const existing = bySsid.get(ssid);
      if (existing && existing.signal >= signal) continue;
      bySsid.set(ssid, {
        ssid,
        signal,
        secure: Boolean(security) && security !== "--",
        saved: savedSsids.has(ssid),
        active: active === "yes",
      });
    }
    return [...bySsid.values()].sort((a, b) => b.signal - a.signal);
  } catch (err) {
    console.warn("[wifi] scanWifiNetworks failed:", err);
    return [];
  }
}

export type WifiScanDetail = {
  ssid: string;
  bssid: string;
  channel: number;
  freqMhz: number;
  signalPercent: number;
  signalDbm: number;
  distanceMeters: number;
  security: string;
  active: boolean;
};

// nmcli only reports a 0-100 "quality" percentage, normalized from the raw
// RSSI. This undoes that using the same linear mapping NetworkManager uses
// internally (0% = -100dBm, 100% = -50dBm, see src/linux/wifi-utils-nl80211.c
// upstream) — an approximation of the original dBm, not a second real
// measurement.
function percentToDbm(percent: number): number {
  return Math.round(percent / 2 - 100);
}

// Log-distance path loss model — the standard RSSI-to-distance estimate
// used by BLE/WiFi proximity apps: distance = 10 ^ ((measuredPower - rssi) / (10 * n))
// measuredPower is the expected RSSI at 1m (~-40dBm for a typical AP), n is
// the path-loss exponent (2 = free space/no obstacles, higher indoors with
// walls in the way — 2.7 is a reasonable "average home" middle ground).
// This is a rough order-of-magnitude estimate: real indoor RSSI is noisy
// and non-monotonic with distance, not a precise measurement.
const RSSI_AT_1M_DBM = -40;
const PATH_LOSS_EXPONENT = 2.7;
function estimateDistanceMeters(dbm: number): number {
  const meters = Math.pow(10, (RSSI_AT_1M_DBM - dbm) / (10 * PATH_LOSS_EXPONENT));
  return Math.round(meters * 10) / 10;
}

// Per-BSSID (not deduped by SSID like scanWifiNetworks) — the "RF analysis"
// panel wants to show every individual access point in range, including
// multiple APs broadcasting the same SSID (mesh systems, dual-band
// routers), each with its own real signal reading.
export async function scanWifiNetworksDetailed(): Promise<WifiScanDetail[]> {
  try {
    await runNmcli(["dev", "wifi", "rescan"]).catch(() => {});
    const output = await runNmcli([
      "-t",
      "-f",
      "active,ssid,bssid,chan,freq,signal,security",
      "dev",
      "wifi",
      "list",
    ]);
    const results: WifiScanDetail[] = [];
    for (const line of output.split("\n")) {
      const [active, ssid, bssid, chanRaw, freqRaw, signalRaw, security] = splitTerseLine(line);
      if (!bssid) continue;
      const signalPercent = parseInt(signalRaw, 10) || 0;
      const signalDbm = percentToDbm(signalPercent);
      results.push({
        ssid: ssid || "(oculta)",
        bssid,
        channel: parseInt(chanRaw, 10) || 0,
        freqMhz: parseInt(freqRaw, 10) || 0,
        signalPercent,
        signalDbm,
        distanceMeters: estimateDistanceMeters(signalDbm),
        security: security && security !== "--" ? security : "abierta",
        active: active === "yes",
      });
    }
    return results.sort((a, b) => b.signalPercent - a.signalPercent);
  } catch (err) {
    console.warn("[wifi] scanWifiNetworksDetailed failed:", err);
    return [];
  }
}

// NetworkManager connection *profile names* aren't necessarily the SSID —
// on this device (netplan-managed NetworkManager, common on current
// Raspberry Pi OS) a profile for SSID "warp" is actually named
// "netplan-wlan0-warp". Every function below that needs to act on "the
// saved connection for this SSID" (forget, read its password) has to
// resolve the real profile name first — using the SSID directly as if it
// were the profile name silently fails (confirmed: `nmcli connection
// delete warp` errors "unknown connection" on this exact device).
async function listWifiConnectionProfiles(): Promise<{ name: string; ssid: string }[]> {
  const namesOutput = await runNmcli(["-t", "-f", "name,type", "connection", "show"]);
  const names = namesOutput
    .split("\n")
    .map((line) => splitTerseLine(line))
    .filter(([, type]) => type === "802-11-wireless")
    .map(([name]) => name)
    .filter(Boolean);
  const profiles = await Promise.all(
    names.map(async (name) => {
      const ssid = (
        await runNmcli(["-g", "802-11-wireless.ssid", "connection", "show", name]).catch(() => "")
      ).trim();
      return { name, ssid };
    }),
  );
  return profiles.filter((p) => p.ssid);
}

async function findWifiConnectionName(ssid: string): Promise<string | null> {
  const profiles = await listWifiConnectionProfiles();
  return profiles.find((p) => p.ssid === ssid)?.name || null;
}

export async function connectToWifi(
  ssid: string,
  password?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (password) {
      await runNmcli(["dev", "wifi", "connect", ssid, "password", password]);
    } else {
      // No password given: try bringing up an already-saved connection
      // (open networks, or one already configured) before giving up —
      // `dev wifi connect` without a password only works for genuinely
      // open networks. Resolves the real profile name first (see above);
      // falls back to `dev wifi connect` (which does its own SSID
      // matching internally) if that lookup comes up empty for any reason.
      const connectionName = await findWifiConnectionName(ssid);
      if (connectionName) {
        await runNmcli(["connection", "up", connectionName]).catch(() =>
          runNmcli(["dev", "wifi", "connect", ssid]),
        );
      } else {
        await runNmcli(["dev", "wifi", "connect", ssid]);
      }
    }
    return { ok: true };
  } catch (err: any) {
    const message = err?.stderr || err?.message || String(err);
    console.warn(`[wifi] connectToWifi(${ssid}) failed:`, message);
    return { ok: false, error: message };
  }
}

export async function forgetWifi(ssid: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const connectionName = (await findWifiConnectionName(ssid)) || ssid;
    await runNmcli(["connection", "delete", connectionName]);
    return { ok: true };
  } catch (err: any) {
    const message = err?.stderr || err?.message || String(err);
    console.warn(`[wifi] forgetWifi(${ssid}) failed:`, message);
    return { ok: false, error: message };
  }
}

// A 64-hex-char secret is a pre-derived WPA PSK (PBKDF2 of SSID+passphrase,
// 256 bits) rather than the raw passphrase NetworkManager was originally
// given — some tools save it that way, and PSK derivation is one-way, so
// there's no way to recover the original password from it. Only a plain
// passphrase-shaped secret can actually be shown back to the user.
const RAW_PSK_HASH_RE = /^[0-9a-f]{64}$/i;

export async function getSavedWifiPassword(
  ssid: string,
): Promise<{ ok: boolean; password?: string; recoverable?: boolean; error?: string }> {
  try {
    const connectionName = await findWifiConnectionName(ssid);
    if (!connectionName) {
      return { ok: false, error: "No hay una red guardada con ese nombre" };
    }
    const secret = (
      await runNmcli(["-s", "-g", "802-11-wireless-security.psk", "connection", "show", connectionName])
    ).trim();
    if (!secret) {
      return { ok: true, recoverable: false, error: "La red guardada no tiene contraseña (o es abierta)" };
    }
    if (RAW_PSK_HASH_RE.test(secret)) {
      return {
        ok: true,
        recoverable: false,
        error: "La contraseña se guardó como hash y no se puede recuperar en texto plano",
      };
    }
    return { ok: true, recoverable: true, password: secret };
  } catch (err: any) {
    const message = err?.stderr || err?.message || String(err);
    console.warn(`[wifi] getSavedWifiPassword(${ssid}) failed:`, message);
    return { ok: false, error: message };
  }
}
