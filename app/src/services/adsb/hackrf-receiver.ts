import { execFile, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import net from "net";
import { EventEmitter } from "events";
import { parseSbsLine } from "./sbs-parser";

const execFileAsync = promisify(execFile);

const ADSB_FREQ_HZ = 1_090_000_000;
// dump1090's Mode-S demodulator hardcodes MODES_DEFAULT_RATE = 2,000,000 Hz
// (2 samples/µs, matching the 1Mbit/s PPM encoding) — NOT 2.4MSPS. Feeding
// it any other rate silently desyncs its bit timing and decodes garbage;
// this must stay 2,000,000 to match dump1090.c, not HackRF's own default.
const SAMPLE_RATE_HZ = 2_000_000;
const SBS_PORT = 30003; // dump1090 --net-sbs-port: plain-text BaseStation feed
const SBS_HOST = "127.0.0.1";
const SBS_CONNECT_RETRY_MS = 500;
const SBS_CONNECT_TIMEOUT_MS = 10_000;

export type HackRfInfo = {
  present: boolean;
  serial: string | null;
  boardId: string | null;
};

// hackrf_info already does the USB enumeration itself (unlike the AR9271
// path in wifiradar/adapter.ts, which has to walk /sys/class/net by hand
// because there's no "iw-info"-style single command for it) — just run it
// and read what it printed.
export async function detectHackRf(): Promise<HackRfInfo> {
  try {
    const { stdout } = await execFileAsync("hackrf_info", [], { timeout: 8000 });
    if (!/Found HackRF/i.test(stdout)) {
      return { present: false, serial: null, boardId: null };
    }
    const serial = /Serial number:\s*(\S+)/i.exec(stdout)?.[1] || null;
    const boardId = /Board ID Number:.*\(([^)]+)\)/i.exec(stdout)?.[1] || "HackRF One";
    return { present: true, serial, boardId };
  } catch {
    return { present: false, serial: null, boardId: null };
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Spawns `hackrf_transfer | dump1090` as one shell pipeline (same reasoning
// as wifiradar/capture.ts's dumpcap|tshark: a real shell pipe, not two
// Node-spawned children wired together with .pipe(), avoids the child
// rejecting stdin as a "special file") and reads dump1090's decoded output
// back over its SBS-1/BaseStation TCP port instead of parsing its stdout —
// dump1090 doesn't have a "-T fields"-style text stdout mode the way tshark
// does, so this is the equivalent plain-text tap for it.
//
// SECURITY: hackrf_transfer is only ever invoked with `-r -` (receive to
// stdout). This module must never add `-t` (transmit from file) or any
// other TX-enabling flag — see AGENTS.md's RX-only requirement for this
// feature. dump1090 itself has no transmit capability at all.
export class AdsbReceiver extends EventEmitter {
  private proc: ChildProcess | null = null;
  private sbsSocket: net.Socket | null = null;
  private sbsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sbsBuffer = "";
  private running = false;

  start(gain = 40): void {
    if (this.running) return;
    this.running = true;

    const hackrfCmd = [
      "hackrf_transfer",
      "-r",
      "-", // receive to stdout — never "-t" (transmit)
      "-f",
      String(ADSB_FREQ_HZ),
      "-s",
      String(SAMPLE_RATE_HZ),
      "-a",
      "1", // RF amp on
      "-l",
      "16", // baseband (LNA) gain
      "-g",
      String(gain), // VGA gain
    ].join(" ");
    const dump1090Cmd = [
      "dump1090",
      "--ifile",
      "-",
      "--net",
      "--net-sbs-port",
      String(SBS_PORT),
      "--quiet",
    ].join(" ");

    // detached: true so stop() can kill the whole process group — same
    // rationale as wifiradar/capture.ts (killing bash's own pid alone
    // wouldn't reliably reach hackrf_transfer/dump1090 too).
    this.proc = spawn("bash", ["-c", `${hackrfCmd} | ${dump1090Cmd}`], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    this.proc.stderr?.on("data", (chunk: Buffer) => this.logStderr(chunk));
    this.proc.on("exit", (code, signal) => {
      if (!this.running) return; // stop() already called intentionally
      this.running = false;
      this.emit("exit", { code, signal });
    });
    this.proc.on("error", (err) => {
      // Same post-stop guard as wifiradar/capture.ts: an "error" emitted
      // with zero listeners crashes the whole process.
      if (!this.running) return;
      this.running = false;
      this.emit("error", err);
    });

    this.connectSbs();
  }

  // hackrf_transfer prints routine status to stderr (its config echo at
  // startup, a throughput/power line once a second, "Stop with Ctrl-C") —
  // none of that is an error, same "filter the expected noise" reasoning as
  // wifiradar/capture.ts's logStderr for dumpcap's startup/summary lines.
  private logStderr(chunk: Buffer): void {
    const text = chunk.toString("utf8").trim();
    if (text && !/^call hackrf_|MiB\/second|^Stop with Ctrl-C/.test(text)) {
      console.warn("[aircraft-radar] receiver:", text);
    }
  }

  // dump1090 needs a moment after spawn before its SBS listener is up, and
  // the connection can also legitimately drop mid-session (dump1090
  // restarted, hackrf_transfer glitched) — retry on a timer either way
  // instead of treating a failed connect as fatal.
  private connectSbs(): void {
    if (!this.running) return;
    const socket = net.createConnection({ host: SBS_HOST, port: SBS_PORT, timeout: SBS_CONNECT_TIMEOUT_MS });
    this.sbsSocket = socket;
    socket.on("connect", () => {
      socket.setTimeout(0);
      this.sbsBuffer = "";
    });
    socket.on("data", (chunk: Buffer) => this.onSbsData(chunk));
    const scheduleReconnect = () => {
      if (!this.running || this.sbsReconnectTimer) return;
      socket.destroy();
      this.sbsReconnectTimer = setTimeout(() => {
        this.sbsReconnectTimer = null;
        this.connectSbs();
      }, SBS_CONNECT_RETRY_MS);
    };
    socket.on("timeout", scheduleReconnect);
    socket.on("error", scheduleReconnect);
    socket.on("close", scheduleReconnect);
  }

  private onSbsData(chunk: Buffer): void {
    this.sbsBuffer += chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = this.sbsBuffer.indexOf("\n")) >= 0) {
      const line = this.sbsBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.sbsBuffer = this.sbsBuffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      const parsed = parseSbsLine(line);
      if (parsed) this.emit("message", parsed);
    }
  }

  stop(): void {
    this.running = false;
    if (this.sbsReconnectTimer) {
      clearTimeout(this.sbsReconnectTimer);
      this.sbsReconnectTimer = null;
    }
    this.sbsSocket?.removeAllListeners();
    this.sbsSocket?.destroy();
    this.sbsSocket = null;
    if (this.proc) {
      try {
        process.kill(-this.proc.pid!, "SIGTERM");
      } catch {
        try {
          this.proc.kill("SIGTERM");
        } catch {
          // Already gone — nothing left to kill.
        }
      }
      this.proc = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
