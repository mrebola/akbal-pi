import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

// Handshake validation v2: the "captured" verdict is not enough — hcxpcapngtool
// counts a bare EAPOL M1 (PMKID or any half handshake) as "written". The lab
// workflow needs proof the capture actually contains a crackable handshake:
// run aircrack-ng against the .cap with the KNOWN lab password on stdin and
// read its verdict. "KEY FOUND" = the 4-way handshake is complete and valid;
// "not in dictionary"/"passphrase not in" with EAPOL frames seen = real
// handshake but wrong password; zero EAPOL = nothing usable.
//
// The password never touches disk: it is piped to aircrack's stdin via the
// -w - wordlist-from-stdin mode. (aircrack-ng reads passwords from stdin when
// the wordlist argument is "-".)

export type CrackVerdict =
  | "verified" // correct password — handshake complete and crackable
  | "handshake_wrong_password" // real handshake, password didn't match
  | "no_handshake" // capture has no EAPOL material at all
  | "error";

export type CrackResult = {
  verdict: CrackVerdict;
  matched: boolean; // true only when verdict === "verified"
  eapolPackets: number;
  handshakeHint: boolean; // aircrack's "handshake" mention in output
  output: string; // trimmed aircrack output for the UI log
  cancelled?: boolean; // killed by the user before finishing
};

function parseAircrackOutput(text: string): { eapol: number; hint: boolean; found: boolean; clean: string } {
  // aircrack prints lines like:
  //   "Reading packets, please wait..."
  //   "[00:00:01] 1234/5678 keys tested..." (cracking progress)
  //   "1 handshake(s) tested, ..." (session summary)
  //   "KEY FOUND! [ <the password> ]"  (success)
  //   "The passphrase is not in the dictionary / wordlist" (failure)
  //   "EAPOL packets: X" / "handshake(s)" — what proves usable EAPOL material.
  const eapolMatch = /(\d+)\s+handshake/i.exec(text);
  const eapol = eapolMatch ? parseInt(eapolMatch[1], 10) : 0;
  const found = /KEY FOUND/i.test(text);
  const hint = /handshake/i.test(text);
  // Strip ANSI cursor/escape codes — aircrack redraws a curses-style display
  // even in -q mode, and the raw text is shown in the UI log.
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-HJKSTfhlmnsu]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][0-9A-B]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return { eapol, hint, found, clean };
}

