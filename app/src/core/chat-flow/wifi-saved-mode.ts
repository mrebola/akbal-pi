import { display } from "../../device/display";
import { connectToWifi, listSavedWifiNetworks, WifiNetwork } from "../../utils/wifi";
import { getApStatus } from "../../utils/access-point";

// "Conectar a wifi" in the quick menu: a carousel of the Pi's saved wifi
// networks (the ones it already knows the password for). Click moves to the
// next network, holding CONFIRM_HOLD_MS on one connects to it — same grammar
// as the model picker (model-select-mode.ts), so the whole menu behaves the
// same way. Double click or the idle timeout backs out.
const SHORT_PRESS_MAX_MS = 400;
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
const IDLE_TIMEOUT_MS = 20000;
const RESULT_VISIBLE_MS = 2500;

const TITLE = "CONECTAR A WIFI";

let networks: WifiNetwork[] = [];
let selectedIndex = 0;
let busy = false;
let active = false;
let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let resultTimer: ReturnType<typeof setTimeout> | null = null;
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
  idleTimer = setTimeout(() => exitWifiSaved(), IDLE_TIMEOUT_MS);
}

function currentNetwork(): WifiNetwork {
  return networks[selectedIndex];
}

function describe(network: WifiNetwork): string {
  if (network.active) return "Conectada";
  if (network.signal <= 0) return "Fuera de alcance";
  return `En rango · ${network.signal}%`;
}

function renderSelectScreen(): void {
  const network = currentNetwork();
  display({
    status: "wifi_saved",
    model_ui: "select",
    model_ui_title: TITLE,
    model_ui_label: network.ssid,
    model_ui_description: describe(network),
    model_ui_index: selectedIndex + 1,
    model_ui_total: networks.length,
    model_ui_active: network.active,
    text: "Click: siguiente\nMantén: conectar",
  });
}

function showStatus(label: string, description: string, text: string): void {
  display({
    status: "wifi_saved",
    model_ui: "select",
    model_ui_title: TITLE,
    model_ui_label: label,
    model_ui_description: description,
    model_ui_index: selectedIndex + 1,
    model_ui_total: networks.length,
    model_ui_active: false,
    text,
  });
}

export function resetWifiSavedControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  if (resultTimer) {
    clearTimeout(resultTimer);
    resultTimer = null;
  }
  pressStartedAt = 0;
  busy = false;
}

export function onWifiSavedExit(callback: () => void): void {
  onExitCallback = callback;
}

function exitWifiSaved(): void {
  if (!active) return;
  resetWifiSavedControl();
  active = false;
  onExitCallback();
}

// Explicit "get me out" gesture, bound to a double click (see states.ts).
export function handleWifiSavedDoubleClick(): void {
  exitWifiSaved();
}

export async function enterWifiSavedMode(): Promise<void> {
  resetWifiSavedControl();
  active = true;
  selectedIndex = 0;
  display({
    status: "wifi_saved",
    model_ui: "select",
    model_ui_title: TITLE,
    model_ui_label: "Buscando...",
    model_ui_description: "Wifis guardados",
    model_ui_index: 0,
    model_ui_total: 0,
    model_ui_active: false,
    text: "Doble clic: salir",
  });
  let apSsid: string | undefined;
  try {
    apSsid = (await getApStatus()).ssid;
  } catch {
    apSsid = undefined;
  }
  // Re-check after the await: a double click may have left the mode meanwhile.
  if (!active) return;
  try {
    // The Pi's own hotspot ("WiFi directo") is a saved profile too, but it is
    // not a network to join — leave it out of the list.
    networks = (await listSavedWifiNetworks()).filter((n) => n.ssid !== apSsid);
  } catch (err) {
    console.warn("[wifi-saved] Failed to list saved networks:", err);
    networks = [];
  }
  if (!active) return;
  if (networks.length === 0) {
    showStatus("Sin wifis guardados", "Conéctate desde la web", "Doble clic: salir");
    armIdleTimer();
    return;
  }
  renderSelectScreen();
  armIdleTimer();
}

export function handleWifiSavedPress(): void {
  if (busy || networks.length === 0) return;
  clearIdleTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    display({
      status: "wifi_saved",
      model_ui: "confirm",
      model_ui_title: TITLE,
      model_ui_label: currentNetwork().ssid,
      model_ui_description: describe(currentNetwork()),
      model_ui_percent: percent,
      text: "Manteniendo presionado...",
    });
  }, HOLD_TICK_MS);
  confirmTimer = setTimeout(() => {
    clearHoldTimers();
    void connectSelected();
  }, CONFIRM_HOLD_MS);
}

async function connectSelected(): Promise<void> {
  busy = true;
  const network = currentNetwork();
  showStatus(network.ssid, "Conectando...", "Espera un momento");
  const result = await connectToWifi(network.ssid);
  busy = false;
  if (!active) return;
  if (result.ok) {
    showStatus(network.ssid, "Conectada", "Listo");
  } else {
    showStatus(network.ssid, "No se pudo conectar", "Revisa la señal");
  }
  resultTimer = setTimeout(() => exitWifiSaved(), RESULT_VISIBLE_MS);
}

export function handleWifiSavedRelease(): void {
  if (busy) return;
  const duration = Date.now() - pressStartedAt;
  clearHoldTimers();
  pressStartedAt = 0;
  if (networks.length === 0) return;
  if (duration > 0 && duration <= SHORT_PRESS_MAX_MS) {
    selectedIndex = (selectedIndex + 1) % networks.length;
  }
  renderSelectScreen();
  armIdleTimer();
}
