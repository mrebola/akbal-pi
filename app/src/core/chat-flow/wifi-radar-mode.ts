import { display } from "../../device/display";
import { getWifiRadarSnapshot } from "../../wifiradar/service";
import { AccessPoint } from "../../wifiradar/types";

// Simplified physical-screen version of the web WIFIRADAR page — reads
// from the same shared WifiRadarService (see wifiradar/service.ts), so
// whatever the AR9271 is seeing shows up here too, live or demo, without a
// second capture competing for the interface. No 3D, no click-to-inspect
// (single button, small screen) — just a radar disc with a dot per nearby
// AP, refreshed on a timer while this screen is open.
const IDLE_TIMEOUT_MS = 30000;
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
const REFRESH_INTERVAL_MS = 1500;
const MAX_POINTS = 12; // small screen — more than this just clutters it

let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
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

function stopRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// Same deterministic per-id angle the web frontend uses (see airspace.js's
// hash01) — not required for correctness, but a given AP sitting at
// roughly the same angle on both the phone/laptop view and this screen is
// a nice bit of consistency for free.
function hash01(str: string, salt: number): number {
  let h = salt >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h ^ str.charCodeAt(i), 2654435761) >>> 0) + h;
  }
  return ((h >>> 0) % 100000) / 100000;
}

function strengthFor(rssi: number): "strong" | "mid" | "weak" {
  if (rssi >= -70) return "strong";
  if (rssi >= -85) return "mid";
  return "weak";
}

function buildPoints(accessPoints: AccessPoint[]) {
  return accessPoints.slice(0, MAX_POINTS).map((ap) => {
    const angle = hash01(ap.id, 17) * Math.PI * 2;
    const rssi = Math.max(-95, Math.min(-30, ap.rssi));
    const radius = 1 - (rssi + 95) / 65; // 0 = strong/close, 1 = weak/far — visual only
    return { angle, radius, strength: strengthFor(ap.rssi) };
  });
}

function renderScreen(): void {
  const snapshot = getWifiRadarSnapshot();
  // demo mode with no hardware string means detectAr9271() never found a
  // compatible adapter at all (see wifiradar/service.ts) — the one case
  // this screen calls out specifically, since it's actionable ("plug one
  // in") rather than just "capture isn't live right now".
  if (snapshot.mode === "demo" && !snapshot.hardware) {
    display({
      model_ui: "",
      help_ui: "",
      radar_ui: "unavailable",
      radar_ui_points: [],
      radar_ui_count: 0,
      radar_ui_channel: 0,
      text: "Conectá un USB WiFi compatible (AR9271) · Mantén: salir",
    });
    return;
  }
  const points = buildPoints(snapshot.accessPoints);
  display({
    model_ui: "",
    help_ui: "",
    radar_ui: "view",
    radar_ui_points: points,
    radar_ui_count: snapshot.accessPoints.length,
    radar_ui_channel: snapshot.currentChannel,
    text: `${snapshot.demo ? "DEMO · " : ""}${snapshot.accessPoints.length} redes · canal ${snapshot.currentChannel || "—"} · Mantén: salir`,
  });
}

export function resetWifiRadarControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  stopRefreshTimer();
  pressStartedAt = 0;
}

export function onWifiRadarExit(callback: () => void): void {
  onExitCallback = callback;
}

export function enterWifiRadarMode(): void {
  resetWifiRadarControl();
  renderScreen();
  refreshTimer = setInterval(renderScreen, REFRESH_INTERVAL_MS);
  armIdleTimer();
}

export function handleWifiRadarPress(): void {
  clearIdleTimer();
  // Paused while holding — otherwise a refresh tick mid-hold would
  // overwrite the "Salir" confirm card with the radar view again.
  stopRefreshTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    display({
      radar_ui: "",
      model_ui: "confirm",
      model_ui_title: "WIFI RADAR",
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

export function handleWifiRadarRelease(): void {
  const wasHolding = holdTicker !== null || confirmTimer !== null;
  clearHoldTimers();
  pressStartedAt = 0;
  if (!wasHolding) return;
  // A short click just refreshes immediately (already auto-refreshing on
  // its own, this is instant feedback for the press) instead of paging
  // through anything.
  renderScreen();
  refreshTimer = setInterval(renderScreen, REFRESH_INTERVAL_MS);
  armIdleTimer();
}

export function handleWifiRadarDoubleClick(): void {
  resetWifiRadarControl();
  onExitCallback();
}
