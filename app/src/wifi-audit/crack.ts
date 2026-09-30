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

// ─── Mask / stdin wordlist attack (Crack Station) ──────────────────────────
// Brute-force recipes compile to a mask pattern fed to aircrack-ng's
// `--wep/-w` stdin equivalent: we GENERATE the candidate list locally
// (same semantics as `crunch <len> <len> -t <pattern> | aircrack-ng -w -`)
// so no extra tooling is needed on the Pi. Pattern syntax (crunch-style):
//   @ = 0-9 a-z ... we keep it tight: @ = dígito (0-9), # = minúscula (a-z)
//   any other char = literal. `autoMacSuffix` replaces a literal "@@@@"-like
//   trailing marker with the target's last-4 MAC hex at spawn time — but the
//   UI bakes that in client-side; here pattern is already the final literal.
export type MaskRunState = {
  running: boolean;
  pattern: string;
  bssid: string;
  progress: DictProgress;
  result: CrackResult | null;
};

// Count the total candidates a mask will produce (for the progress bar).
export function maskTotal(pattern: string): number {
  let total = 1;
  for (const ch of pattern) {
    if (ch === "@") total *= 10; // dígito 0-9
    else if (ch === "#") total *= 26; // minúscula a-z
    else if (ch === "$") total *= 16; // hex 0-9a-f
  }
  return total;
}

// Deterministic order: vary the RIGHTmost wildcard fastest (like crunch -t).
function maskAt(pattern: string, index: number): string {
  let rest = index;
  const chars: string[] = [];
  for (let i = pattern.length - 1; i >= 0; i--) {
    const ch = pattern[i];
    if (ch === "@") {
      chars.unshift(String(rest % 10));
      rest = Math.floor(rest / 10);
    } else if (ch === "#") {
      chars.unshift(String.fromCharCode(97 + (rest % 26)));
      rest = Math.floor(rest / 26);
    } else if (ch === "$") {
      chars.unshift("0123456789abcdef"[rest % 16]);
      rest = Math.floor(rest / 16);
    } else {
      chars.unshift(ch);
    }
  }
  return chars.join("");
}

export class MaskCrack extends EventEmitter {
  private proc: any = null;
  private running = false;
  private state: DictCrackState = {
    running: false,
    progress: { tried: 0, total: 0, fps: 0, elapsedSec: 0 },
    result: null,
  };

  constructor(
    private capPath: string,
    private bssid: string,
    private pattern: string,
  ) {
    super();
  }

