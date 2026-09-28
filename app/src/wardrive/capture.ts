import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import fs from "fs";

// Continuous driving capture (docs/wardrive.md): ONE dumpcap|tshark
// pipeline for the whole session — beacons/probe-resps build the AP list,
// EAPOL data frames mark handshakes, deauth frames confirm our own bursts
// landed. Nothing is decoded beyond the ~12 fields tshark extracts; raw
// packets are never written anywhere. Per-target .cap artifacts are cut by
// re-running hcxpcapngtool over the rolling per-window pcap below (the
// window rotates; a capture always references the file it was seen in).
//
// Same pipeline shape as wifiradar/capture.ts: a single `bash -c` with a
// real shell pipe (Node's stream .pipe() made tshark reject stdin in
// testing — see that file for the full history), dumpcap under sudo only.

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
  "eapol",
];

// Beacons build the map, deauths time our bursts, EAPOL data frames mark
// handshakes. Excludes the huge encrypted-payload bulk a plain "type data"
// would admit — only null-data + EAPOL frames pass, which keeps tshark's
// CPU tiny on a busy channel (most 802.11 chatter is ordinary encrypted
// data). BPF syntax verified against dumpcap 4.4 on the device: "subtype
// null" is the 802.11 null-data frame; EAPOL rides LLC/SNAP with EtherType
// 0x888e, which the "ether proto 0x888e" primitive matches on the data
// frames that carry it.
const CAPTURE_FILTER =
  "type mgt subtype beacon or type mgt subtype probe-resp or type mgt subtype deauth " +
  "or (type data and (subtype null or ether proto 0x888e))";

const TYPE_SUBTYPE = {
  BEACON: "0x0008",
  PROBE_RESP: "0x0005",
  DEAUTH: "0x000c",
};

function isDataSubtype(hex: string): boolean {
  return ["0x0020", "0x0028", "0x0030", "0x0038"].includes(hex);
}

// EAPOL data frames arrive with the same type/subtype codes as plain data;
// tshark separates them via the -e eapol field (last column).
const EAPOL_MARK = "1";

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
  return field.split(",")[0]?.trim() || "";
}

function parseSecurity(privacy: string, rsnVersion: string, wpaVersion: string): string {
  if (rsnVersion) return "WPA2/3";
  if (wpaVersion) return "WPA";
  if (privacy === "1") return "WEP";
  if (privacy === "0") return "OPEN";
  return "UNKNOWN";
}

export type DriveFrame =
  | { kind: "beacon"; bssid: string; ssid: string; channel: number; rssi: number; security: string; ts: number }
  | { kind: "deauth"; bssid: string; client: string; ts: number }
  | { kind: "eapol"; bssid: string; client: string; ts: number };

function parseLine(line: string): DriveFrame | null {
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
    eapolRaw,
  ] = cols.map((c) => c.trim());
  const now = Date.now();
  const rssi = parseInt(firstOf(rssiRaw), 10);
  const bssid = (bssidRaw || sa || ta).toUpperCase();
  if (!bssid || bssid.length !== 17) return null;

  if (typeSubtype === TYPE_SUBTYPE.BEACON || typeSubtype === TYPE_SUBTYPE.PROBE_RESP) {
    const channel = parseInt(channelRaw, 10);
    if (!channel || Number.isNaN(rssi)) return null;
    const ssid = hexToUtf8(ssidHex) || "(oculta)";
    return {
      kind: "beacon",
      bssid,
      ssid,
      channel,
      rssi,
      security: parseSecurity(privacy, rsnVersion, wpaVersion),
      ts: now,
    };
  }

  if (typeSubtype === TYPE_SUBTYPE.DEAUTH) {
    const client = (ra || ta || sa).toUpperCase();
    if (client.length !== 17) return null;
    return { kind: "deauth", bssid, client, ts: now };
  }

  if (isDataSubtype(typeSubtype)) {
    const candidate = ta && ta.toUpperCase() !== bssid ? ta : ra;
    const client = (candidate || "").toUpperCase();
    if (client.length !== 17 || client === bssid) return null;
    if (eapolRaw && eapolRaw !== "0" && eapolRaw !== "") {
      return { kind: "eapol", bssid, client, ts: now };
    }
    return null;
  }
  return null;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ─── Rolling pcap window ─────────────────────────────────────────────────────
