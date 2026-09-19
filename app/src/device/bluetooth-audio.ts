import { execFile } from "child_process";

const runCmd = (cmd: string, args: string[], timeoutMs = 6000): Promise<string> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (_e, stdout) => {
      resolve(stdout || "");
    });
  });

// Whether PipeWire has actually created an audio sink for this Bluetooth
// device. BlueZ reporting "Connected: yes" is not enough: some speakers connect
// only their control channel (or drop the A2DP profile), leaving no sink, so
// playback would silently fall back to the default (HAT) device. Returns
// true/false, or null when it can't tell (pw-dump unavailable) so callers can
// fall back to the BlueZ signal instead of failing outright.
const hasBluetoothSink = async (mac: string): Promise<boolean | null> => {
  let out = "";
  try {
    out = await runCmd("pw-dump", [], 5000);
    if (!out.trim()) return null;
  } catch {
    return null;
  }
  try {
    const nodes = JSON.parse(out);
    const macUpper = mac.toUpperCase();
    const macUnderscore = macUpper.replace(/:/g, "_");
    for (const node of nodes) {
      const props = node?.info?.props || {};
      if (props["media.class"] !== "Audio/Sink") continue;
      const addr = String(props["api.bluez5.address"] || "").toUpperCase();
      const name = String(props["node.name"] || "").toUpperCase();
      if (addr === macUpper || name.includes(macUnderscore)) return true;
    }
    return false;
  } catch {
    return null;
  }
};

// Bluetooth speaker management for the audio-output selector.
//
// The Pi's Bluetooth radio only reliably holds ONE A2DP audio speaker
// connected at a time (a second simultaneous connect fails with
// "br-connection-create-socket"). So "picking a speaker" is not just a routing
// change: it connects the chosen speaker and disconnects any other one. Once a
// single Bluetooth speaker is connected, WirePlumber makes it PipeWire's
// default sink, so device/audio.ts's "pulse" output (getAlsaOutputDevice for a
// non-HAT target) lands on it. The HAT speaker is a direct ALSA device and is
// unaffected by any of this; the microphone is always the HAT (see audio.ts).

export interface BtSpeaker {
  mac: string;
  name: string;
  connected: boolean;
}

// A2DP Audio Sink service UUID — a device advertising it can play our audio.
const AUDIO_SINK_UUID = "0000110b";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

const runBt = (args: string[], timeoutMs = 8000): Promise<string> =>
  new Promise((resolve) => {
    execFile("bluetoothctl", args, { timeout: timeoutMs }, (_err, stdout, stderr) => {
      // bluetoothctl exits non-zero for some benign cases; we parse stdout
      // regardless and let callers decide from the text.
      resolve(stripAnsi(`${stdout || ""}${stderr || ""}`));
    });
  });

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const parseDeviceLines = (text: string): { mac: string; name: string }[] => {
  const result: { mac: string; name: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // "Device AA:BB:CC:DD:EE:FF Speaker Name"
    const m = line.match(/^Device\s+([0-9A-Fa-f:]{17})\s+(.*)$/);
    if (m) {
      result.push({ mac: m[1].toUpperCase(), name: m[2].trim() || m[1] });
    }
  }
  return result;
};

// Bluetooth "major device class" for Audio/Video devices (speakers, headsets…).
const parseClassMajor = (info: string): number | null => {
  const m = info.match(/^\s*Class:\s*0x([0-9A-Fa-f]+)/m);
  if (!m) return null;
  const cls = parseInt(m[1], 16);
  return (cls >> 8) & 0x1f;
};

const getDeviceInfo = async (
  mac: string,
): Promise<{ name?: string; connected: boolean; paired: boolean; isAudioSink: boolean }> => {
  const info = await runBt(["info", mac]);
  const nameMatch = info.match(/^\s*Name:\s*(.+)$/m);
  const connected = /^\s*Connected:\s*yes\s*$/im.test(info);
  const paired = /^\s*Paired:\s*yes\s*$/im.test(info);
  const lower = info.toLowerCase();
  const isAudioSink =
    lower.includes("audio sink") ||
    lower.includes(AUDIO_SINK_UUID) ||
    lower.includes("icon: audio-card") ||
    parseClassMajor(info) === 0x04; // Audio/Video major device class
  return { name: nameMatch?.[1]?.trim(), connected, paired, isAudioSink };
};

/**
 * List paired Bluetooth devices that can act as an audio speaker (advertise the
 * A2DP Audio Sink profile), newest pairing first is not guaranteed — order
 * follows bluetoothctl. Best-effort: returns [] if bluetoothctl is unavailable.
 */
export const listPairedSpeakers = async (): Promise<BtSpeaker[]> => {
  let listText = await runBt(["devices", "Paired"]);
  if (!/^Device\s/m.test(listText)) {
    // Older bluetoothctl doesn't support the "Paired" filter.
    listText = await runBt(["paired-devices"]);
  }
  const devices = parseDeviceLines(listText);
  const speakers: BtSpeaker[] = [];
  for (const dev of devices) {
    try {
      const info = await getDeviceInfo(dev.mac);
      if (info.isAudioSink) {
        speakers.push({
          mac: dev.mac,
          name: info.name || dev.name,
          connected: info.connected,
        });
      }
    } catch {
      // ignore a single device that fails to introspect
    }
  }
  return speakers;
};

