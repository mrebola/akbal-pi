import { display } from "../../device/display";

// Voice-command cheat sheet, entered when the user says "ayuda" while
// holding the button, or picks "Ayuda" from the quick menu (see
// voice-commands.ts / quick-menu-mode.ts / states.ts). Same grammar as
// every other menu now: click pages through the (at most two) screens,
// holding the button ~0.9s exits, and so does a double click — no dedicated
// "SALIR" screen to click through first.
const IDLE_TIMEOUT_MS = 20000;
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
const ENTRIES_PER_PAGE = 3;

// Each entry renders as two short lines (label, then the phrase to say) —
// measured against the real device font (NotoSansSC-Bold.ttf) to fit the
// safe area at a readable size without wrapping. Capped at two pages
// (ENTRIES_PER_PAGE * 2) on purpose — this is a reminder, not the full
// reference (that's docs/voice-commands.md). Keep new entries within
// roughly the same length as these, or they'll wrap and crowd the screen.
const HELP_ENTRIES: [label: string, example: string][] = [
  ["Volumen", '"sube/baja el volumen"'],
  ["Volumen exacto", '"pon volumen en 40"'],
  ["Cambiar modelo", '"modelo 3"'],
  ["Que modelo uso", '"que modelo usas"'],
  ["Cambiar modo", '"cambiar modo"'],
  ["Esta ayuda", '"ayuda"'],
];

function chunk<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages;
}

const PAGES = chunk(HELP_ENTRIES, ENTRIES_PER_PAGE);

let pageIndex = 0;
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

// Flattened "label\nexample\nlabel\nexample..." — chatbot-ui.py renders even
// lines (0, 2, 4...) as the primary label and odd lines as the secondary
// example, so the two stay visually paired without needing a richer
// payload shape.
function renderScreen(): void {
  const body = PAGES[pageIndex].flatMap(([label, example]) => [label, example]).join("\n");
  display({
    // Whatever screen we arrived from (most often the quick menu, mid-hold
    // on "confirm") can leave model_ui non-empty — chatbot-ui.py's
    // render_frame checks model_ui *before* help_ui, so without this the
    // help screen would never actually draw: the display would just sit
    // frozen on the previous screen forever. This was the "el menú ayuda se
    // traba" bug.
    model_ui: "",
    help_ui: "view",
    help_ui_body: body,
    help_ui_page: pageIndex + 1,
    help_ui_total: PAGES.length,
    text: "Click: siguiente · Mantén: salir",
  });
}

export function onHelpExit(callback: () => void): void {
  onExitCallback = callback;
}

export function resetHelpControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  pressStartedAt = 0;
}

export function enterHelpMode(): void {
  resetHelpControl();
  pageIndex = 0;
  renderScreen();
  armIdleTimer();
}

export function handleHelpPress(): void {
  clearIdleTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    display({
      help_ui: "view",
      model_ui: "confirm",
      model_ui_title: "AYUDA",
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

export function handleHelpRelease(): void {
  // Unlike model/mode-select, there's no "in-between" dead zone here — with
  // only two possible outcomes (advance or exit) and exit already owned by
  // the confirmTimer, any release before that fires should advance, however
  // long the press was. wasHolding is false only if release fires without a
  // matching press (shouldn't happen, but cheap to guard).
  const wasHolding = holdTicker !== null || confirmTimer !== null;
  clearHoldTimers();
  pressStartedAt = 0;
  if (!wasHolding) return;
  pageIndex = (pageIndex + 1) % PAGES.length;
  renderScreen();
  armIdleTimer();
}

export function handleHelpDoubleClick(): void {
  resetHelpControl();
  onExitCallback();
}
