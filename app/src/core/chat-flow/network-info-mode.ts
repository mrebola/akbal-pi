import { display } from "../../device/display";
import { getNetworkInfo, generateConnectQr } from "../../utils/network-info";

// "Conexión web" quick-menu item: shows how to reach the web admin UI
// (web-admin-server.ts) from a phone — LAN IP, Tailscale hostname, and a QR
// code encoding the Tailscale URL so scanning it opens the page directly.
// Single screen, no paging — same exit grammar as help-mode.ts (hold or
// double-click to leave), but nothing to click through in between.
const IDLE_TIMEOUT_MS = 30000;
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
const WEB_ADMIN_PORT = parseInt(process.env.WEB_ADMIN_PORT || "8090", 10);

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

async function renderScreen(): Promise<void> {
  display({
    model_ui: "loading",
    model_ui_title: "CONEXIÓN WEB",
    model_ui_label: "Generando QR...",
    model_ui_description: "",
    text: "Un momento...",
  });
  const info = await getNetworkInfo(WEB_ADMIN_PORT);
  const qrPath = await generateConnectQr(info.url).catch((err) => {
    console.warn("[network-info-mode] generateConnectQr failed:", err);
    return "";
  });
  const shortHost = info.tailscaleHostname || info.lanIp || "sin red";
  display({
    model_ui: "network",
    model_ui_title: "CONEXIÓN WEB",
    model_ui_label: shortHost,
    model_ui_description: info.lanIp ? `${info.lanIp}:${WEB_ADMIN_PORT}` : "",
    model_ui_qr_path: qrPath,
    text: `Abrí ${info.url} desde tu navegador · Mantén: salir`,
  });
}

export function resetNetworkInfoControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  pressStartedAt = 0;
}

export function onNetworkInfoExit(callback: () => void): void {
  onExitCallback = callback;
}

export function enterNetworkInfoMode(): void {
  resetNetworkInfoControl();
  void renderScreen();
  armIdleTimer();
}

export function handleNetworkInfoPress(): void {
  clearIdleTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    display({
      model_ui: "confirm",
      model_ui_title: "CONEXIÓN WEB",
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

export function handleNetworkInfoRelease(): void {
  const wasHolding = holdTicker !== null || confirmTimer !== null;
  clearHoldTimers();
  pressStartedAt = 0;
  if (!wasHolding) return;
  // A short click just refreshes (in case the network changed while this
  // screen was open) instead of paging through anything.
  void renderScreen();
  armIdleTimer();
}

export function handleNetworkInfoDoubleClick(): void {
  resetNetworkInfoControl();
  onExitCallback();
}
