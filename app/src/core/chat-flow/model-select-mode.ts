import { display } from "../../device/display";
import {
  formatContextWindow,
  getCurrentModel,
  listOllamaModelsWithSize,
} from "../../cloud-api/local/ollama-llm";
import { MODEL_ALIASES } from "./voice-commands";

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

// What the carousel actually needs — built fresh from `ollama list` every
// time the menu opens (see resolveOptions), not from MODEL_ALIASES alone,
// so a model pulled or removed since the last visit shows up without
// anyone having to edit MODEL_ALIASES by hand.
export type ModelOption = {
  tag: string;
  shortName: string;
  // Spoken form ("Modelo 5, qwen sin censura 2" / just the short name for
  // an uncurated model) — used for TTS confirmations, unaffected by what
  // the card shows on screen.
  label: string;
  contextWindow: string;
};

let options: ModelOption[] = [];
let selectedIndex = 0;
let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let onConfirmCallback: (option: ModelOption) => void = () => {};
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

function currentOption(): ModelOption {
  return options[selectedIndex];
}

// "huihui_ai/qwen3-abliterated:1.7b" -> "Qwen3 Abliterated" — only used for
// a model that's installed but not in MODEL_ALIASES (so it still shows up
// with *some* readable name instead of the raw tag).
function autoShortName(tag: string): string {
  const withoutQuant = tag.split(":")[0];
  const base = withoutQuant.split("/").pop() || withoutQuant;
  const spaced = base.replace(/[-_]+/g, " ").trim();
  const titled = spaced.replace(/\b\w/g, (c) => c.toUpperCase());
  return titled || tag;
}

function renderSelectScreen(): void {
  const option = currentOption();
  const isActive = option.tag.toLowerCase() === getCurrentModel().toLowerCase();
  display({
    status: "model_select",
    model_ui: "select",
    model_ui_title: "MODELO",
    model_ui_label: option.shortName,
    model_ui_description: option.contextWindow,
    model_ui_index: selectedIndex + 1,
    model_ui_total: options.length,
    model_ui_active: isActive,
    text: isActive ? "Click: siguiente" : "Mantén presionado para activar",
  });
}

export function resetModelSelectControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  pressStartedAt = 0;
}

export function onModelSelectConfirm(
  callback: (option: ModelOption) => void,
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

// Every model `ollama list` actually reports installed, not just the
// curated MODEL_ALIASES ones — a model pulled since the last visit shows up
// automatically. MODEL_ALIASES still supplies the nicer name/spoken label
// when a tag matches one; anything else gets an auto-generated name (see
// autoShortName) so it's still legible instead of showing the raw tag.
async function resolveOptions(): Promise<ModelOption[]> {
  try {
    const installed = await listOllamaModelsWithSize();
    if (installed.length === 0) return [];
    return installed.map(({ name, contextLength }) => {
      const alias = MODEL_ALIASES.find((a) => a.tag.toLowerCase() === name.toLowerCase());
      return {
        tag: name,
        shortName: alias?.shortName || autoShortName(name),
        label: alias?.label || autoShortName(name),
        contextWindow: formatContextWindow(contextLength),
      };
    });
  } catch (err) {
    console.warn("[model-select] Failed to list installed models:", err);
    return [];
  }
}

export async function enterModelSelectMode(): Promise<void> {
  resetModelSelectControl();
  options = await resolveOptions();
  if (options.length === 0) {
    display({
      status: "model_select",
      model_ui: "select",
      model_ui_title: "MODELO",
      model_ui_label: "Sin modelos",
      model_ui_description: "Ollama no responde",
      model_ui_index: 0,
      model_ui_total: 0,
      model_ui_active: false,
      text: "Doble clic: salir",
    });
    armIdleTimer();
    return;
  }
  const activeTag = getCurrentModel().toLowerCase();
  const activeIndex = options.findIndex(
    (o) => o.tag.toLowerCase() === activeTag,
  );
  selectedIndex = activeIndex >= 0 ? activeIndex : 0;
  renderSelectScreen();
  armIdleTimer();
}

export function handleModelSelectPress(): void {
  if (options.length === 0) return;
  clearIdleTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    display({
      status: "model_select",
      model_ui: "confirm",
      model_ui_title: "MODELO",
      model_ui_label: currentOption().shortName,
      model_ui_description: currentOption().contextWindow,
      model_ui_percent: percent,
      text: "Manteniendo presionado...",
    });
  }, HOLD_TICK_MS);
  confirmTimer = setTimeout(() => {
    clearHoldTimers();
    onConfirmCallback(currentOption());
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
  if (options.length === 0) return;
  if (duration > 0 && duration <= SHORT_PRESS_MAX_MS) {
    selectedIndex = (selectedIndex + 1) % options.length;
  }
  renderSelectScreen();
  armIdleTimer();
}
