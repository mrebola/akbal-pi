import { display } from "../../device/display";
import { getCurrentModel } from "../../cloud-api/local/ollama-llm";
import { MODEL_ALIASES, ModelAlias } from "./voice-commands";

// Button-driven model picker, entered when the user says "cambia modelo" /
// "cambiar modelo" (see states.ts). A single click cycles to the next model;
// holding the button for CONFIRM_HOLD_MS on a model selects it. Releasing
// before that cancels the hold and stays on the same model — nothing changes
// until the user commits to the full hold, so a misheard voice command can no
// longer silently switch models (see docs/llm-model-selection.md history).
const SHORT_PRESS_MAX_MS = 400;
const CONFIRM_HOLD_MS = 3000;
const HOLD_TICK_MS = 60;
const IDLE_TIMEOUT_MS = 20000;

let selectedIndex = 0;
let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let onConfirmCallback: (alias: ModelAlias) => void = () => {};
let onTimeoutCallback: () => void = () => {};

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

function currentAlias(): ModelAlias {
  return MODEL_ALIASES[selectedIndex];
}

function renderSelectScreen(): void {
  const alias = currentAlias();
  const isActive = alias.tag.toLowerCase() === getCurrentModel().toLowerCase();
  display({
    status: "model_select",
    model_ui: "select",
    model_ui_label: alias.label,
    model_ui_index: selectedIndex + 1,
    model_ui_total: MODEL_ALIASES.length,
    model_ui_active: isActive,
    text: "Click: siguiente modelo\nMantené 3s: elegirlo",
  });
}

export function resetModelSelectControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  pressStartedAt = 0;
}

export function onModelSelectConfirm(
  callback: (alias: ModelAlias) => void,
): void {
  onConfirmCallback = callback;
}

export function onModelSelectTimeout(callback: () => void): void {
  onTimeoutCallback = callback;
}

export function enterModelSelectMode(): void {
  resetModelSelectControl();
  const activeTag = getCurrentModel().toLowerCase();
  const activeIndex = MODEL_ALIASES.findIndex(
    (a) => a.tag.toLowerCase() === activeTag,
  );
  selectedIndex = activeIndex >= 0 ? activeIndex : 0;
  renderSelectScreen();
  armIdleTimer();
}

export function handleModelSelectPress(): void {
  clearIdleTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    display({
      status: "model_select",
      model_ui: "confirm",
      model_ui_label: currentAlias().label,
      model_ui_percent: percent,
      text: "Manteniendo presionado...",
    });
  }, HOLD_TICK_MS);
  confirmTimer = setTimeout(() => {
    clearHoldTimers();
    onConfirmCallback(currentAlias());
  }, CONFIRM_HOLD_MS);
}

export function handleModelSelectRelease(): void {
  // Once CONFIRM_HOLD_MS elapses, confirmTimer fires and states.ts
  // transitions to "model_loading", which re-registers its own (noop) button
  // handlers — so a release reaching here always means the hold was
  // interrupted before confirming, or it was a short click.
  const duration = Date.now() - pressStartedAt;
  clearHoldTimers();
  pressStartedAt = 0;
  if (duration > 0 && duration <= SHORT_PRESS_MAX_MS) {
    selectedIndex = (selectedIndex + 1) % MODEL_ALIASES.length;
  }
  renderSelectScreen();
  armIdleTimer();
}
