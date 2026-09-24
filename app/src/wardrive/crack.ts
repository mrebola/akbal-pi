import { execFile } from "child_process";
import { promisify } from "util";
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
export async function crackCheck(capPath: string, password: string, bssid = ""): Promise<CrackResult> {
  const bssidArgs = bssid ? ["-b", bssid] : [];
  if (!password || !capPath || !fs.existsSync(capPath)) {
    return { verdict: "error", matched: false, eapolPackets: 0, handshakeHint: false, output: "captura o contraseña vacía" };
  }
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
    return crackCheckSpawn(capPath, password, bssid);
  }
}

// The real implementation: spawn so we can pipe the password to stdin.
// (execFile cannot write to the child's stdin; the catch above routes here.)
async function crackCheckSpawn(capPath: string, password: string, bssid = ""): Promise<CrackResult> {
  const { spawn } = await import("child_process");
  const bssidArgs = bssid ? ["-b", bssid] : [];
  return new Promise<CrackResult>((resolve) => {
    const child = spawn("aircrack-ng", ["-w", "-", ...bssidArgs, capPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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
    child.on("close", () => {
      clearTimeout(timer);
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