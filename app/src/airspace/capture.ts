import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { RawFrameEvent, SecurityKind } from "./types";

const FIELDS = [
  "wlan.fc.type_subtype",
  "wlan.sa",
  "wlan.ta",
  "wlan.ra",
  "wlan.bssid",
  "wlan.ssid",
  "radiotap.dbm_antsignal",
  "wlan.ds.current_channel",
  "wlan.fixed.capabilities.privacy",
  "wlan.rsn.version",
  "wlan.wfa.ie.wpa.version",
];

// BPF filter applied at the libpcap level, before tshark's own dissector —
// drops everything AIRSPACE doesn't use (ACKs, RTS/CTS, QoS null frames,
// other APs' encrypted payload bytes we can't and don't want to read)
// right at capture time. This is most of what keeps backend CPU low: tshark
// never even sees the bulk of 802.11 chatter, let alone parses it.
const CAPTURE_FILTER =
  "type mgt subtype beacon or type mgt subtype probe-resp or type mgt subtype deauth or type data";

const TYPE_SUBTYPE = {
  BEACON: "0x0008",
  PROBE_RESP: "0x0005",
  DEAUTH: "0x000c",
};

function isDataSubtype(hex: string): boolean {
  // Data frame subtypes are type=2 (bits 3:2 of the type_subtype byte).
  // wlan.fc.type_subtype packs type in bits 3:2 and subtype in bits 7:4 of
  // the *frame control* byte, but tshark's field already gives the whole
  // 16-bit value with type in bits 3:2 — easiest reliable check: data
  // frames' hex values are 0x0020, 0x0028, 0x0030, 0x0038 (data, and the
  // QoS variants actually used by every modern client).
  return ["0x0020", "0x0028", "0x0030", "0x0038"].includes(hex);
}

function hexToUtf8(hex: string): string {
  if (!hex) return "";
  try {
    const clean = hex.replace(/^0x/, "");
    if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) return hex;
    return Buffer.from(clean, "hex").toString("utf8").replace(/\0/g, "").trim();
  } catch {
    return hex;
  }
}

function firstOf(field: string): string {
  // Some radiotap fields repeat per-antenna ("-76,-76") even with
  // -E occurrence=f in most tshark versions — split defensively either way.
  return field.split(",")[0]?.trim() || "";
}

function parseSecurity(privacy: string, rsnVersion: string, wpaVersion: string): SecurityKind {
  if (rsnVersion) return "WPA2/3";
  if (wpaVersion) return "WPA";
  if (privacy === "1") return "WEP";
  if (privacy === "0") return "OPEN";
  return "UNKNOWN";
}

