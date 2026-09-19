import { display } from "../../device/display";
import { getCurrentLogPercent, setVolumeByAmixer } from "../../utils/volume";

// Physical fallback for volume, reached from the quick menu — the voice
// commands ("sube/baja el volumen", "pon el volumen en 40", see
// voice-commands.ts) are the primary way to do this, but they need the mic
// to hear you. Volume doesn't fit the other menus' "pick one of N options"
// carousel (it's a continuous value, and changing it should be heard
// immediately, not only once confirmed) — so unlike model/mode-select,
// click applies the change live instead of just moving a cursor. Holding
// the button (or a double click) just means "done", the same "hold to
// finish" gesture as help-mode.ts, since there's nothing left to confirm.
const STEP = 10;
const SHORT_PRESS_MAX_MS = 400;
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
const IDLE_TIMEOUT_MS = 20000;

let currentLevel = 0;
let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let onExitCallback: () => void = () => {};

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
  idleTimer = setTimeout(() => onExitCallback(), IDLE_TIMEOUT_MS);
}

function renderScreen(): void {
  display({
    status: "volume_adjust",
    model_ui: "select",
    model_ui_title: "VOLUMEN",
    model_ui_label: `${currentLevel}%`,
    model_ui_description: "",
    // No "N de M" here — the level number is already the whole story, and
    // "6 de 11" would just be noise (see docs/display-ui.md).
    model_ui_index: 0,
    model_ui_total: 0,
    model_ui_active: false,
    text: "Click: subir · Mantén: listo",
  });
}

export function onVolumeAdjustExit(callback: () => void): void {
  onExitCallback = callback;
}

export function resetVolumeAdjustControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  pressStartedAt = 0;
}

export function enterVolumeAdjustMode(): void {
  resetVolumeAdjustControl();
  const snapped = Math.round(getCurrentLogPercent() / STEP) * STEP;
  currentLevel = Math.min(100, Math.max(0, snapped));
  renderScreen();
  armIdleTimer();
}

export function handleVolumeAdjustPress(): void {
  clearIdleTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    display({
      status: "volume_adjust",
      model_ui: "confirm",
      model_ui_title: "VOLUMEN",
      model_ui_label: "Listo",
      model_ui_description: "",
      model_ui_percent: percent,
      text: "Manteniendo presionado...",
    });
  }, HOLD_TICK_MS);
  confirmTimer = setTimeout(() => {
    clearHoldTimers();
    onExitCallback();
  }, CONFIRM_HOLD_MS);
}

export function handleVolumeAdjustRelease(): void {
  const duration = Date.now() - pressStartedAt;
  clearHoldTimers();
  pressStartedAt = 0;
  if (duration > 0 && duration <= SHORT_PRESS_MAX_MS) {
    // Click bumps and applies immediately (wraps 100 -> 0) — a click here
    // should be heard right away, not just move a cursor you confirm later.
    currentLevel = (currentLevel + STEP) % (100 + STEP);
    setVolumeByAmixer(currentLevel);
  }
  // A hold interrupted before CONFIRM_HOLD_MS has nothing to undo (each
  // click already applied live) — just redraw and keep waiting either way.
  renderScreen();
  armIdleTimer();
}

export function handleVolumeAdjustDoubleClick(): void {
  resetVolumeAdjustControl();
  onExitCallback();
}
