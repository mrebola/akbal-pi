import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const IW = "/usr/sbin/iw";

async function getIfaceType(iface: string): Promise<string> {
  const { stdout } = await execFileAsync(IW, ["dev", iface, "info"]);
  const match = stdout.match(/^\s*type\s+(\S+)/m);
  return match ? match[1] : "";
}

const MODE_SWITCH_POLL_MS = 150;
const MODE_SWITCH_MAX_ATTEMPTS = 10;

// Polls until the driver actually reports the expected type instead of
// trusting the `iw ... set type` call's own success exit code — on this
// hardware the ath9k_htc driver can take a beat to settle after `ip link
// set up`, and starting dumpcap (see capture.ts) before that finishes
// compiles its 802.11 BPF filter against the *old* link-layer type and
// fails outright. A few hundred ms of polling is cheap insurance against
// that race.
async function waitForIfaceType(iface: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < MODE_SWITCH_MAX_ATTEMPTS; attempt++) {
    const type = await getIfaceType(iface).catch(() => "");
    if (type === expected) return;
    await new Promise((resolve) => setTimeout(resolve, MODE_SWITCH_POLL_MS));
  }
  throw new Error(`${iface} didn't settle into type=${expected} in time`);
}

// Converts the AR9271's own interface in place (down -> set type monitor ->
// up) instead of adding a second virtual interface on the same phy —
// ath9k_htc's multi-vif support returned "Device or resource busy" in
// testing on this exact card, while in-place conversion is reliable. This
// never touches wlan0/phy0 (the onboard radio carrying Tailscale/LAN) —
// the caller always passes the AR9271's own iface name from ar9271.ts.
export async function enterMonitorMode(iface: string): Promise<void> {
  await execFileAsync("sudo", ["-n", "ip", "link", "set", iface, "down"]);
  await execFileAsync("sudo", ["-n", IW, "dev", iface, "set", "type", "monitor"]);
  await execFileAsync("sudo", ["-n", "ip", "link", "set", iface, "up"]);
  await waitForIfaceType(iface, "monitor");
}

// Runs the whole down/managed/up sequence as ONE command inside a brand
// new, independent systemd scope (`systemd-run --scope`) instead of three
// plain execFile calls in-process. This matters specifically here (not for
// enterMonitorMode) because exitMonitorMode only ever runs during shutdown
// — chatbot.service's own cgroup is being torn down by systemd at that
// exact moment (KillMode=control-group signals the whole cgroup at once),
// and testing on this device showed node's in-process execFile chain
// reliably got cut off partway through (interface left down, still in
// monitor type) before finishing. A `systemd-run --scope` command lives in
// its *own* scope/cgroup from the moment it's created, so it keeps running
// to completion independent of chatbot.service's own teardown.
export async function exitMonitorMode(iface: string): Promise<void> {
  const script = [
    `ip link set ${iface} down`,
    `${IW} dev ${iface} set type managed`,
    `ip link set ${iface} up`,
  ].join(" && ");
  await execFileAsync("sudo", ["-n", "systemd-run", "--collect", "--scope", "--", "bash", "-c", script]);
}

export async function setChannel(iface: string, channel: number): Promise<void> {
  await execFileAsync("sudo", ["-n", IW, "dev", iface, "set", "channel", String(channel)]);
}

// Only channels the driver itself reports as available for this phy — the
// regulatory domain is already enforced by the kernel/driver, so filtering
// down to "whatever `iw phy info` lists" is enough to stay compliant
// without AIRSPACE needing its own regulatory-domain logic.
export async function getAvailable24GhzChannels(phy: string): Promise<number[]> {
  const { stdout } = await execFileAsync(IW, ["phy", phy, "info"]);
  const channels = new Set<number>();
  // Lines look like: "* 2412.0 MHz [1] (20.0 dBm)" — [N] is the channel
  // number; only 2.4GHz (channel 1-14, freq 2400-2500) is in scope per the
  // AIRSPACE spec (5GHz has far more channels and DFS rules that make
  // casual hopping riskier — out of scope here).
  for (const line of stdout.split("\n")) {
    const match = line.match(/\*\s+(\d+(?:\.\d+)?)\s+MHz\s+\[(\d+)\]/);
    if (!match) continue;
    const freq = parseFloat(match[1]);
    const channel = parseInt(match[2], 10);
    if (freq >= 2400 && freq <= 2500 && line.includes("disabled") === false) {
      channels.add(channel);
    }
  }
  return [...channels].sort((a, b) => a - b);
}
