import { display } from "../../device/display";
import { generateConnectQr } from "../../utils/network-info";

// "Acerca de" quick-menu item: Akbal is named after a character from
// Cypher404: El Manifiesto (the book by César Gaytán this whole project
// takes its inspiration from — see README.md). This is a condensed,
// paged teaser of the manifesto, ending on a QR code to buy the book.
// Same click/hold/double-click grammar as help-mode.ts (this screen's
// closest relative — paged text, holding ~0.9s or a double click exits),
// with one extra page at the end for the QR, generated lazily and cached
// since the URL never changes at runtime.
const IDLE_TIMEOUT_MS = 25000;
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
export const BOOK_URL = "https://cypher404.com/book";

// Condensed from the full manifesto — see README.md's "Por qué Akbal" and
// the web admin's Acerca de page (app/web/admin/about.html) for the
// complete text. Kept short per page on purpose, same spirit as
// help-mode.ts's cheat sheet vs. docs/voice-commands.md: this is a
// teaser, not the full reference.
const PAGES: string[] = [
  "Cypher404: El Manifiesto. Todo sistema puede ser hackeado.",
  "Nexora es una ciudad donde el hacking, la IA, la vigilancia masiva y las corporaciones gobiernan cada aspecto de la vida.",
  "Cuando Akbal empieza a manipular infraestructura, información y personas, Cypher, Namna y Aichi caen en una guerra invisible.",
  "El verdadero peligro no es la tecnología... sino el error humano.",
  "De César Gaytán, creador de Hackwise y director general en Dactima y Galditi.",
];

let pageIndex = 0;
let qrPath = "";
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

// Total pages = the text PAGES plus one final QR page.
const TOTAL_PAGES = PAGES.length + 1;

async function renderScreen(): Promise<void> {
  if (pageIndex < PAGES.length) {
    display({
      model_ui: "",
      about_ui: "view",
      about_ui_title: "ACERCA DE",
      about_ui_body: PAGES[pageIndex],
      about_ui_page: pageIndex + 1,
      about_ui_total: TOTAL_PAGES,
      text: "Click: siguiente · Mantén: salir",
    });
    return;
  }
  // Final page: QR to buy the book — same mechanism network-info-mode.ts
  // uses for its own QR, just pointed at BOOK_URL instead of the admin
  // web's URL.
  if (!qrPath) {
    display({
      about_ui: "",
      model_ui: "loading",
      model_ui_title: "ACERCA DE",
      model_ui_label: "Generando QR...",
      model_ui_description: "",
      text: "Un momento...",
    });
    qrPath = await generateConnectQr(BOOK_URL).catch((err) => {
      console.warn("[about-mode] generateConnectQr failed:", err);
      return "";
    });
  }
  display({
    about_ui: "",
    model_ui: "network",
    model_ui_title: "ACERCA DE",
    model_ui_label: "Cypher404: El Manifiesto",
    model_ui_description: "cypher404.com/book",
    model_ui_qr_path: qrPath,
    text: "Escaneá para comprar el libro · Mantén: salir",
  });
}

export function resetAboutControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  pressStartedAt = 0;
}

export function onAboutExit(callback: () => void): void {
  onExitCallback = callback;
}

export function enterAboutMode(): void {
  resetAboutControl();
  pageIndex = 0;
  void renderScreen();
  armIdleTimer();
}

export function handleAboutPress(): void {
  clearIdleTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    display({
      about_ui: "view",
      model_ui: "confirm",
      model_ui_title: "ACERCA DE",
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

export function handleAboutRelease(): void {
  const wasHolding = holdTicker !== null || confirmTimer !== null;
  clearHoldTimers();
  pressStartedAt = 0;
  if (!wasHolding) return;
  pageIndex = (pageIndex + 1) % TOTAL_PAGES;
  void renderScreen();
  armIdleTimer();
}

export function handleAboutDoubleClick(): void {
  resetAboutControl();
  onExitCallback();
}
