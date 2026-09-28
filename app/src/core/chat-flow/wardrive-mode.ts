import { display } from "../../device/display";
import { getDriveWardriveService } from "../../wardrive/service";
import { DriveStatus } from "../../wardrive/types";

// Physical-screen companion of the web /wardrive page (docs/wardrive.md).
// Like wifi-radar-mode.ts / aircraft-radar-mode.ts: a button-driven flow
// state with hold-to-exit, reading from the shared DriveWardriveService so
// the web and the screen always show the same session. The service is
// STARTED from here too (the quick menu's "Wardrive" item) — same radio the
// radar holds, so entering stops the radar capture and leaving restores it
// (wardrive/service.ts's own start/stop do that swap). Web and device stay
// equivalent: POST /api/wardrive/drive/stop cancels a physical session and
// holding the button exits a web-started one.

const IDLE_TIMEOUT_MS = 30000;
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
// 3s like the other radar screens: each refresh rewrites the full frame and
// faster ticks starved the GPIO button polling on real hardware (see
// wifi-radar-mode.ts's REFRESH_INTERVAL_MS note).
const REFRESH_INTERVAL_MS = 3000;

let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;
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
    clearInterval(idleTimer);
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

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${String(m % 60).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`;
}

function renderScreen(): void {
  const st: DriveStatus = getDriveWardriveService().getStatus();
  if (st.running) {
    // LIVE SESSION — the wardrive overlay (render_wardrive_screen in
    // chatbot-ui.py): animated scene + counters + one-line status. Keep
    // model_ui/help_ui/radar_ui cleared so no other card can layer on top.
    const s = st.stats;
    const hs = s.newHandshakes;
    const attacking = (st.recent || []).some((ap) => ap.status === "attacking");
    const statusText = attacking
      ? "Deauth activo..."
      : st.gps.hasFix
        ? `Escaneando... ${st.gps.speedKmh != null ? Math.round(st.gps.speedKmh) + "km/h" : ""}`.trim()
        : "Escaneando redes...";
    display({
      status: "wardrive",
      emoji: "📡",
      RGB: attacking ? "#ff3030" : "#ff9500",
      text: statusText,
      model_ui: "",
      help_ui: "",
      radar_ui: "",
      aircraft_radar_ui: "",
      wardrive_ui: "view",
      wardrive_label: st.iface ? `WARDRIVE ${st.iface.toUpperCase()}` : "WARDRIVE",
      wardrive_status_text: statusText,
      wardrive_captured: hs,
      wardrive_total: st.stats.aps,
    });
    return;
  }
  // Not running: a start card. Confirm (hold ~0.9s) starts the session.
  const noAdapter = Boolean(st.error) && !st.iface;
  const startText = noAdapter ? st.error || "Sin adaptador · Mantén: iniciar" : "Mantén: iniciar wardrive";
  display({
    status: "wardrive_menu",
    emoji: "🚗",
    RGB: "#ff9500",
    text: startText,
    model_ui: "confirm",
    model_ui_title: "WARDRIVE",
    model_ui_label: noAdapter ? "Sin adaptador" : "Iniciar captura",
    model_ui_description: noAdapter ? "" : "GPS + handshakes + mapa",
    model_ui_percent: 0,
  });
}

export function resetWardriveControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  stopRefreshTimer();
  pressStartedAt = 0;
}

export function onWardriveExit(callback: () => void): void {
  onExitCallback = callback;
}

export function enterWardriveMode(): void {
  resetWardriveControl();
  renderScreen();
  refreshTimer = setInterval(renderScreen, REFRESH_INTERVAL_MS);
  armIdleTimer();
}

export function handleWardrivePress(): void {
  clearIdleTimer();
  // Paused while holding — a refresh tick mid-hold would overwrite the
  // confirm card with the live view again.
  stopRefreshTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    const st = getDriveWardriveService().getStatus();
    if (st.running) {
      // Holding while a session runs = the exit gesture. Show the ring too.
      display({
        wardrive_ui: "",
        model_ui: "confirm",
        model_ui_title: "WARDRIVE",
        model_ui_label: "Detener",
        model_ui_description: "",
        model_ui_percent: percent,
        text: "Manteniendo presionado...",
      });
      return;
    }
    display({
      wardrive_ui: "",
      model_ui: "confirm",
      model_ui_title: "WARDRIVE",
      model_ui_label: "Iniciar captura",
      model_ui_description: "",
      model_ui_percent: percent,
      text: "Manteniendo presionado...",
    });
  }, HOLD_TICK_MS);
  confirmTimer = setTimeout(() => {
    clearHoldTimers();
    onConfirmHold();
  }, CONFIRM_HOLD_MS);
}

async function onConfirmHold(): Promise<void> {
  const st = getDriveWardriveService().getStatus();
  if (st.running) {
    // Exit gesture from the live screen (also works from the web side —
    // the service is the single source of truth for either entry point).
    onExitCallback();
    return;
  }
  // Starting: show a loading card while the radio/monitor switch runs.
  display({
    status: "wardrive",
    wardrive_ui: "",
    model_ui: "loading",
    model_ui_title: "WARDRIVE",
    model_ui_label: "Preparando captura...",
    model_ui_description: "",
    text: "Iniciando wardrive...",
  });
  const res = await getDriveWardriveService().start();
  if (!res.ok && res.error) {
    display({
      status: "wardrive",
      emoji: "⚠️",
      RGB: "#ff3030",
      wardrive_ui: "",
      model_ui: "",
      radar_ui: "",
      text: res.error,
    });
    refreshTimer = setInterval(renderScreen, REFRESH_INTERVAL_MS);
    armIdleTimer();
    return;
  }
  // Session started: paint the live screen right away (the refresh timer
  // takes over from here).
  renderScreen();
  refreshTimer = setInterval(renderScreen, REFRESH_INTERVAL_MS);
  // Stay in this screen while the session runs — the operator is driving;
  // idle-timeout only when nothing is running (exit returns to sleep).
  clearIdleTimer();
}

export function handleWardriveRelease(): void {
  const wasHolding = holdTicker !== null || confirmTimer !== null;
  clearHoldTimers();
  pressStartedAt = 0;
  if (!wasHolding) return;
  // A short click just refreshes immediately (session state, counters).
  renderScreen();
  refreshTimer = setInterval(renderScreen, REFRESH_INTERVAL_MS);
  const st = getDriveWardriveService().getStatus();
  if (!st.running) armIdleTimer(); // start-screen still idles out
}

export function handleWardriveDoubleClick(): void {
  resetWardriveControl();
  onExitCallback();
}

// ─── Web-started session mirror ─────────────────────────────────────────────
// A session started from the web (POST /api/wardrive/drive/start) must also
// show up on the physical LCD ("desde la Pi o la web es indistinto"). The
// web-started case has no flow state behind it, so the service's own status
// events drive the overlay: subscribe once at boot (index.ts) and paint while
// running. The button-driven flow above keeps priority: while the user is IN
// the wardrive screen, its own renders win and this mirror only paints when
// a stop event arrives (leaving → clears the overlay).

let mirrorListener: ((st: DriveStatus) => void) | null = null;
let mirrorClearTimer: ReturnType<typeof setTimeout> | null = null;

export function startWardriveDisplayMirror(): void {
  if (mirrorListener) return;
  mirrorListener = (st: DriveStatus) => {
    if (!st.running) {
      // Session ended (from web or device): clear the overlay so the normal
      // Akbal screen returns. If the operator is inside the wardrive flow
      // state, its renderScreen() re-paints the start card on the next tick.
      if (mirrorClearTimer) clearTimeout(mirrorClearTimer);
      mirrorClearTimer = setTimeout(() => {
        display({
          status: "idle",
          emoji: "😴",
          RGB: "#000055",
          model_ui: "",
          radar_ui: "",
          aircraft_radar_ui: "",
          wardrive_ui: "",
          wardrive_label: "",
          wardrive_status_text: "",
          wardrive_captured: 0,
          wardrive_total: 0,
          text: "Wardrive detenido",
        });
      }, 400);
      return;
    }
    if (mirrorClearTimer) {
      clearTimeout(mirrorClearTimer);
      mirrorClearTimer = null;
    }
    // Same overlay the in-screen renderer uses — but only when the chat-flow
    // state machine isn't already drawing it (its refresh timer wins; this
    // covers the web-started case where no state screen is drawing).
    const s = st.stats;
    const attacking = (st.recent || []).some((ap) => ap.status === "attacking");
    const statusText = attacking
      ? "Deauth activo..."
      : st.gps.hasFix
        ? `Escaneando... ${st.gps.speedKmh != null ? Math.round(st.gps.speedKmh) + "km/h" : ""}`.trim()
        : "Escaneando redes...";
    display({
      status: "wardrive",
      emoji: "📡",
      RGB: attacking ? "#ff3030" : "#ff9500",
      text: statusText,
      model_ui: "",
      help_ui: "",
      radar_ui: "",
      aircraft_radar_ui: "",
      wardrive_ui: "view",
      wardrive_label: st.iface ? `WARDRIVE ${st.iface.toUpperCase()}` : "WARDRIVE",
      wardrive_status_text: statusText,
      wardrive_captured: st.stats.newHandshakes,
      wardrive_total: st.stats.aps,
    });
  };
  getDriveWardriveService().on("status", mirrorListener as any);
}

export function stopWardriveDisplayMirror(): void {
  if (mirrorListener) {
    getDriveWardriveService().off("status", mirrorListener as any);
    mirrorListener = null;
  }
  if (mirrorClearTimer) {
    clearTimeout(mirrorClearTimer);
    mirrorClearTimer = null;
  }
}