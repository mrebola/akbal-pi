import { execFile, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import fs from "fs";
import net from "net";
import { EventEmitter } from "events";
import { parseSbsLine } from "./sbs-parser";

const execFileAsync = promisify(execFile);

const SBS_PORT = 30003; // readsb --net-sbs-port: plain-text BaseStation feed
const SBS_HOST = "127.0.0.1";
const SBS_CONNECT_RETRY_MS = 500;
const SBS_CONNECT_TIMEOUT_MS = 10_000;

export type HackRfInfo = {
  present: boolean;
  serial: string | null;
  boardId: string | null;
  // Set only when present=false and we know WHY beyond "nothing plugged
  // in" — see portapackReason() below. Lets the caller throw an
  // actionable error instead of the generic "no está conectado".
  reason?: string;
};

// hackrf_info already does the USB enumeration itself (unlike the AR9271
// path in wifiradar/adapter.ts, which has to walk /sys/class/net by hand
// because there's no "iw-info"-style single command for it) — just run it
// and read what it printed.
export async function detectHackRf(): Promise<HackRfInfo> {
  try {
    const { stdout } = await execFileAsync("hackrf_info", [], { timeout: 8000 });
    if (!/Found HackRF/i.test(stdout)) {
      return { present: false, serial: null, boardId: null, reason: await portapackReason() };
    }
    const serial = /Serial number:\s*(\S+)/i.exec(stdout)?.[1] || null;
    const boardId = /Board ID Number:.*\(([^)]+)\)/i.exec(stdout)?.[1] || "HackRF One";
    return { present: true, serial, boardId };
  } catch {
    return { present: false, serial: null, boardId: null, reason: await portapackReason() };
  }
}

// A HackRF One with a PortaPack Mayhem add-on boots into the PortaPack's
// OWN menu firmware on power-up — including after any USB disconnect/
// reconnect blip (a marginal hub, a service restart's USB re-enumeration,
// etc.) — instead of passing the HackRF through in native USB mode. It
// then enumerates as a plain CDC-ACM serial port ("PortaPack Mayhem" /
// "Great Scott Gadgets", USB ID 1d50:6018) rather than the libhackrf
// device (1d50:6089) `hackrf_info` looks for, so detection above reports
// "not present" even though the hardware IS physically connected.
// Distinguishing the two turns a confusing demo-mode fallback into a
// message that says exactly what to do — see docs/aircraft-radar.md's
// "PortaPack en modo menú" section (found by hand once via dmesg/lsusb
// archaeology; this is that investigation made permanent).
async function portapackReason(): Promise<string | undefined> {
  try {
    const byId = await fs.promises.readdir("/dev/serial/by-id");
    if (byId.some((name) => /portapack|great_scott_gadgets/i.test(name))) {
      return "El HackRF está conectado pero en modo PortaPack Mayhem (menú) — en su pantalla: Menu → USB (o equivalente en el firmware instalado) para pasarlo a modo USB nativo y que readsb pueda verlo.";
    }
  } catch {
    /* /dev/serial/by-id unavailable — nothing extra to add, stay generic */
  }
  return undefined;
}

export type ReceiverGain = {
  lnaGain: number; // "IF" gain, 0-40dB in 8dB steps
  vgaGain: number; // baseband gain, 0-62dB in 2dB steps
  ampEnabled: boolean; // RF amp, ~11dB, on/off
};

// Spawns readsb directly against the HackRF via its native libhackrf
// support (`--device-type hackrf`) — replaces an earlier
// hackrf_transfer|dump1090 shell pipeline (see git history/docs/
// aircraft-radar.md's "Estado de la captura real" section for why: the
// old dump1090 fork is unmaintained and never validated against a real
// HackRF, and switching to readsb's own native SDR handling — no external
// hackrf_transfer, no intermediate stdout/stdin pipe — was what actually
// got real ADS-B decodes on real hardware). readsb keeps dump1090's
// SBS-1/BaseStation text feed (`--net-sbs-port`), so sbs-parser.ts and
// everything downstream of it is unchanged.
//
// SECURITY: readsb's HackRF backend only ever receives (libhackrf's own
// RX API) — there is no transmit code path in readsb at all, and this
// module must never invoke hackrf_transfer/hackrf_spiflash or any other
// tool with a TX-capable flag. See AGENTS.md's RX-only requirement.
export class AdsbReceiver extends EventEmitter {
  private proc: ChildProcess | null = null;
  private sbsSocket: net.Socket | null = null;
  private sbsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sbsBuffer = "";
  private running = false;

  start(gain: ReceiverGain): void {
    if (this.running) return;
    this.running = true;

    const args = [
      "--device-type",
      "hackrf",
      "--gain",
      String(gain.lnaGain * 10), // readsb's --gain is LNA-gain-in-dB * 10
      "--hackrf-vgagain",
      String(gain.vgaGain),
      ...(gain.ampEnabled ? ["--hackrf-enable-ampgain"] : []),
      "--net",
      "--net-sbs-port",
      String(SBS_PORT),
      "--quiet",
    ];

    this.proc = spawn("readsb", args, { stdio: ["ignore", "ignore", "pipe"] });
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

  // readsb logs routine status to stderr (startup banner, the periodic
  // "weirdness: hackRF gave us a block with an unusual size" notice — a
  // real but so-far-benign USB-timing quirk on this hardware, not fatal —
  // and USB packet-loss warnings). None of that is worth escalating on
  // every line; only genuinely unexpected output gets logged.
  private logStderr(chunk: Buffer): void {
    const text = chunk.toString("utf8").trim();
    if (text && !/^readsb version|^Opening HackRF|^HackRF successfully|^invoked by:|weirdness:|SBS TCP output/.test(text)) {
      console.warn("[aircraft-radar] receiver:", text);
    }
  }

  // readsb needs a moment after spawn before its SBS listener is up, and
  // the connection can also legitimately drop mid-session (readsb
  // restarted, HackRF glitched) — retry on a timer either way instead of
  // treating a failed connect as fatal.
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
        this.proc.kill("SIGTERM");
      } catch {
        // Already gone — nothing left to kill.
      }
      this.proc = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