function parseLine(line: string): RawFrameEvent | null {
  const cols = line.split("\t");
  if (cols.length < FIELDS.length) return null;
  const [
    typeSubtype,
    sa,
    ta,
    ra,
    bssidRaw,
    ssidHex,
    rssiRaw,
    channelRaw,
    privacy,
    rsnVersion,
    wpaVersion,
  ] = cols.map((c) => c.trim());
  const now = Date.now();
  const rssi = parseInt(firstOf(rssiRaw), 10);
  const bssid = (bssidRaw || sa || ta).toUpperCase();
  if (!bssid || bssid.length !== 17) return null;

  if (typeSubtype === TYPE_SUBTYPE.BEACON || typeSubtype === TYPE_SUBTYPE.PROBE_RESP) {
    const channel = parseInt(channelRaw, 10);
    if (!channel || Number.isNaN(rssi)) return null;
    return {
      kind: typeSubtype === TYPE_SUBTYPE.BEACON ? "beacon" : "probe_resp",
      bssid,
      ssid: hexToUtf8(ssidHex) || "(oculta)",
      channel,
      rssi,
      security: parseSecurity(privacy, rsnVersion, wpaVersion),
      timestamp: now,
    };
  }

  if (typeSubtype === TYPE_SUBTYPE.DEAUTH) {
    const client = (ra || ta || sa).toUpperCase();
    if (client.length !== 17) return null;
    return { kind: "deauth", bssid, client, timestamp: now };
  }

  if (isDataSubtype(typeSubtype)) {
    // Whichever of ta/ra isn't the BSSID itself is the client talking to
    // (or through) this AP.
    const candidate = ta && ta.toUpperCase() !== bssid ? ta : ra;
    const client = (candidate || "").toUpperCase();
    if (client.length !== 17 || client === bssid || Number.isNaN(rssi)) return null;
    return { kind: "data", bssid, client, rssi, timestamp: now };
  }

  return null;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class Ar9271Capture extends EventEmitter {
  // A single `bash -c "dumpcap ... | tshark ..."` process, not two
  // separately-spawned children wired together with Node's stream .pipe()
  // — confirmed empirically on this exact device that Node's own pipe()
  // relay makes tshark reject its stdin outright ("The standard input is
  // a 'special file' or socket or other non-regular file", exit code 3),
  // while the identical command run through a real shell pipe works fine.
  // A true shell pipe also avoids tshark's own `-i` live-capture mode,
  // which (also confirmed empirically) still buffers through a temp
  // .pcapng file under /tmp even with `-T fields` and no `-w` — directly
  // against the "never write PCAP to disk" requirement. dumpcap `-w -`
  // writes pcap data to *stdout* instead of a file, and tshark reads it
  // back from stdin (`-r -`) to do the field extraction — nothing ever
  // touches disk either way. Only dumpcap needs root; tshark reading
  // already-captured bytes from a pipe does not, so sudo only wraps that
  // half of the pipeline, inside the shell command itself.
  private proc: ChildProcess | null = null;
  private buffer = "";
  private running = false;

  start(iface: string): void {
    if (this.running) return;
    this.running = true;

    const dumpcapCmd = [
      "sudo",
      "-n",
      "dumpcap",
      "-i",
      shellSingleQuote(iface),
      "-f",
      shellSingleQuote(CAPTURE_FILTER),
      "-w",
      "-",
      "-q",
    ].join(" ");
    const tsharkCmd = [
      "tshark",
      "-r",
      "-",
      "-n", // no name/OUI/port resolution — we do our own tiny vendor
      // lookup (oui.ts); tshark's built-in resolvers do disk/network
      // lookups and hold their own caches in memory for no benefit here
      "-l", // line-buffered stdout — without this tshark fully buffers
      // (thousands of bytes) before writing anything when its stdout
      // isn't a TTY, which is exactly the "piped to Node" case here
      "-T",
      "fields",
      "-E",
      "separator=/t",
      "-E",
      "occurrence=f",
      ...FIELDS.flatMap((f) => ["-e", f]),
    ].join(" ");

    // detached: true makes bash the leader of its own process group, so
    // killing -pid in stop() reaches dumpcap and tshark both — killing
    // just bash's own PID wouldn't reliably reach the pipeline's children.
    this.proc = spawn("bash", ["-c", `${dumpcapCmd} | ${tsharkCmd}`], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr?.on("data", (chunk: Buffer) => this.logStderr(chunk));
    this.proc.on("exit", (code, signal) => {
      if (!this.running) return; // stop() already called intentionally
      this.running = false;
      this.emit("exit", { code, signal });
    });
    this.proc.on("error", (err) => {
      // Same guard as "exit" above: stop() already sets running=false
      // before killing the process, and the kill itself can trigger a
      // late "error" here (e.g. EPIPE on its now-dead stdout) — nothing
      // is listening for an "error" this deep into an intentional
      // shutdown, and Node throws *uncaught* if "error" is emitted with
      // zero listeners, so this must not forward it in that case.
      if (!this.running) return;
      this.running = false;
      this.emit("error", err);
    });
  }

  private logStderr(chunk: Buffer): void {
    const text = chunk.toString("utf8").trim();
    // dumpcap prints "Capturing on 'X'" on start and a packet-count
    // summary line on exit — both startup/shutdown noise, not errors.
    if (text && !/^Capturing on|Running as user|packets captured|^File:/i.test(text)) {
      console.warn("[airspace] capture:", text);
    }
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      const parsed = parseLine(line);
      if (parsed) this.emit("frame", parsed);
    }
  }

  stop(): void {
    this.running = false;
    if (this.proc) {
      // bash forwards SIGTERM to a foreground pipeline it's running, but
      // killing the whole process group (negative pid, see the detached:
      // true above) reaches dumpcap and tshark directly too — belt and
      // suspenders against a root-owned dumpcap lingering and holding the
      // monitor interface open.
      // Both attempts can legitimately fail with ESRCH — the process (or
      // whole group) may have already exited on its own by the time
      // stop() runs (e.g. during shutdown, racing the process's own
      // natural exit) — and ChildProcess#kill() can throw synchronously
      // for that, not just process.kill(). An uncaught ESRCH here crashed
      // the whole app during testing, so both are guarded.
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
