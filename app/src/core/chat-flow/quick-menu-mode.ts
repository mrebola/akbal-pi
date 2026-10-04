import { display } from "../../device/display";
import { isAgentMode } from "../../config/device-mode";
import { getApStatus } from "../../utils/access-point";
import { getWifiStatus } from "../../utils/wifi";

// Entry point for everything that used to need its own gesture (a double
// click for the camera, a specific phrase for the model/mode menus) — a
// short click from "sleep" opens this instead (see states.ts), and holding
// the button here confirms the highlighted item, same grammar as every
// other menu (model-select-mode.ts, mode-select-mode.ts): click = next,
// hold ~0.9s = select, double click = cancel.
export type QuickMenuKey =
  | "model"
  | "mode"
  | "audio_output"
  | "help"
  | "camera"
  | "volume"
  | "wifi_saved"
  | "wifi_connect"
  | "network"
  | "wifiradar"
  | "aircraft_radar"
  | "wardrive"
  | "doom"
  | "jukebox"
  | "about";

type QuickMenuItem = { key: QuickMenuKey; label: string; description: string };

// Order: conectar a wifi first (the everyday action), then modo, WiFi directo
// and wardrive, then the rest in any order, DOOM second-to-last and "Acerca
// de" last. Labels match the web admin's naming for the same feature 1:1
// (see app/web/admin/i18n/es.json's topbar.* and settings.general.ap_* keys)
// — they used to drift (e.g. "Wifi connect" here vs. "WiFi directo (punto de
// acceso)" on the web for the same AP toggle), which reads as two different
// features when it's one.
const BASE_ITEMS: QuickMenuItem[] = [
  { key: "wifi_saved", label: "Conectar a wifi", description: "Redes guardadas" },
  { key: "mode", label: "Modo", description: "Agente o local" },
  { key: "wifi_connect", label: "WiFi directo", description: "Red propia de la Pi" },
  { key: "wardrive", label: "Wardrive", description: "Captura en el auto + GPS" },
  { key: "model", label: "Modelo", description: "Elegir modelo de IA" },
  { key: "audio_output", label: "Audio", description: "Bocina Pi o bluetooth" },
  { key: "jukebox", label: "OST", description: "OST de Cypher" },
  { key: "volume", label: "Volumen", description: "Subir/bajar el sonido" },
  { key: "help", label: "Ayuda", description: "Comandos de voz" },
  { key: "camera", label: "Cámara", description: "Tomar una foto" },
  { key: "network", label: "Conexión web", description: "IP, tailscale y QR" },
  { key: "wifiradar", label: "WiFi Radar", description: "Ver redes cercanas" },
  { key: "aircraft_radar", label: "Radar de Aviones", description: "Ver tráfico aéreo cercano" },
  { key: "doom", label: "DOOM", description: "Jugar DOOM con tu celular" },
  { key: "about", label: "Acerca de", description: "Cypher404: El Manifiesto" },
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

// Live state shown on the card, so an item says what it is doing right now
// ("● Activo" + detail) instead of only what it is. Read asynchronously when
// the menu opens (see refreshItemStatus) — the card never waits for it.
const itemState = {
  apOn: false,
  apSsid: "",
  wifiSsid: null as string | null,
};
let inMenu = false;

type ItemStatus = { description: string; active: boolean };

function statusOf(item: QuickMenuItem): ItemStatus {
  if (item.key === "mode") {
    return { description: `Ahora: ${isAgentMode() ? "agente" : "local"}`, active: false };
  }
  if (item.key === "wifi_connect") {
    return itemState.apOn
      ? { description: `Encendido · ${itemState.apSsid}`, active: true }
      : { description: item.description, active: false };
  }
  if (item.key === "wifi_saved" && itemState.wifiSsid) {
    return { description: "Conectada", active: true };
  }
  return { description: item.description, active: false };
}

async function refreshItemStatus(): Promise<void> {
  try {
    const ap = await getApStatus();
    itemState.apOn = ap.active;
    itemState.apSsid = ap.ssid;
  } catch (err) {
    console.warn("[quick-menu] AP status failed:", err);
  }
  try {
    const wifi = await getWifiStatus();
    itemState.wifiSsid = wifi.connected ? wifi.ssid : null;
  } catch (err) {
    console.warn("[quick-menu] wifi status failed:", err);
  }
  if (inMenu) renderScreen();
}

function renderScreen(): void {
  const item = currentItem();
  const state = statusOf(item);
  display({
    status: "quick_menu",
    model_ui: "select",
    model_ui_title: "MENÚ",
    model_ui_label: item.label,
    model_ui_description: state.description,
    model_ui_index: selectedIndex + 1,
    model_ui_total: items.length,
    model_ui_active: state.active,
    text: "Click: siguiente\nMantén: elegir",
  });
}

export function resetQuickMenuControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  pressStartedAt = 0;
  inMenu = false;
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
  inMenu = true;
  renderScreen();
  armIdleTimer();
  void refreshItemStatus();
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
      model_ui_description: statusOf(currentItem()).description,
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
