import { display } from "../../device/display";
import { enableAp, disableAp, getApStatus, generateApConnectQrFile } from "../../utils/access-point";

// "Wifi connect" in the quick menu — replaces the old "Internet emergencia"
// (wifi-manager-mode.ts, removed): instead of joining an existing network,
// this turns the Pi's own wifi card into a direct access point so a phone
// can reach the device with zero setup and no internet at all. Opening the
// menu propagates the hotspot right away (if it wasn't already on) and shows
// SSID + password + a "scan to join" QR — nothing to select, unlike the
// other quick-menu screens. A short click turns the AP back off and returns
// straight to normal (nmcli can't be a client and an AP at once — see
// utils/access-point.ts); holding or a double click just leaves the menu
// with the AP running as-is. Once connected, the web admin UI (reachable at
// the shown address) can add a real network so this mode isn't needed again.
const IDLE_TIMEOUT_MS = 60000; // longer than other menus — reading/scanning a QR takes a moment
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;

let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let active = false; // guards stale renders after backing out mid-request
let busy = false;
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

function showLoading(label: string): void {
  if (!active) return;
  display({
    model_ui: "loading",
    model_ui_title: "WIFI CONNECT",
    model_ui_label: label,
    model_ui_description: "",
    text: "Un momento...",
  });
}

async function showQrScreen(): Promise<void> {
  const status = await getApStatus();
  if (!active) return;
  const qrPath = await generateApConnectQrFile(status).catch((err) => {
    console.warn("[wifi-connect-mode] generateApConnectQrFile failed:", err);
    return "";
  });
  if (!active) return;
  display({
    model_ui: "network",
    model_ui_title: "WIFI CONNECT",
    model_ui_label: status.ssid,
    model_ui_description: `Clave: ${status.password}`,
    model_ui_qr_path: qrPath,
    text: `Escaneá el QR o unite a "${status.ssid}" · Click: desactivar · Mantén: salir`,
  });
}

export function resetWifiConnectControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  pressStartedAt = 0;
}

export function onWifiConnectExit(callback: () => void): void {
  onExitCallback = callback;
}

export function enterWifiConnectMode(): void {
  resetWifiConnectControl();
  active = true;
  busy = false;
  void (async () => {
    const status = await getApStatus();
    if (!active) return;
    if (!status.active) {
      showLoading("Activando akbal-pi...");
      await enableAp().catch((err) => console.warn("[wifi-connect-mode] enableAp failed:", err));
      if (!active) return;
    }
    await showQrScreen();
  })();
  armIdleTimer();
}

export function exitWifiConnectMode(): void {
  active = false;
  resetWifiConnectControl();
}

export function handleWifiConnectPress(): void {
  if (busy) return;
  clearIdleTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    if (!active) return;
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    display({
      model_ui: "confirm",
      model_ui_title: "WIFI CONNECT",
      model_ui_label: "Salir",
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

export function handleWifiConnectRelease(): void {
  const wasHolding = holdTicker !== null || confirmTimer !== null;
  clearHoldTimers();
  pressStartedAt = 0;
  if (busy || !wasHolding) return;
  // A short click turns the AP back off and leaves — "regresar al estado
  // normal" is both the network state and the screen at once.
  busy = true;
  showLoading("Desactivando...");
  disableAp()
    .catch((err) => console.warn("[wifi-connect-mode] disableAp failed:", err))
    .then(() => {
      busy = false;
      onExitCallback();
    });
}

export function handleWifiConnectDoubleClick(): void {
  resetWifiConnectControl();
  onExitCallback();
}
