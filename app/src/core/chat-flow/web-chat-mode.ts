import { display } from "../../device/display";

// Physical-screen side of the "modo chat web" (see web-chat-state.ts). While
// on, the screen is a frozen card: no quick menu, no refresh timer. Leaving
// takes a hold of the button, same gesture as wardrive's exit (wardrive-mode.ts).

const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;

let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
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

export function onWebChatExit(callback: () => void): void {
  onExitCallback = callback;
}

export function enterWebChatMode(): void {
  clearHoldTimers();
  pressStartedAt = 0;
  display({
    status: "web chat",
    emoji: "💻",
    RGB: "#3366ff",
    text: "Chat web activo. Mantén presionado para salir.",
    model_ui: "",
    help_ui: "",
    radar_ui: "",
    aircraft_radar_ui: "",
    wardrive_ui: "",
    rag_icon_visible: false,
  });
}

export function handleWebChatPress(): void {
  clearHoldTimers();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    display({
      model_ui: "confirm",
      model_ui_title: "CHAT WEB",
      model_ui_label: "Salir del modo",
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

export function handleWebChatRelease(): void {
  const wasHolding = holdTicker !== null || confirmTimer !== null;
  clearHoldTimers();
  pressStartedAt = 0;
  // A short press only removes the ring the hold started; the card stays.
  if (wasHolding) enterWebChatMode();
}
