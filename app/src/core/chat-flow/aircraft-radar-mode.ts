import { display } from "../../device/display";
import { getAircraftRadarSnapshot } from "../../services/adsb/service";
import { Aircraft } from "../../services/adsb/types";

// Simplified physical-screen version of the web Aircraft Radar page — reads
// from the same shared AircraftRadarService (see services/adsb/service.ts),
// so whatever the HackRF is decoding shows up here too, live or demo,
// without a second capture competing for the SDR. Same shape as
// wifi-radar-mode.ts (that file's comments cover the general mechanics:
// hold-to-exit, idle timeout, carousel caption) — the one real difference is
// that points here use the aircraft's actual GPS bearing/distance instead of
// a hashed layout, since Akbal has a real position to plot against.
const IDLE_TIMEOUT_MS = 30000;
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
// Same 3s cadence as wifi-radar-mode.ts, and for the same reason: this is
// the one screen that redraws the whole 240x196 frame (rings + up to 12
// points) on nearly every tick, and a faster refresh measurably starved the
// GPIO button-polling thread on real hardware.
const REFRESH_INTERVAL_MS = 3000;
const MAX_POINTS = 12;
const RADIUS_STEP = 0.05;
const MAX_RANGE_KM = 100; // same outer ring as the web page's radar

let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let onExitCallback: () => void = () => {};
// Which of the up-to-MAX_POINTS visible aircraft the bottom text band is
// currently naming — advances every refresh tick, carousel-style, same as
// wifi-radar-mode.ts's featuredIndex.
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

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function compass(deg: number): string {
  return COMPASS[Math.round(deg / 45) % 8];
}

// approaching -> "strong" (green), receding -> "weak" (red), unknown ->
// "mid" (yellow) — repurposing the same three-tier color the WiFi radar
// screen uses for RSSI strength (see chatbot-ui.py's render_aircraft_radar_screen).
function strengthFor(aircraft: Aircraft): "strong" | "mid" | "weak" {
  if (aircraft.approaching === true) return "strong";
  if (aircraft.approaching === false) return "weak";
  return "mid";
}

// Only aircraft with a real bearing/distance (i.e. Akbal has a GPS fix) can
// be placed on the disc — same "no data, don't guess" rule as everywhere
// else in this feature. Positionless aircraft are simply left out of the
// drawn points (see renderScreen's bottomText for how that's called out).
function buildPoints(aircraft: Aircraft[], featuredAt: number) {
  const positioned = aircraft.filter((a) => a.distanceKm !== null && a.bearingDeg !== null);
  return positioned.slice(0, MAX_POINTS).map((a, i) => {
    const angle = ((a.bearingDeg! - 90) * Math.PI) / 180;
    const rawRadius = Math.min(1, a.distanceKm! / MAX_RANGE_KM);
    const radius = Math.round(rawRadius / RADIUS_STEP) * RADIUS_STEP;
    return { angle, radius, strength: strengthFor(a), featured: i === featuredAt };
  });
}

function renderScreen(): void {
  const snapshot = getAircraftRadarSnapshot();
  // demo mode with no hardware string means detectHackRf() never found a
  // HackRF on USB at all — the one case this screen calls out specifically
  // (actionable: "plug one in"), same distinction wifi-radar-mode.ts draws
  // for its own adapter.
  if (snapshot.mode === "demo" && !snapshot.hardware) {
    display({
      model_ui: "",
      help_ui: "",
      aircraft_radar_ui: "unavailable",
      aircraft_radar_ui_points: [],
      aircraft_radar_ui_count: 0,
      text: "Conecta el HackRF por USB · Mantén: salir",
    });
    return;
  }

  const positioned = snapshot.aircraft.filter((a) => a.distanceKm !== null && a.bearingDeg !== null);
  const visible = positioned.slice(0, MAX_POINTS);
  const featured = visible.length > 0 ? visible[featuredIndex % visible.length] : null;
  const points = buildPoints(snapshot.aircraft, featured ? featuredIndex % visible.length : -1);
  const demoPrefix = snapshot.demo ? "DEMO · " : "";

  let bottomText: string;
  if (featured) {
    const name = featured.callsign || featured.icao;
    bottomText = `${demoPrefix}${name} · ${featured.distanceKm!.toFixed(1)}km ${compass(featured.bearingDeg!)} · Mantén: salir`;
  } else if (snapshot.aircraft.length > 0) {
    bottomText = `${demoPrefix}${snapshot.aircraft.length} aeronave(s) sin fix GPS · Mantén: salir`;
  } else {
    bottomText = `${demoPrefix}Buscando aeronaves... · Mantén: salir`;
  }

  display({
    model_ui: "",
    help_ui: "",
    aircraft_radar_ui: "view",
    aircraft_radar_ui_points: points,
    aircraft_radar_ui_count: positioned.length,
    text: bottomText,
  });

  // Advance for the *next* tick — this tick already rendered with the
  // current featuredIndex.
  featuredIndex += 1;
}

export function resetAircraftRadarControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  stopRefreshTimer();
  pressStartedAt = 0;
  featuredIndex = 0;
}

export function onAircraftRadarExit(callback: () => void): void {
  onExitCallback = callback;
}

export function enterAircraftRadarMode(): void {
  resetAircraftRadarControl();
  renderScreen();
  refreshTimer = setInterval(renderScreen, REFRESH_INTERVAL_MS);
  armIdleTimer();
}

export function handleAircraftRadarPress(): void {
  clearIdleTimer();
  // Paused while holding — otherwise a refresh tick mid-hold would
  // overwrite the "Salir" confirm card with the radar view again.
  stopRefreshTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    display({
      aircraft_radar_ui: "",
      model_ui: "confirm",
      model_ui_title: "RADAR AVIONES",
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

export function handleAircraftRadarRelease(): void {
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

export function handleAircraftRadarDoubleClick(): void {
  resetAircraftRadarControl();
  onExitCallback();
}
