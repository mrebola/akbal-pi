import { display } from "../../device/display";
import {
  enableAp,
  disableAp,
  getApStatus,
  getApClientCount,
  generateApConnectQrFile,
  generateApUrlQrFile,
} from "../../utils/access-point";

// "WiFi directo" in the quick menu — same feature as the web admin's
// Ajustes > General > "WiFi directo (punto de acceso)" card (both call
// utils/access-point.ts, so toggling from either side is always in sync).
// Replaces the old "Internet emergencia"
// (wifi-manager-mode.ts, removed): instead of joining an existing network,
// this turns the Pi's own wifi card into a direct access point so a phone
// can reach the device with zero setup and no internet at all. Opening the
// menu propagates the hotspot right away (if it wasn't already on) and
// shows a "scan to join" QR (SSID + password). Once a phone actually
// connects — polled via `iw ... station dump` — the screen auto-switches to
// a second QR that opens the web admin at the AP's own local address
// (http://10.42.0.1:8090, never a LAN/Tailscale hostname, since the whole
// point is working with zero internet). A short click flips between the two
// QR views any time, so you can get back to the wifi one if you need to
// reconnect a second device. Holding turns the AP back off and leaves
// (nmcli can't be a client and an AP at once — see utils/access-point.ts);
// a double click just leaves with the AP running as-is.
// Longer than the other menus on purpose: the phone needs time to scan the QR.
const IDLE_TIMEOUT_MS = 60000;
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
const CLIENT_POLL_MS = 2000;

type QrView = "wifi" | "web";

let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let clientPollTimer: ReturnType<typeof setInterval> | null = null;
let active = false; // guards stale renders after backing out mid-request
let busy = false;
// Turning the hotspot off cuts every connected phone, so the first hold
// opens a card: click cancels, a second hold confirms. Same as wardrive.
let confirmingOff = false;
let currentView: QrView = "wifi";
let autoSwitched = false; // only auto-switch once per visit — after that it's manual
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

function stopClientPoll(): void {
  if (clientPollTimer) {
    clearInterval(clientPollTimer);
    clientPollTimer = null;
  }
}

function startClientPoll(): void {
  stopClientPoll();
  clientPollTimer = setInterval(() => {
    void (async () => {
      if (!active || autoSwitched || currentView !== "wifi") return;
      const count = await getApClientCount().catch(() => 0);
      if (!active || autoSwitched || currentView !== "wifi") return;
      if (count > 0) {
        autoSwitched = true;
        currentView = "web";
        await renderView();
      }
    })();
  }, CLIENT_POLL_MS);
}

function showLoading(label: string): void {
  if (!active) return;
  display({
    model_ui: "loading",
    model_ui_title: "WIFI DIRECTO",
    model_ui_label: label,
    model_ui_description: "",
    text: "Un momento...",
  });
}

async function renderView(): Promise<void> {
  const status = await getApStatus();
  if (!active) return;
  if (confirmingOff) {
    display({
      model_ui: "select",
      model_ui_title: "WIFI DIRECTO",
      model_ui_label: "¿Apagar el punto de acceso?",
      model_ui_description: "Se desconectan los teléfonos",
      model_ui_index: 0,
      model_ui_total: 0,
      model_ui_active: false,
      text: "Click: cancelar\nMantén: apagar",
    });
    return;
  }
  if (currentView === "wifi") {
    const qrPath = await generateApConnectQrFile(status).catch((err) => {
      console.warn("[wifi-connect-mode] generateApConnectQrFile failed:", err);
      return "";
    });
    if (!active) return;
    display({
      model_ui: "network",
      model_ui_title: "WIFI DIRECTO",
      model_ui_label: status.ssid,
      model_ui_description: `Clave: ${status.password}`,
      model_ui_qr_path: qrPath,
      text: "Click: cambiar QR\nMantén: apagar",
    });
  } else {
    const qrPath = await generateApUrlQrFile(status).catch((err) => {
      console.warn("[wifi-connect-mode] generateApUrlQrFile failed:", err);
      return "";
    });
    if (!active) return;
    display({
      model_ui: "network",
      model_ui_title: "WIFI DIRECTO",
      model_ui_label: "Abre la web",
      model_ui_description: status.url,
      model_ui_qr_path: qrPath,
      text: "Click: cambiar QR\nMantén: apagar",
    });
  }
}

export function resetWifiConnectControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  pressStartedAt = 0;
  confirmingOff = false;
}

export function onWifiConnectExit(callback: () => void): void {
  onExitCallback = callback;
}

export function enterWifiConnectMode(): void {
  resetWifiConnectControl();
  active = true;
  busy = false;
  currentView = "wifi";
  autoSwitched = false;
  void (async () => {
    const status = await getApStatus();
    if (!active) return;
    if (!status.active) {
      showLoading("Activando akbal-pi...");
      await enableAp().catch((err) => console.warn("[wifi-connect-mode] enableAp failed:", err));
      if (!active) return;
    } else {
      // Already running from a previous visit — if a phone's already
      // connected, skip straight to the web QR instead of making them
      // click through the wifi one again.
      const count = await getApClientCount().catch(() => 0);
      if (!active) return;
      if (count > 0) {
        currentView = "web";
        autoSwitched = true;
      }
    }
    await renderView();
    startClientPoll();
  })();
  armIdleTimer();
}

export function exitWifiConnectMode(): void {
  active = false;
  stopClientPoll();
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
      model_ui_title: "WIFI DIRECTO",
      model_ui_label: confirmingOff ? "Apagando..." : "Apagar punto de acceso",
      model_ui_description: "",
      model_ui_percent: percent,
      text: "Manteniendo presionado...",
    });
  }, HOLD_TICK_MS);
  confirmTimer = setTimeout(() => {
    clearHoldTimers();
    if (!confirmingOff) {
      confirmingOff = true;
      void renderView();
      armIdleTimer();
      return;
    }
    confirmingOff = false;
    busy = true;
    stopClientPoll();
    showLoading("Desactivando...");
    disableAp()
      .catch((err) => console.warn("[wifi-connect-mode] disableAp failed:", err))
      .then(() => {
        busy = false;
        onExitCallback();
      });
  }, CONFIRM_HOLD_MS);
}

export function handleWifiConnectRelease(): void {
  const wasHolding = holdTicker !== null || confirmTimer !== null;
  clearHoldTimers();
  pressStartedAt = 0;
  if (busy || !wasHolding) return;
  // A short click on the off card cancels it, back to the QR view.
  if (confirmingOff) {
    confirmingOff = false;
    void renderView();
    armIdleTimer();
    return;
  }
  // A short click just flips between the two QR views — the menu is a
  // 2-item carousel, nothing to submit.
  currentView = currentView === "wifi" ? "web" : "wifi";
  void renderView();
  armIdleTimer();
}

// Double click = one level back. On the off card it closes the card; from the
// QR view it leaves and the hotspot keeps running.
export function handleWifiConnectDoubleClick(): void {
  if (confirmingOff) {
    confirmingOff = false;
    void renderView();
    armIdleTimer();
    return;
  }
  resetWifiConnectControl();
  stopClientPoll();
  onExitCallback();
}
