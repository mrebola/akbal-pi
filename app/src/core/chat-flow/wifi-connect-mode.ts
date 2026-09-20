import { display } from "../../device/display";
import {
  enableAp,
  disableAp,
  getApStatus,
  getApClientCount,
  generateApConnectQrFile,
  generateApUrlQrFile,
} from "../../utils/access-point";

// "Wifi connect" in the quick menu — replaces the old "Internet emergencia"
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
const IDLE_TIMEOUT_MS = 60000; // longer than other menus — reading/scanning a QR takes a moment
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
    model_ui_title: "WIFI CONNECT",
    model_ui_label: label,
    model_ui_description: "",
    text: "Un momento...",
  });
}

async function renderView(): Promise<void> {
  const status = await getApStatus();
  if (!active) return;
  if (currentView === "wifi") {
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
      text: `Uní tu teléfono a "${status.ssid}" · Click: QR de la web · Mantén: desactivar`,
    });
  } else {
    const qrPath = await generateApUrlQrFile(status).catch((err) => {
      console.warn("[wifi-connect-mode] generateApUrlQrFile failed:", err);
      return "";
    });
    if (!active) return;
    display({
      model_ui: "network",
      model_ui_title: "WIFI CONNECT",
      model_ui_label: "Abrí la web",
      model_ui_description: status.url,
      model_ui_qr_path: qrPath,
      text: "Escaneá para abrir la web · Click: QR del wifi · Mantén: desactivar",
    });
  }
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
      model_ui_title: "WIFI CONNECT",
      model_ui_label: "Desactivar y salir",
      model_ui_description: "",
      model_ui_percent: percent,
      text: "Manteniendo presionado...",
    });
  }, HOLD_TICK_MS);
  confirmTimer = setTimeout(() => {
    clearHoldTimers();
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
  // A short click just flips between the two QR views — the menu is a
  // 2-item carousel, nothing to submit.
  currentView = currentView === "wifi" ? "web" : "wifi";
  void renderView();
  armIdleTimer();
}

export function handleWifiConnectDoubleClick(): void {
  resetWifiConnectControl();
  stopClientPoll();
  onExitCallback();
}
