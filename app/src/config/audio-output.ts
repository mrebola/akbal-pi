import dotenv from "dotenv";
import { persistEnvVar } from "../utils/env-file";

dotenv.config();

// Which physical speaker TTS/the wakeup chime play through. Possible values:
//   "hat"        -> the Whisplay HAT's onboard speaker (default)
//   "bluetooth"  -> legacy: whatever Bluetooth speaker is the current default
//                   sink (kept for backward compatibility with older .env files)
//   "bt:<MAC>"   -> a specific paired Bluetooth speaker, identified by its MAC
//
// The assistant only speaks through a Bluetooth speaker when the user explicitly
// picked one (on-screen quick menu or web admin), never silently just because
// something happens to be paired. Persists to .env (AUDIO_OUTPUT) across
// restarts, same pattern as DEVICE_MODE (see config/device-mode.ts).
export type AudioOutputTarget = string;

const BT_PREFIX = "bt:";

const normalize = (value: string | undefined): AudioOutputTarget => {
  const v = (value || "").trim();
  if (!v) return "hat";
  const lower = v.toLowerCase();
  if (lower === "hat") return "hat";
  if (lower === "bluetooth") return "bluetooth";
  if (lower.startsWith(BT_PREFIX)) {
    return `${BT_PREFIX}${v.slice(BT_PREFIX.length).toUpperCase()}`;
  }
  // A bare MAC address is treated as a specific Bluetooth speaker.
  if (/^[0-9a-f:]{17}$/i.test(v)) {
    return `${BT_PREFIX}${v.toUpperCase()}`;
  }
  return "hat";
};

let currentTarget: AudioOutputTarget = normalize(process.env.AUDIO_OUTPUT);

export const getAudioOutputTarget = (): AudioOutputTarget => currentTarget;

/** True for any Bluetooth speaker (legacy "bluetooth" or a specific "bt:<MAC>"). */
export const isBluetoothOutput = (): boolean => currentTarget !== "hat";

/** The MAC of the selected specific Bluetooth speaker, or null. */
export const getBluetoothMac = (): string | null =>
  currentTarget.startsWith(BT_PREFIX) ? currentTarget.slice(BT_PREFIX.length) : null;

/** Build the persisted target value for a specific Bluetooth speaker. */
export const bluetoothTarget = (mac: string): AudioOutputTarget =>
  `${BT_PREFIX}${mac.toUpperCase()}`;

export const setAudioOutputTarget = (target: AudioOutputTarget): void => {
  const next = normalize(target);
  if (next === currentTarget) return;
  console.log(`[AudioOutput] Switching output: ${currentTarget} -> ${next}`);
  currentTarget = next;
  persistEnvVar("AUDIO_OUTPUT", next);
};
