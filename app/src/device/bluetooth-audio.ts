import { execFile } from "child_process";

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

const getDeviceInfo = async (
  mac: string,
): Promise<{ name?: string; connected: boolean; isAudioSink: boolean }> => {
  const info = await runBt(["info", mac]);
  const nameMatch = info.match(/^\s*Name:\s*(.+)$/m);
  const connected = /^\s*Connected:\s*yes\s*$/im.test(info);
  const isAudioSink =
    info.toLowerCase().includes("audio sink") || info.toLowerCase().includes(AUDIO_SINK_UUID);
  return { name: nameMatch?.[1]?.trim(), connected, isAudioSink };
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

  // Already connected? Nothing to do.
  const before = await getDeviceInfo(target).catch(() => ({ connected: false } as any));
  if (before.connected) {
    return { ok: true };
  }

  // 2) Connect, with one retry — the first connect right after freeing the
  // radio sometimes fails with "br-connection-create-socket".
  for (let attempt = 0; attempt < 2; attempt++) {
    await runBt(["connect", target], 15000);
    // 3) Poll until connected (BlueZ reports it asynchronously).
    for (let i = 0; i < 12; i++) {
      await delay(1000);
      const info = await getDeviceInfo(target).catch(() => ({ connected: false } as any));
      if (info.connected) {
        return { ok: true };
      }
    }
    await delay(1500);
  }

  return { ok: false, error: "no se pudo conectar la bocina bluetooth" };
};
