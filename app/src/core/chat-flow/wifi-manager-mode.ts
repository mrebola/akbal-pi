import { display } from "../../device/display";
import {
  connectToEmergencyWifi,
  connectToWifi,
  getWifiStatus,
  hasEmergencyWifiConfigured,
  scanWifiNetworks,
  WifiNetwork,
} from "../../utils/wifi";

// "Internet de emergencia" in the quick menu opens this — a small network
// manager: current connection status (and a way to rescan), the configured
// emergency network if there is one, and whatever else is in range. Click
// pages through entries, holding ~0.9s acts on whichever one is shown
// (connect / rescan), double click or the idle timeout exit — same grammar
// as every other menu. Entering a *new* password for an unknown secured
// network isn't supported here (nothing to type it with) — that's what the
// web UI is for (see docs/wifi.md); this screen can only join networks that
// are open, already saved, or the pre-configured emergency one.
const SHORT_PRESS_MAX_MS = 400;
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
// Longer than the other menus — scanning takes a few seconds, give someone
// reading results more time before it gives up and closes.
const IDLE_TIMEOUT_MS = 30000;
const RESULT_DISPLAY_MS = 2200;

type WifiEntry =
  | { kind: "status"; label: string; description: string }
  | { kind: "emergency"; label: string; description: string }
  | { kind: "network"; label: string; description: string; network: WifiNetwork };

let entries: WifiEntry[] = [];
let selectedIndex = 0;
let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let busy = false;
// Guards deferred renders (after an async connect/scan) from painting over
// whatever's on screen if the user already backed out of this menu.
let active = false;
let onDoneCallback: () => void = () => {};

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
  idleTimer = setTimeout(() => onDoneCallback(), IDLE_TIMEOUT_MS);
}

function describeNetwork(n: WifiNetwork): string {
  if (n.active) return "Conectada ahora";
  if (n.saved) return "Guardada · mantén: conectar";
  if (!n.secure) return "Abierta · mantén: conectar";
  return "Necesita contraseña — usa la web";
}

async function loadEntries(): Promise<void> {
  const [status, networks] = await Promise.all([getWifiStatus(), scanWifiNetworks()]);
  const statusEntry: WifiEntry = {
    kind: "status",
    label: status.connected ? status.ssid! : "Sin conexión",
    description: "Mantén: buscar redes de nuevo",
  };
  const emergencyEntry: WifiEntry[] = hasEmergencyWifiConfigured()
    ? [{ kind: "emergency", label: "Emergencia", description: "Mantén: conectar" }]
    : [];
  const networkEntries: WifiEntry[] = networks
    .filter((n) => !status.connected || n.ssid !== status.ssid) // skip duplicating the active one
    .map((n) => ({ kind: "network" as const, label: n.ssid, description: describeNetwork(n), network: n }));
  entries = [statusEntry, ...emergencyEntry, ...networkEntries];
  selectedIndex = 0;
}

function renderScreen(): void {
  if (!active) return;
  const entry = entries[selectedIndex];
  display({
    status: "wifi_manager",
    model_ui: "select",
    model_ui_title: "WIFI",
    model_ui_label: entry?.label || "—",
    model_ui_description: entry?.description || "",
    model_ui_index: entries.length ? selectedIndex + 1 : 0,
    model_ui_total: entries.length,
    model_ui_active: entry?.kind === "network" && entry.network.active,
    text: "Click: siguiente · Mantén: elegir",
  });
}

function showLoading(label: string): void {
  if (!active) return;
  display({
    status: "wifi_manager",
    model_ui: "loading",
    model_ui_title: "WIFI",
    model_ui_label: label,
    model_ui_description: "",
    text: "Un momento...",
  });
}

function showResult(ok: boolean, label: string): void {
  if (!active) return;
  display({
    status: "wifi_manager",
    model_ui: "select",
    model_ui_title: "WIFI",
    model_ui_label: ok ? "Conectado" : "No se pudo conectar",
    model_ui_description: label,
    model_ui_index: 0,
    model_ui_total: 0,
    model_ui_active: false,
    text: ok ? "" : "Revisá la contraseña o usá la web",
  });
}

async function refresh(): Promise<void> {
  if (!active) return;
  showLoading("Buscando redes...");
  await loadEntries();
  if (!active) return;
  renderScreen();
  armIdleTimer();
}

async function handleConfirm(): Promise<void> {
  const entry = entries[selectedIndex];
  if (!entry || entry.kind === "status") {
    await refresh();
    return;
  }
  if (entry.kind === "emergency") {
    showLoading("Conectando...");
    const result = await connectToEmergencyWifi();
    if (!active) return;
    showResult(result.ok, result.ok ? "Red de emergencia" : result.error || "Error");
    setTimeout(() => void refresh(), RESULT_DISPLAY_MS);
    return;
  }
  const net = entry.network;
  if (net.active) {
    renderScreen();
    armIdleTimer();
    return;
  }
  if (!net.saved && net.secure) {
    // Nothing to type a password with here — see the module comment.
    if (!active) return;
    display({
      model_ui_description: "Necesita contraseña — usa la web",
      text: "Doble clic: salir",
    });
    setTimeout(() => {
      renderScreen();
      armIdleTimer();
    }, RESULT_DISPLAY_MS);
    return;
  }
  showLoading(`Conectando a ${net.ssid}...`);
  const result = await connectToWifi(net.ssid);
  if (!active) return;
  showResult(result.ok, result.ok ? net.ssid : result.error || "Error");
  setTimeout(() => void refresh(), RESULT_DISPLAY_MS);
}

export function onWifiManagerDone(callback: () => void): void {
  onDoneCallback = callback;
}

export function resetWifiManagerControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  pressStartedAt = 0;
}

export function exitWifiManagerMode(): void {
  active = false;
  resetWifiManagerControl();
}

export async function enterWifiManagerMode(): Promise<void> {
  resetWifiManagerControl();
  active = true;
  busy = false;
  entries = [];
  await refresh();
}

export function handleWifiManagerPress(): void {
  if (busy || entries.length === 0) return;
  clearIdleTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    if (!active) return;
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    const entry = entries[selectedIndex];
    display({
      model_ui: "confirm",
      model_ui_title: "WIFI",
      model_ui_label: entry?.label || "—",
      model_ui_description: "",
      model_ui_percent: percent,
      text: "Manteniendo presionado...",
    });
  }, HOLD_TICK_MS);
  confirmTimer = setTimeout(() => {
    clearHoldTimers();
    busy = true;
    handleConfirm().finally(() => {
      busy = false;
    });
  }, CONFIRM_HOLD_MS);
}

export function handleWifiManagerRelease(): void {
  const duration = Date.now() - pressStartedAt;
  clearHoldTimers();
  pressStartedAt = 0;
  if (busy) return;
  if (duration > 0 && duration <= SHORT_PRESS_MAX_MS && entries.length > 0) {
    selectedIndex = (selectedIndex + 1) % entries.length;
  }
  renderScreen();
  armIdleTimer();
}

export function handleWifiManagerCancel(): void {
  if (busy) return;
  resetWifiManagerControl();
  onDoneCallback();
}
