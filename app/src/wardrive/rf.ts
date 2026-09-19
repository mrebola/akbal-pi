import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const IW = "/usr/sbin/iw";

export async function setChannel(iface: string, channel: number): Promise<void> {
  await execFileAsync("sudo", ["-n", IW, "dev", iface, "set", "channel", String(channel)]);
}