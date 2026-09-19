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
const PAGE_SIZE = 4;

const HELP_ENTRIES: string[] = [
  'Volumen: "sube/baja el volumen"',
  'Volumen exacto: "pon el volumen en 40"',
  'Cambiar modelo: "modelo 3"',
  'Menú de modelos: "cambia modelo"',
  'Qué modelo uso: "qué modelo usás"',
  'Modo agente: "activa modo agente"',
  'Modo local: "activa modo local"',
  'Esta ayuda: mantené y decí "ayuda"',
];

function chunk(items: string[], size: number): string[][] {
  const pages: string[][] = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages;
}

const PAGES = chunk(HELP_ENTRIES, PAGE_SIZE);

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
  display({
    help_ui: "view",
    help_ui_body: PAGES[pageIndex].join("\n"),
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
