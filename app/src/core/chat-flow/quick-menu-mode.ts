import { display } from "../../device/display";

// Entry point for everything that used to need its own gesture (a double
// click for the camera, a specific phrase for the model/mode menus) — a
// short click from "sleep" opens this instead (see states.ts), and holding
// the button here confirms the highlighted item, same grammar as every
// other menu (model-select-mode.ts, mode-select-mode.ts): click = next,
// hold ~0.9s = select, double click = cancel.
export type QuickMenuKey = "model" | "mode" | "help" | "camera";

type QuickMenuItem = { key: QuickMenuKey; label: string; description: string };

const BASE_ITEMS: QuickMenuItem[] = [
  { key: "model", label: "Modelo", description: "Elegir modelo de IA" },
  { key: "mode", label: "Modo", description: "Agente u local" },
  { key: "help", label: "Ayuda", description: "Comandos de voz" },
  { key: "camera", label: "Cámara", description: "Tomar una foto" },
];

const SHORT_PRESS_MAX_MS = 400;
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
const IDLE_TIMEOUT_MS = 20000;

let items: QuickMenuItem[] = BASE_ITEMS;
let selectedIndex = 0;
let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let onConfirmCallback: (key: QuickMenuKey) => void = () => {};
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

function currentItem(): QuickMenuItem {
  return items[selectedIndex];
}

function renderScreen(): void {
  const item = currentItem();
  display({
    status: "quick_menu",
    model_ui: "select",
    model_ui_title: "MENÚ",
    model_ui_label: item.label,
    model_ui_description: item.description,
    model_ui_index: selectedIndex + 1,
    model_ui_total: items.length,
    model_ui_active: false,
    text: "Click: siguiente · Mantén: elegir",
  });
}

export function resetQuickMenuControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  pressStartedAt = 0;
}

export function onQuickMenuConfirm(callback: (key: QuickMenuKey) => void): void {
  onConfirmCallback = callback;
}

export function onQuickMenuTimeout(callback: () => void): void {
  onTimeoutCallback = callback;
}

export function onQuickMenuCancel(callback: () => void): void {
  onCancelCallback = callback;
}

export function handleQuickMenuCancel(): void {
  resetQuickMenuControl();
  onCancelCallback();
}

// enableCamera mirrors ChatFlowContext.enableCamera — the "Cámara" item only
// makes sense when the device actually has a camera configured (see
// states.ts "sleep", which used to gate the same double-click shortcut).
export function enterQuickMenuMode(enableCamera: boolean): void {
  resetQuickMenuControl();
  items = enableCamera ? BASE_ITEMS : BASE_ITEMS.filter((i) => i.key !== "camera");
  selectedIndex = 0;
  renderScreen();
  armIdleTimer();
}

export function handleQuickMenuPress(): void {
  clearIdleTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    display({
      status: "quick_menu",
      model_ui: "confirm",
      model_ui_title: "MENÚ",
      model_ui_label: currentItem().label,
      model_ui_description: currentItem().description,
      model_ui_percent: percent,
      text: "Manteniendo presionado...",
    });
  }, HOLD_TICK_MS);
  confirmTimer = setTimeout(() => {
    clearHoldTimers();
    onConfirmCallback(currentItem().key);
  }, CONFIRM_HOLD_MS);
}

export function handleQuickMenuRelease(): void {
  const duration = Date.now() - pressStartedAt;
  clearHoldTimers();
  pressStartedAt = 0;
  if (duration > 0 && duration <= SHORT_PRESS_MAX_MS) {
    selectedIndex = (selectedIndex + 1) % items.length;
  }
  renderScreen();
  armIdleTimer();
}
