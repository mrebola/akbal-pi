import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const IW = "/usr/sbin/iw";

// Monitor-mode control for wardriving. Not shared with
// wifiradar/monitor-control.ts on purpose: wardriving holds the AR9271 in
// monitor mode for a whole session and restores it on exit — a different
// lifecycle from wifiradar's capture-restore-per-run. Same in-place
// conversion (ath9k_htc rejects a second vif with "Device or resource
// busy", see wifiradar/monitor-control.ts for the full history).

async function waitForIfaceType(iface: string, expected: string, maxMs = 2000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(IW, ["dev", iface, "info"]);
      const match = stdout.match(/^\s*type\s+(\S+)/m);
      if (match && match[1] === expected) return;
    } catch {
      // interface may be briefly down mid-switch
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${iface} no llegó a type=${expected} a tiempo`);
}

export async function enterMonitorMode(iface: string): Promise<void> {
  await execFileAsync("sudo", ["-n", "ip", "link", "set", iface, "down"]);
  await execFileAsync("sudo", ["-n", IW, "dev", iface, "set", "type", "monitor"]);
  await execFileAsync("sudo", ["-n", "ip", "link", "set", iface, "up"]);
  await waitForIfaceType(iface, "monitor");
}

export async function exitMonitorMode(iface: string): Promise<void> {
  const script = [
    `ip link set ${iface} down`,
    `${IW} dev ${iface} set type managed`,
    `ip link set ${iface} up`,
  ].join(" && ");
  // Own systemd scope so the restore survives chatbot.service cgroup
  // teardown when wardriving is active at shutdown (same rationale as
  // wifiradar/monitor-control.ts exitMonitorMode).
  await execFileAsync("sudo", ["-n", "systemd-run", "--collect", "--scope", "--", "bash", "-c", script]);
}