import { display } from "../../device/display";

// Button-driven voice-command cheat sheet, entered when the user says
// "ayuda" while holding the button (see voice-commands.ts / states.ts). A
// single click pages through short command examples; once the last page is
// shown, the button's meaning flips to "Salir" and a click there exits back
// to the idle screen. Double click and the idle timeout are the same
// escape-hatch pattern as model-select-mode.ts / mode-select-mode.ts, minus
// the hold-to-confirm step — there's nothing to confirm here, just pages to
// read and a way out.
const IDLE_TIMEOUT_MS = 20000;
const ENTRIES_PER_PAGE = 2;

// Each entry renders as two short lines (label, then the phrase to say) —
// measured against the real device font (NotoSansSC-Bold.ttf) to fit the
// 240px-wide video area at a readable size without wrapping. Keep new
// entries within roughly the same length as these, or they'll wrap and
// crowd the small screen — see docs/voice-commands.md.
const HELP_ENTRIES: [label: string, example: string][] = [
  ["Volumen", '"sube/baja el volumen"'],
  ["Volumen exacto", '"pon volumen en 40"'],
  ["Cambiar modelo", '"modelo 3"'],
  ["Modo agente/local", '"activa modo agente"'],
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

let pageIndex = 0; // 0..PAGES.length-1 = content pages; PAGES.length = exit page
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let onExitCallback: () => void = () => {};

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

function isOnExitStep(): boolean {
  return pageIndex >= PAGES.length;
}

// Flattened "label\nexample\nlabel\nexample..." — chatbot-ui.py renders even
// lines (0, 2, 4...) as the bright label and odd lines as the dim example,
// so the two stay visually paired without needing a richer payload shape.
function renderScreen(): void {
  if (isOnExitStep()) {
    display({
      help_ui: "exit",
      help_ui_body: "",
      help_ui_page: PAGES.length + 1,
      help_ui_total: PAGES.length,
      text: "Click: salir",
    });
    return;
  }
  const body = PAGES[pageIndex].flatMap(([label, example]) => [label, example]).join("\n");
  display({
    help_ui: "view",
    help_ui_body: body,
    help_ui_page: pageIndex + 1,
    help_ui_total: PAGES.length,
    text: "Click: siguiente",
  });
}

export function onHelpExit(callback: () => void): void {
  onExitCallback = callback;
}

export function resetHelpControl(): void {
  clearIdleTimer();
}

export function enterHelpMode(): void {
  pageIndex = 0;
  renderScreen();
  armIdleTimer();
}

// Plain click (no hold to distinguish) — advances a page, or on the last
// page activates "Salir".
export function handleHelpClick(): void {
  clearIdleTimer();
  if (isOnExitStep()) {
    onExitCallback();
    return;
  }
  pageIndex += 1;
  renderScreen();
  armIdleTimer();
}

export function handleHelpDoubleClick(): void {
  resetHelpControl();
  onExitCallback();
}