// dumpcap ALSO writes a ringbuffer pcapng (-b files:N) so per-target .cap
// artifacts exist for later hcxpcapngtool/aircrack runs. The window is large
// (10 files × 5MB ≈ 50MB) so a burst from seconds ago is still inside; on a
// capture hit we convert THAT file and keep a copy of the .hc22000.

export const RING_FILES = 10;
export const RING_FILE_SIZE_MB = 5;

export class DriveCapture extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private running = false;

  start(iface: string, ringDir: string | null): void {
    if (this.running) return;
    this.running = true;

    const dumpcapArgs = [
      "dumpcap", // NO sudo: dumpcap drops privileges after opening the
      // interface (uid → SUDO_USER, caps dropped — verified on the device
      // with strace), and the dropped set can't even traverse $HOME (0700)
      // to create the ring files: "Permission denied". With the binary's
      // file capabilities (sudo setcap cap_net_admin,cap_net_raw=eip
      // /usr/bin/dumpcap, applied on the device) running it as the SERVICE
      // USER works for both the interface capture AND writing into
      // ~/wardrive-sessions/drive-*/ring/. The interface itself is already
      // in monitor mode at this point (enterMonitorMode, which does use
      // sudo for ip/iw).
      "-i", shellSingleQuote(iface),
      "-f", shellSingleQuote(CAPTURE_FILTER),
    ];
    // Ringbuffer only when a dir is given (real sessions): -b (ringbuffer)
    // works together with -w <prefix> — dumpcap rolls <prefix>_00001_*.pcapng
    // files on its own. In memory-only mode we pipe to stdout (no -b), same
    // as wifiradar does.
    if (ringDir) {
      dumpcapArgs.push(
        "-w", shellSingleQuote(`${ringDir}/drive-`),
        "-b", `files:${RING_FILES}`,
        "-b", `filesize:${RING_FILE_SIZE_MB * 1_048_576}`,
        "-q",
      );
    } else {
      dumpcapArgs.push("-w", "-", "-q");
    }
    const dumpcapCmd = dumpcapArgs.join(" ");

    const tsharkCmd = [
      "tshark",
      "-r", "-",
      "-n",
      "-l",
      "-T", "fields",
      "-E", "separator=/t",
      "-E", "occurrence=f",
      ...FIELDS.flatMap((f) => ["-e", f]),
    ].join(" ");

    // Two SEPARATE processes on one monitor iface: the ringbuffer writer
    // (-b, no pipe at all — it only writes files) and the stdout→tshark
    // pipeline for field extraction (no -w). Both dumpcaps receive the same
    // frames; starting the field pipeline as `ringCmd & fieldCmd | tshark`
    // keeps them in one process group so stop() reaches everything.
    const fieldDumpcap = [
      "dumpcap", // same file-capabilities story as the ring writer above
      "-i", shellSingleQuote(iface),
      "-f", shellSingleQuote(CAPTURE_FILTER),
      "-w", "-",
      "-q",
    ].join(" ");

    const ringPart = ringDir ? `${dumpcapCmd} & ` : "";
    this.proc = spawn(
      "bash",
      ["-c", `${ringPart}${fieldDumpcap} | ${tsharkCmd}`],
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr?.on("data", (chunk: Buffer) => this.logStderr(chunk));
    this.proc.on("exit", (code, signal) => {
      if (!this.running) return;
      this.running = false;
      this.emit("exit", { code, signal });
    });
    this.proc.on("error", (err) => {
      if (!this.running) return;
      this.running = false;
      this.emit("error", err);
    });
  }

  private logStderr(chunk: Buffer): void {
    const text = chunk.toString("utf8").trim();
    if (text && !/^Capturing on|Running as user|packets captured|^File:/i.test(text)) {
      console.warn("[wardrive] capture:", text);
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
      try {
        process.kill(-this.proc.pid!, "SIGTERM");
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

  isRunning(): boolean {
    return this.running;
  }
}

// The newest ringbuffer file. dumpcap 4.4 on the device names them
// drive-_00001_<timestamp> WITHOUT the .pcapng extension — match by prefix,
// not extension (dirs excluded).
export function newestRingFile(ringDir: string): string | null {
  const files = ringFiles(ringDir);
  return files.length > 0 ? files[files.length - 1] : null;
}

// All ring files, oldest first (per-target extraction searches them all).
export function ringFiles(ringDir: string): string[] {
  try {
    return fs
      .readdirSync(ringDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith("drive-"))
      .map((e) => `${ringDir}/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}