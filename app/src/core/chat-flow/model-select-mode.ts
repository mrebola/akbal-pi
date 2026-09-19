import { display } from "../../device/display";
import { getCurrentModel, listOllamaModels } from "../../cloud-api/local/ollama-llm";
import { MODEL_ALIASES, ModelAlias } from "./voice-commands";

// Button-driven model picker, entered when the user says "cambia modelo" /
// "cambiar modelo" (see states.ts), or from the quick menu. A single click
// cycles to the next model; holding the button for CONFIRM_HOLD_MS on a
// model selects it. Releasing before that cancels the hold and stays on the
// same model — nothing changes until the user commits to the full hold, so
// a misheard voice command can no longer silently switch models (see
// docs/llm-model-selection.md history).
const SHORT_PRESS_MAX_MS = 400;
// Matches the other menus (mode-select-mode.ts, quick-menu-mode.ts) — see
// docs/display-ui.md for why this moved from 3s to ~0.9s.
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
const IDLE_TIMEOUT_MS = 20000;

let options: ModelAlias[] = MODEL_ALIASES;
let selectedIndex = 0;
let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let onConfirmCallback: (alias: ModelAlias) => void = () => {};
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

function currentAlias(): ModelAlias {
  return options[selectedIndex];
}

function renderSelectScreen(): void {
  const alias = currentAlias();
  const isActive = alias.tag.toLowerCase() === getCurrentModel().toLowerCase();
  display({
    status: "model_select",
    model_ui: "select",
    model_ui_title: "MODELO",
    model_ui_label: alias.shortName,
    model_ui_description: alias.description,
    model_ui_index: selectedIndex + 1,
    model_ui_total: options.length,
    model_ui_active: isActive,
    text: "Click: siguiente · Mantén: elegir",
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

export function onModelSelectCancel(callback: () => void): void {
  onCancelCallback = callback;
}

// Explicit "get me out of here" gesture, bound to a double click (see
// states.ts) — the idle timeout alone (IDLE_TIMEOUT_MS) is a safety net, but
// isn't a great primary way to back out without picking a model.
export function handleModelSelectCancel(): void {
  resetModelSelectControl();
  onCancelCallback();
}

// Only offers models `ollama list` actually reports installed — showing an
// alias for a model that isn't there any more used to just fail later, in
// model_loading. Falls back to the full curated list if Ollama can't be
// reached at all (better a possibly-stale menu than a broken one), and
// never returns an empty menu even if nothing matched.
async function resolveInstalledOptions(): Promise<ModelAlias[]> {
  try {
    const installed = await listOllamaModels();
    const installedSet = new Set(installed.map((m) => m.toLowerCase()));
    const filtered = MODEL_ALIASES.filter((alias) =>
      installedSet.has(alias.tag.toLowerCase()),
    );
    return filtered.length > 0 ? filtered : MODEL_ALIASES;
  } catch (err) {
    console.warn("[model-select] Failed to list installed models, showing full list:", err);
    return MODEL_ALIASES;
  }
}

export async function enterModelSelectMode(): Promise<void> {
  resetModelSelectControl();
  options = await resolveInstalledOptions();
  const activeTag = getCurrentModel().toLowerCase();
  const activeIndex = options.findIndex(
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
      model_ui_title: "MODELO",
      model_ui_label: currentAlias().shortName,
      model_ui_description: currentAlias().description,
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
    selectedIndex = (selectedIndex + 1) % options.length;
  }
  renderSelectScreen();
  armIdleTimer();
}