// Validate a capture against a candidate password. Never throws: any
// aircrack failure (missing file, bad cap) maps to verdict="error".
// bssid disambiguates when a .cap holds several networks (airodump with no
// --bssid or an hcxdumptool file) — pass the target's BSSID. "" = any AP.
// Returns a handle so the caller can cancel mid-run (the Cancel button).
export function crackCheck(capPath: string, password: string, bssid = ""): { promise: Promise<CrackResult>; cancel: () => void } {
  const bssidArgs = bssid ? ["-b", bssid] : [];
  if (!password || !capPath || !fs.existsSync(capPath)) {
    return {
      promise: Promise.resolve({ verdict: "error", matched: false, eapolPackets: 0, handshakeHint: false, output: "captura o contraseña vacía" }),
      cancel: () => {},
    };
  }
  let child: import("child_process").ChildProcess | null = null;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };
  const promise = (async (): Promise<CrackResult> => {
    try {
      const { stdout, stderr } = await execFileAsync("aircrack-ng", ["-w", "-", ...bssidArgs, capPath], {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const text = `${stdout}\n${stderr}`;
      const parsed = parseAircrackOutput(text);
      return {
        verdict: parsed.found ? "verified" : parsed.eapol > 0 ? "handshake_wrong_password" : "no_handshake",
        matched: parsed.found,
        eapolPackets: parsed.eapol,
        handshakeHint: parsed.hint,
        output: parsed.clean.slice(-4000),
      };
    } catch {
      // execFile can't write the child's stdin (the password list) — run
      // through spawn, which pipes the password and captures output itself.
      // The cancel() closure above sets `cancelled` directly; killRef routes
      // it to the spawned aircrack (which only exists once we get here).
      const result = await crackCheckSpawn(capPath, password, bssid, (c) => (child = c));
      return result;
    }
  })();
  return { promise, cancel };
}

// The real implementation: spawn so we can pipe the password to stdin.
// (execFile cannot write to the child's stdin; the caller's cancel hook
// reaches the spawned aircrack through the childRef indirection.)
async function crackCheckSpawn(
  capPath: string,
  password: string,
  bssid = "",
  setChild?: (c: import("child_process").ChildProcess) => void,
): Promise<CrackResult> {
  const { spawn } = await import("child_process");
  const bssidArgs = bssid ? ["-b", bssid] : [];
  return new Promise<CrackResult>((resolve) => {
    const child = spawn("aircrack-ng", ["-w", "-", ...bssidArgs, capPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    setChild?.(child);
    let out = "";
    const done = (result: CrackResult) => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        done({
          verdict: "error",
          matched: false,
          eapolPackets: 0,
          handshakeHint: false,
          output: "aircrack-ng timeout",
        }),
      120_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({
        verdict: "error",
        matched: false,
        eapolPackets: 0,
        handshakeHint: false,
        output: `aircrack-ng: ${err?.message || err}`,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === null || code === 137) {
        // Killed (SIGKILL from our cancel) — report as cancelled, not a
        // verdict, unless the output already shows a KEY FOUND race.
        const parsed = parseAircrackOutput(out);
        if (parsed.found) {
          done({
            verdict: "verified",
            matched: true,
            eapolPackets: parsed.eapol,
            handshakeHint: parsed.hint,
            output: parsed.clean.slice(-4000),
          });
          return;
        }
        done({
          verdict: "error",
          matched: false,
          eapolPackets: 0,
          handshakeHint: false,
          output: "cancelado por el usuario",
          cancelled: true,
        });
        return;
      }
      const parsed = parseAircrackOutput(out);
      done({
        verdict: parsed.found
          ? "verified"
          : parsed.eapol > 0 || parsed.hint
            ? "handshake_wrong_password"
            : "no_handshake",
        matched: parsed.found,
        eapolPackets: parsed.eapol,
        handshakeHint: parsed.hint,
        output: parsed.clean.slice(-4000),
      });
    });
    // Feed the password list: one password per line. Only our known lab
    // password, nothing else.
    child.stdin?.end(`${password}\n`);
  });
}

// Convert an .hc22000 (hashcat 22000) or raw .cap into a verdict, used by
// the wardrive session validation flow. The hc22000 needs hashcat, not
// aircrack — out of scope here; this helper is cap-only.
export function capFileFor(targetFiles: string[]): string | null {
  for (const f of targetFiles) {
    if (f.endsWith(".cap") || f.endsWith(".pcapng")) return f;
  }
  return null;
}

// Session-file helper: absolute path of the capture for a target's files
// (they are stored relative to the session dir).
export function resolveCapPath(sessionDir: string, files: string[]): string | null {
  for (const f of files) {
    if (/\.(cap|pcapng)$/i.test(f)) {
      const abs = path.isAbsolute(f) ? f : path.join(sessionDir, f);
      if (fs.existsSync(abs)) return abs;
    }
  }
  return null;
}

// Session-file helper: path of the converted hash, if any.
export function resolveHashPath(sessionDir: string, files: string[]): string | null {
  for (const f of files) {
    if (/\.hc22000$/i.test(f)) {
      const abs = path.isAbsolute(f) ? f : path.join(sessionDir, f);
      if (fs.existsSync(abs)) return abs;
    }
  }
  return null;
}

// ─── Dictionary crack (rockyou) ────────────────────────────────────────────
// aircrack-ng -w <wordlist> streams its progress line to stdout every ~2s:
//   "PROGRESS: 1234 (10.23%) 0.5 fps" (older) or
//   "[00:00:02] 1234/14344391 keys tested (10.5)..." on newer builds.
// We spawn it detached-ish (killable at any moment), parse the running
// counts, and surface { tried, total, fps } for the UI. Cancelling = kill
// the process group — same detached+group-kill pattern as the capture
// runners.
export type DictProgress = {
  tried: number;
  total: number;
  fps: number;
  elapsedSec: number;
};

export type DictCrackState = {
  running: boolean;
  progress: DictProgress;
  result: CrackResult | null;
};

export class DictCrack extends EventEmitter {
  private proc: any = null; // ChildProcess
  private running = false;
  private state: DictCrackState = {
    running: false,
    progress: { tried: 0, total: 0, fps: 0, elapsedSec: 0 },
    result: null,
  };

  constructor(
    private capPath: string,
    private bssid: string,
    private wordlist: string,
  ) {
    super();
  }

  getState(): DictCrackState {
    return { ...this.state, progress: { ...this.state.progress } };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.state = {
      running: true,
      progress: { tried: 0, total: 0, fps: 0, elapsedSec: 0 },
      result: null,
    };
    const startedAt = Date.now();
    const child = spawn("aircrack-ng", ["-w", this.wordlist, "-b", this.bssid, "-p", "2", this.capPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = child;
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      this.parseProgress(out, startedAt);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      this.running = false;
      this.state.running = false;
      this.state.result = { verdict: "error", matched: false, eapolPackets: 0, handshakeHint: false, output: `aircrack-ng: ${err?.message || err}` };
      this.emit("done", this.state);
    });
    child.on("close", (code) => {
      this.running = false;
      this.state.running = false;
      this.state.progress.elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const parsed = parseAircrackOutput(out);
      if (parsed.found) {
        this.state.result = {
          verdict: "verified",
          matched: true,
          eapolPackets: parsed.eapol,
          handshakeHint: parsed.hint,
          output: parsed.clean.slice(-4000),
        };
      } else if (this.dictExhausted(out)) {
        // Full run, no match.
        this.state.result = {
          verdict: "handshake_wrong_password",
          matched: false,
          eapolPackets: parsed.eapol,
          handshakeHint: parsed.hint,
          output: parsed.clean.slice(-4000),
        };
      } else {
        // Cancelled mid-run: keep partial info, no final verdict.
        this.state.result = {
          verdict: "error",
          matched: false,
          eapolPackets: parsed.eapol,
          handshakeHint: parsed.hint,
          output: `cancelado tras ${this.state.progress.tried} contraseñas`,
        };
      }
      this.emit("done", this.state);
    });
  }

  // "KEY NOT FOUND" + reaching the end of the wordlist = exhausted. A SIGTERM
  // kill leaves no such summary — that's how cancelled runs are told apart.
  private dictExhausted(text: string): boolean {
    return /KEY NOT FOUND|not in dictionary|passphrase not in/i.test(text) || /(\d+) keys tested/i.test(text);
  }

  stop(): void {
    if (this.proc?.pid) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  // aircrack progress lines look like:
  //   "[00:00:02] 1234/14344391 keys tested (12.34 fps)"
  // or the PROGRESS: variant. Grab the LAST match.
  private parseProgress(text: string, startedAt: number): void {
    const matches = [...text.matchAll(/\[(\d+):(\d+):(\d+)\]\s+(\d+)\/(\d+)\s+keys tested.*?\(([\d.]+)\s*fps\)/g)];
    if (matches.length > 0) {
      const m = matches[matches.length - 1];
      const elapsed = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
      this.state.progress = {
        tried: parseInt(m[4], 10),
        total: parseInt(m[5], 10),
        fps: parseFloat(m[6]),
        elapsedSec: elapsed,
      };
    } else {
      this.state.progress.elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    }
  }
}