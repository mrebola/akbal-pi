import dotenv from "dotenv";
import { LLMServer } from "../type";
import { persistEnvVar } from "../utils/env-file";

dotenv.config();

export type DeviceMode = "local" | "agent";

// "Modo agente" routes conversation through the whisplay-im bridge to an
// external OpenClaw instance instead of the local LLM provider — see
// docs/agent-mode.md. Runtime-switchable via voice + the on-screen menu
// (chat-flow/mode-select-mode.ts), independent of LLM_SERVER (which keeps
// selecting the *local* provider used in "modo local", e.g. ollama).
//
// Backward compat: before this existed, the only way to enable the bridge
// was LLM_SERVER=whisplay-im at boot. If DEVICE_MODE isn't set, honor that
// so an existing .env keeps working — but from here on, switching modes
// persists DEVICE_MODE instead (see setDeviceMode), which takes over as the
// source of truth on the next boot.
const envDeviceMode = (process.env.DEVICE_MODE || "").toLowerCase();
const legacyImMode =
  (process.env.LLM_SERVER || "").toLowerCase() === LLMServer.whisplayim;

let currentMode: DeviceMode =
  envDeviceMode === "agent" || (!envDeviceMode && legacyImMode)
    ? "agent"
    : "local";

export const getDeviceMode = (): DeviceMode => currentMode;

export const isAgentMode = (): boolean => currentMode === "agent";

export const setDeviceMode = (mode: DeviceMode): void => {
  if (mode === currentMode) return;
  console.log(`[DeviceMode] Switching mode: ${currentMode} -> ${mode}`);
  currentMode = mode;
  persistEnvVar("DEVICE_MODE", mode);
};
