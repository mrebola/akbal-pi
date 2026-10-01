import dotenv from "dotenv";
import { persistEnvVar } from "../utils/env-file";

dotenv.config();

export type DeviceMode = "local" | "agent";

// "Modo agente" routes conversation through the whisplay-im bridge to an
// external OpenClaw instance instead of the local LLM provider — see
// docs/agent-mode.md. Runtime-switchable via voice + the on-screen menu
// (chat-flow/mode-select-mode.ts) or the web admin, independent of
// LLM_SERVER (which keeps selecting the *local* provider used in "modo
// local", e.g. ollama).
//
// Always boots in "local" unless DEVICE_MODE=agent is explicitly set in
// .env — agent mode is only ever entered by an explicit switch (voice menu
// or web, see setDeviceMode below), never inferred from any other setting
// (e.g. LLM_SERVER, or internet being reachable). A previous version of
// this also inferred agent mode from LLM_SERVER=whisplay-im as a backward-
// compat shim; that implicit path is gone — set DEVICE_MODE=agent directly
// if that's really what's wanted at boot.
const envDeviceMode = (process.env.DEVICE_MODE || "").toLowerCase();

let currentMode: DeviceMode = envDeviceMode === "agent" ? "agent" : "local";

export const getDeviceMode = (): DeviceMode => currentMode;

export const isAgentMode = (): boolean => currentMode === "agent";

export const setDeviceMode = (mode: DeviceMode): void => {
  if (mode === currentMode) return;
  console.log(`[DeviceMode] Switching mode: ${currentMode} -> ${mode}`);
  currentMode = mode;
  persistEnvVar("DEVICE_MODE", mode);
};
