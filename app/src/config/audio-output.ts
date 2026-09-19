import dotenv from "dotenv";
import { persistEnvVar } from "../utils/env-file";

dotenv.config();

export type AudioOutputTarget = "hat" | "bluetooth";

// Which physical speaker TTS/the wakeup chime play through. Defaults to the
// Whisplay HAT's onboard speaker — the assistant should only speak through a
// Bluetooth speaker when the user explicitly picked one (on-screen quick
// menu or web admin), never silently just because something happens to be
// paired. Persists to .env (AUDIO_OUTPUT) across restarts, same pattern as
// DEVICE_MODE (see config/device-mode.ts).
const envAudioOutput = (process.env.AUDIO_OUTPUT || "").toLowerCase();
let currentTarget: AudioOutputTarget =
  envAudioOutput === "bluetooth" ? "bluetooth" : "hat";

export const getAudioOutputTarget = (): AudioOutputTarget => currentTarget;

export const isBluetoothOutput = (): boolean => currentTarget === "bluetooth";

export const setAudioOutputTarget = (target: AudioOutputTarget): void => {
  if (target === currentTarget) return;
  console.log(`[AudioOutput] Switching output: ${currentTarget} -> ${target}`);
  currentTarget = target;
  persistEnvVar("AUDIO_OUTPUT", target);
};
