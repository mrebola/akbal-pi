import { display } from "../../device/display";
import { getWifiRadarSnapshot } from "../../wifiradar/service";
import { AccessPoint } from "../../wifiradar/types";

// Simplified physical-screen version of the web WIFIRADAR page — reads
// from the same shared WifiRadarService (see wifiradar/service.ts), so
// whatever the AR9271 is seeing shows up here too, live or demo, without a
// second capture competing for the interface. No 3D, no click-to-inspect
// (single button, small screen) — just a radar disc with a dot per nearby
// AP, refreshed on a timer while this screen is open. The bottom text band
// carousels through the visible APs one at a time (name + dBm), and the
// dot it's currently naming gets a white outline in chatbot-ui.py so it's
// obvious which one on screen the caption is talking about.
const IDLE_TIMEOUT_MS = 30000;
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
// 3s, not 1.5s — logs from a real device showed this screen redrawing the
// *full* 240x196 frame (rings + up to 12 points, one SPI write) on nearly
// every single tick, because natural RSSI jitter alone was enough to miss
// chatbot-ui.py's render cache on every refresh. That's real CPU + SPI
// bus time (the one screen in the app that redraws this often), and a
// live test showed the physical button stopped registering presses
// entirely while sat on this screen — consistent with the GPIO polling
// thread getting starved by how much rendering was happening. Combined
// with rounding the radius below (see buildPoints) so minor RSSI noise
// stops forcing a redraw by itself, this should leave real headroom for
// button polling — and 3s/name is a more readable carousel pace anyway.
const REFRESH_INTERVAL_MS = 3000;
const MAX_POINTS = 12; // small screen — more than this just clutters it
// Round the visual radius to this step so a couple dBm of normal RSSI
// noise between refreshes doesn't look like the dot moved *and*, more
// importantly, doesn't force chatbot-ui.py's render cache to miss (see
// REFRESH_INTERVAL_MS above) when nothing meaningfully changed.
const RADIUS_STEP = 0.05;

let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let onExitCallback: () => void = () => {};
// Which of the up-to-MAX_POINTS visible APs the bottom text band is
// currently naming — advances by one every refresh tick, so the caption
// (and the white-outlined dot matching it) cycles through whatever's been
// found so far, carousel-style, instead of just showing a static count.
let featuredIndex = 0;

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

function buildPoints(accessPoints: AccessPoint[], featuredAt: number) {
  return accessPoints.slice(0, MAX_POINTS).map((ap, i) => {
    const angle = hash01(ap.id, 17) * Math.PI * 2;
    const rssi = Math.max(-95, Math.min(-30, ap.rssi));
    const rawRadius = 1 - (rssi + 95) / 65; // 0 = strong/close, 1 = weak/far — visual only
    const radius = Math.round(rawRadius / RADIUS_STEP) * RADIUS_STEP;
    return { angle, radius, strength: strengthFor(ap.rssi), featured: i === featuredAt };
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

  const visibleAps = snapshot.accessPoints.slice(0, MAX_POINTS);
  const featured = visibleAps.length > 0 ? visibleAps[featuredIndex % visibleAps.length] : null;
  const points = buildPoints(snapshot.accessPoints, featured ? featuredIndex % visibleAps.length : -1);
  const demoPrefix = snapshot.demo ? "DEMO · " : "";
  const bottomText = featured
    ? `${demoPrefix}${featured.ssid || "(oculta)"} · ${featured.rssi}dBm · Mantén: salir`
    : `${demoPrefix}Buscando redes... · canal ${snapshot.currentChannel || "—"} · Mantén: salir`;

  display({
    model_ui: "",
    help_ui: "",
    radar_ui: "view",
    radar_ui_points: points,
    radar_ui_count: snapshot.accessPoints.length,
    radar_ui_channel: snapshot.currentChannel,
    text: bottomText,
  });

  // Advance for the *next* tick — this tick already rendered with the
  // current featuredIndex.
  featuredIndex += 1;
}

export function resetWifiRadarControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  stopRefreshTimer();
  pressStartedAt = 0;
  featuredIndex = 0;
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