  getState(): DictCrackState {
    return { ...this.state, progress: { ...this.state.progress } };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const total = maskTotal(this.pattern);
    this.state = {
      running: true,
      progress: { tried: 0, total, fps: 0, elapsedSec: 0 },
      result: null,
    };
    const startedAt = Date.now();
    const child = spawn("aircrack-ng", ["-w", "-", "-b", this.bssid, "-p", "2", this.capPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = child;
    let out = "";
    // Pipe candidates in bounded batches so we can parse progress between
    // writes and cancel stays responsive (no multi-GB stdin buffering).
    const writeChunk = (from: number): void => {
      if (this.state.result) return;
      const step = Math.max(1, Math.floor(total / 5000) || 1);
      let buf = "";
      let wrote = 0;
      for (let i = from; i < Math.min(from + step * 50, total); i++) {
        buf += maskAt(this.pattern, i) + "\n";
      }
      const upTo = Math.min(from + step * 50, total);
      if (upTo >= total) {
        child.stdin?.end(buf);
        return;
      }
      child.stdin?.write(buf, () => {
        this.state.progress.tried = upTo;
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000) || 1;
        this.state.progress.elapsedSec = elapsedSec;
        this.state.progress.fps = upTo / elapsedSec;
        setTimeout(() => writeChunk(upTo), 300);
      });
    };
    writeChunk(0);
    void total;
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
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
      } else if (code === null || code === 137) {
        this.state.result = {
          verdict: "error",
          matched: false,
          eapolPackets: parsed.eapol,
          handshakeHint: parsed.hint,
          output: `cancelado tras ${this.state.progress.tried} contraseñas`,
        };
      } else {
        this.state.result = {
          verdict: "handshake_wrong_password",
          matched: false,
          eapolPackets: parsed.eapol,
          handshakeHint: parsed.hint,
          output: parsed.clean.slice(-4000),
        };
      }
      this.emit("done", this.state);
    });
  }

  stop(): void {
    if (this.proc?.pid) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
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

// Where the candidate passwords come from: a plain file aircrack-ng opens
// itself (rockyou — small enough to keep decompressed, and aircrack can
// pre-scan it for a total), or a gzip wordlist too big to decompress to
// disk (weakpass) — streamed straight into aircrack's stdin via `zcat`, so
// only the compressed .gz ever touches disk. `knownTotal`, when known
// (see gzipLineCount below), lets the UI still show a real percentage even
// though aircrack itself can't pre-scan a pipe.
export type DictSource =
  | { kind: "file"; path: string }
  | { kind: "gzip"; path: string; knownTotal: number | null };

export class DictCrack extends EventEmitter {
  private proc: any = null; // ChildProcess (aircrack-ng)
  private zcatProc: any = null; // ChildProcess (zcat, gzip source only)
  private running = false;
  private knownTotal: number | null;
  private state: DictCrackState = {
    running: false,
    progress: { tried: 0, total: 0, fps: 0, elapsedSec: 0 },
    result: null,
  };

  constructor(
    private capPath: string,
    private bssid: string,
    private source: DictSource,
  ) {
    super();
    this.knownTotal = this.source.kind === "gzip" ? this.source.knownTotal : null;
  }

  getState(): DictCrackState {
    return { ...this.state, progress: { ...this.state.progress } };
  }

  // Backfills the total once gzipLineCount() resolves (it's kicked off in
  // parallel with start(), never blocking the crack launch on it — counting
  // a multi-GB wordlist can take minutes on first run). Only takes effect
  // if aircrack's own progress lines haven't already reported one.
  setKnownTotal(n: number): void {
    this.knownTotal = n;
    if (!this.state.progress.total) this.state.progress.total = n;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.state = {
      running: true,
      progress: { tried: 0, total: this.knownTotal || 0, fps: 0, elapsedSec: 0 },
      result: null,
    };
    const startedAt = Date.now();
    let child: any;
    if (this.source.kind === "gzip") {
      // zcat's stdout feeds aircrack's stdin directly (Node-level pipe, no
      // shell) — the decompressed wordlist never exists as a file, only as
      // bytes in flight between the two processes.
      const zcat = spawn("zcat", [this.source.path], { stdio: ["ignore", "pipe", "ignore"] });
      this.zcatProc = zcat;
      child = spawn("aircrack-ng", ["-w", "-", "-b", this.bssid, "-p", "2", this.capPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      zcat.stdout?.pipe(child.stdin);
      zcat.on("error", () => {
        // aircrack just sees stdin close early and reports "exhausted" —
        // dictExhausted()/close handler below cover that case already.
      });
    } else {
      child = spawn("aircrack-ng", ["-w", this.source.path, "-b", this.bssid, "-p", "2", this.capPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    this.proc = child;
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      this.parseProgress(out, startedAt);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", (err: any) => {
      this.running = false;
      this.state.running = false;
      this.state.result = { verdict: "error", matched: false, eapolPackets: 0, handshakeHint: false, output: `aircrack-ng: ${err?.message || err}` };
      this.emit("done", this.state);
    });
    child.on("close", (code: number | null) => {
      this.running = false;
      this.state.running = false;
      this.state.progress.elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      try {
        this.zcatProc?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      this.zcatProc = null;
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
    if (this.zcatProc?.pid) {
      try {
        this.zcatProc.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
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
  // when it read the wordlist from a real file (it pre-scans it for the
  // total) — but fed via stdin (gzip source) it can't know a total in
  // advance, so the line drops the "/total" part entirely:
  //   "[00:00:02] 1234 keys tested (12.34 fps)"
  // The "/(\d+)" group is optional to cover both; when it's missing, fall
  // back to knownTotal (gzipLineCount()'s cached count, if it's in yet).
  private parseProgress(text: string, startedAt: number): void {
    const matches = [...text.matchAll(/\[(\d+):(\d+):(\d+)\]\s+(\d+)(?:\/(\d+))?\s+keys tested.*?\(([\d.]+)\s*fps\)/g)];
    if (matches.length > 0) {
      const m = matches[matches.length - 1];
      const elapsed = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
      this.state.progress = {
        tried: parseInt(m[4], 10),
        total: m[5] ? parseInt(m[5], 10) : this.knownTotal || 0,
        fps: parseFloat(m[6]),
        elapsedSec: elapsed,
      };
    } else {
      this.state.progress.elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    }
  }
}

// Counting a multi-GB gzip wordlist's lines costs real time (a full
// decompress-and-scan pass — minutes on a Pi for a 10GB .gz) so it's
// cached next to the .gz, fingerprinted by that file's size: a changed
// size invalidates the cache and forces a recount, a same-size file never
// recounts. Returns null if the .gz doesn't exist or counting fails —
// callers treat that as "no known total yet", not an error (the crack
// still runs fine, the UI just can't show a percentage for it).
export async function gzipLineCount(gzPath: string): Promise<number | null> {
  const cacheFile = `${gzPath}.linecount`;
  let gzSize: number;
  try {
    gzSize = (await fs.promises.stat(gzPath)).size;
  } catch {
    return null;
  }
  try {
    const cached = await fs.promises.readFile(cacheFile, "utf8");
    const [cachedCount, cachedSize] = cached.trim().split(":");
    const n = parseInt(cachedCount, 10);
    if (Number.isFinite(n) && n > 0 && Number(cachedSize) === gzSize) return n;
  } catch {
    /* no cache yet, or unreadable — count it below */
  }
  return new Promise((resolve) => {
    const zcat = spawn("zcat", [gzPath], { stdio: ["ignore", "pipe", "ignore"] });
    const wc = spawn("wc", ["-l"], { stdio: ["pipe", "pipe", "ignore"] });
    zcat.stdout?.pipe(wc.stdin);
    let out = "";
    wc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const finish = async (n: number | null) => {
      if (n && Number.isFinite(n) && n > 0) {
        try {
          await fs.promises.writeFile(cacheFile, `${n}:${gzSize}`);
        } catch {
          /* cache write failure is non-fatal — just recounts next time */
        }
      }
      resolve(n && Number.isFinite(n) && n > 0 ? n : null);
    };
    wc.on("close", () => finish(parseInt(out.trim(), 10)));
    wc.on("error", () => finish(null));
    zcat.on("error", () => finish(null));
  });
}
