import { display } from "../../device/display";
import { isAgentMode, DeviceMode } from "../../config/device-mode";

// Button-driven agent/local mode picker, entered when the user says "activa
// modo agente" / "modo local" / "cambiar modo" (see states.ts and
// voice-commands.ts), or from the quick menu. Deliberately mirrors
// model-select-mode.ts's press/hold/confirm timing so the on-device UX is
// consistent, and for the same reason: a misheard voice command should
// never silently flip how the device answers (local model vs external
// OpenClaw agent) — see docs/agent-mode.md.
export type DeviceModeOption = { key: DeviceMode; label: string; description: string };

export const DEVICE_MODE_OPTIONS: DeviceModeOption[] = [
  { key: "agent", label: "Modo agente", description: "Conversa vía OpenClaw" },
  { key: "local", label: "Modo local", description: "Modelo en este dispositivo" },
];

const SHORT_PRESS_MAX_MS = 400;
// Matches model-select-mode.ts / quick-menu-mode.ts.
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
const IDLE_TIMEOUT_MS = 20000;

let selectedIndex = 0;
let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let onConfirmCallback: (option: DeviceModeOption) => void = () => {};
let onTimeoutCallback: () => void = () => {};
let onCancelCallback: () => void = () => {};

function clearHoldTimers(): void {
  if (holdTicker) {
    clearInterval(holdTicker);
    holdTicker = null;
  }
  if (confirmTimer) {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function armIdleTimer(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => onTimeoutCallback(), IDLE_TIMEOUT_MS);
}

function currentOption(): DeviceModeOption {
  return DEVICE_MODE_OPTIONS[selectedIndex];
}

function renderSelectScreen(): void {
  const option = currentOption();
  const isActive = isAgentMode() ? option.key === "agent" : option.key === "local";
  display({
    status: "mode_select",
    model_ui: "select",
    // Distinct title from the model picker's "MODELO" — the main visual cue
    // that these are two different menus, not just two ways into the same
    // one (see docs/display-ui.md).
    model_ui_title: "MODO",
    model_ui_label: option.label,
    model_ui_description: option.description,
    model_ui_index: selectedIndex + 1,
    model_ui_total: DEVICE_MODE_OPTIONS.length,
    model_ui_active: isActive,
    text: "Click: siguiente · Mantén: elegir",
  });
}

export function resetModeSelectControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  pressStartedAt = 0;
}

export function onModeSelectConfirm(
  callback: (option: DeviceModeOption) => void,
): void {
  onConfirmCallback = callback;
}

export function onModeSelectTimeout(callback: () => void): void {
  onTimeoutCallback = callback;
}

export function onModeSelectCancel(callback: () => void): void {
  onCancelCallback = callback;
}

// Explicit "get me out of here" gesture, bound to a double click (see
// states.ts) — the idle timeout alone (IDLE_TIMEOUT_MS) is a safety net, but
// isn't a great primary way to back out without picking a mode.
export function handleModeSelectCancel(): void {
  resetModeSelectControl();
  onCancelCallback();
}

// initialTarget pre-positions the carousel on the mode the voice command
// actually named ("activa modo agente" starts on "agent"), so a single
// hold confirms it. A generic "cambiar modo" (no target named) starts on
// whichever mode is currently active.
export function enterModeSelectMode(initialTarget?: DeviceMode): void {
  resetModeSelectControl();
  const activeKey: DeviceMode = isAgentMode() ? "agent" : "local";
  const wantedKey = initialTarget || activeKey;
  const idx = DEVICE_MODE_OPTIONS.findIndex((o) => o.key === wantedKey);
  selectedIndex = idx >= 0 ? idx : 0;
  renderSelectScreen();
  armIdleTimer();
}

export function handleModeSelectPress(): void {
  clearIdleTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    display({
      status: "mode_select",
      model_ui: "confirm",
      model_ui_title: "MODO",
      model_ui_label: currentOption().label,
      model_ui_description: currentOption().description,
      model_ui_percent: percent,
      text: "Manteniendo presionado...",
    });
  }, HOLD_TICK_MS);
  confirmTimer = setTimeout(() => {
    clearHoldTimers();
    onConfirmCallback(currentOption());
  }, CONFIRM_HOLD_MS);
}

export function handleModeSelectRelease(): void {
  const duration = Date.now() - pressStartedAt;
  clearHoldTimers();
  pressStartedAt = 0;
  if (duration > 0 && duration <= SHORT_PRESS_MAX_MS) {
    selectedIndex = (selectedIndex + 1) % DEVICE_MODE_OPTIONS.length;
  }
  renderSelectScreen();
  armIdleTimer();
}