/**
 * Ensure `mac` is the connected Bluetooth speaker: disconnect any other
 * connected audio speaker first (single-A2DP limit), then connect `mac` and
 * wait until BlueZ reports it connected. Returns { ok } — ok:false with a
 * short reason when the speaker couldn't be brought up.
 */
export const connectSpeaker = async (
  mac: string,
): Promise<{ ok: boolean; error?: string }> => {
  const target = mac.toUpperCase();

  // 1) Disconnect other connected speakers so the radio is free for `target`.
  try {
    const speakers = await listPairedSpeakers();
    for (const sp of speakers) {
      if (sp.mac !== target && sp.connected) {
        await runBt(["disconnect", sp.mac]);
      }
    }
  } catch {
    // best-effort; continue to the connect attempt anyway
  }

  // A connection is only "good" when BlueZ says connected AND PipeWire has a
  // real audio sink for it (or we can't tell, in which case we trust BlueZ).
  const isReady = async (): Promise<boolean> => {
    const info = await getDeviceInfo(target).catch(() => ({ connected: false } as any));
    if (!info.connected) return false;
    const sink = await hasBluetoothSink(target);
    return sink !== false; // true or null (unknown) -> accept
  };

  // Already fully up? Nothing to do.
  if (await isReady()) {
    return { ok: true };
  }

  // 2) Connect, with one retry — the first connect right after freeing the
  // radio sometimes fails with "br-connection-create-socket", and some speakers
  // need a moment for their A2DP sink to register.
  for (let attempt = 0; attempt < 2; attempt++) {
    await runBt(["connect", target], 15000);
    for (let i = 0; i < 12; i++) {
      await delay(1000);
      if (await isReady()) {
        return { ok: true };
      }
    }
    await delay(1500);
  }

  return { ok: false, error: "no se pudo conectar la bocina bluetooth" };
};

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

/** True for a well-formed Bluetooth MAC address. */
export const isValidMac = (mac: string): boolean => MAC_RE.test(mac.trim());

/**
 * Scan for nearby, not-yet-paired Bluetooth speakers. Runs a timed discovery,
 * then returns devices that advertise the Audio/Video profile and have a
 * friendly name (BLE beacons / phones with only a MAC-shaped name are skipped).
 * Best-effort: returns [] if bluetoothctl is unavailable.
 */
export const scanForNewSpeakers = async (scanMs = 12000): Promise<BtSpeaker[]> => {
  const seconds = Math.max(4, Math.ceil(scanMs / 1000));
  await runBt(["--timeout", String(seconds), "scan", "on"], scanMs + 6000);
  const devices = parseDeviceLines(await runBt(["devices"]));
  const found: BtSpeaker[] = [];
  for (const dev of devices) {
    // Skip entries whose "name" is just the MAC (unnamed beacons, etc.).
    const nameAsMac = dev.name.replace(/-/g, ":");
    if (!dev.name || MAC_RE.test(nameAsMac)) continue;
    try {
      const info = await getDeviceInfo(dev.mac);
      if (info.isAudioSink && !info.paired) {
        found.push({ mac: dev.mac, name: info.name || dev.name, connected: info.connected });
      }
    } catch {
      // ignore a device that fails to introspect
    }
  }
  return found;
};

/**
 * Pair (and trust) a discovered Bluetooth speaker, then connect it so it
 * becomes the active output. Most speakers use "Just Works" pairing (no PIN).
 */
export const pairSpeaker = async (mac: string): Promise<{ ok: boolean; error?: string }> => {
  const target = mac.toUpperCase();

  const existing = await getDeviceInfo(target).catch(
    () => ({ paired: false } as { paired: boolean }),
  );
  if (!existing.paired) {
    const out = await runBt(["pair", target], 25000);
    const after = await getDeviceInfo(target).catch(
      () => ({ paired: false } as { paired: boolean }),
    );
    if (!after.paired && !/pairing successful|already.*paired/i.test(out)) {
      return { ok: false, error: "no se pudo emparejar la bocina" };
    }
  }

  await runBt(["trust", target]);
  // connectSpeaker frees the radio (disconnects any other speaker) and connects.
  return connectSpeaker(target);
};

/**
 * Unpair and forget a Bluetooth speaker so it disappears from the picker and
 * can be paired fresh later.
 */
export const removeSpeaker = async (mac: string): Promise<{ ok: boolean; error?: string }> => {
  const target = mac.toUpperCase();
  await runBt(["disconnect", target]).catch(() => "");
  await runBt(["remove", target], 10000);
  const info = await getDeviceInfo(target).catch(
    () => ({ paired: false } as { paired: boolean }),
  );
  if (info.paired) {
    return { ok: false, error: "no se pudo eliminar la bocina" };
  }
  return { ok: true };
};
