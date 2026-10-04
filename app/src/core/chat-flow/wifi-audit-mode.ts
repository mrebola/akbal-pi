import { display, onButtonDown, onButtonUp, setMainButtonSuspended } from "../../device/display";
import { getWardriveService } from "../../wifi-audit/service";
import { WardriveStatus } from "../../wifi-audit/types";

// Physical-screen companion of the web "Wardriving" tab. NOT a button-driven
// flow state: entering/leaving wardriving is normally a web-admin action
// (the radio gets held for the whole session). While the mode is active the
// physical button gets a dedicated escape hatch — a HOLD (0.9s, same as every
// other screen) opens an exit card, and a second hold leaves wardriving and
// returns the device to normal Akbal; short clicks are
// ignored (the radio is busy, no menu). This is the physical escape hatch —
// the web can always cancel the session itself via POST /api/wardrive/exit.
//
// Screen: idle look — the same calm Akbal standing loop — but with a red
// "MODO WIFI AUDIT" band (rendered by chatbot-ui.py's render_wardrive_screen).
// While an audit is running the character is replaced by the wifi-audit
// attack animation and the brief action status ("deauth", "capturando
// handshake"...) renders over it. The service itself unloads the LLM on
// enter (wifi-audit/service.ts).

let statusListener: ((payload: any) => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
// Physical-button exit: press-and-hold while in wardriving mode. Timestamps
// come from the display's button press/release callbacks — registered here
// (not in states.ts) so the gesture works no matter which chat-flow state
// the device is in.
let buttonPressedAt: number | null = null;
let holdCheckTimer: ReturnType<typeof setInterval> | null = null;
// Stopping the audit ends a session, so the first hold only opens a card:
// click cancels it, a second hold confirms. Same grammar as wardrive-mode.ts.
let confirmingExit = false;

const POLL_MS = 2000;
const HOLD_EXIT_MS = 900;

// This mode listens to the raw button (not the chat-flow double-click hook),
// so it times a double click itself: two short clicks within this window.
const DOUBLE_CLICK_MS = 400;
let lastShortClickAt = 0;

function handleButtonPress(): void {
  const now = Date.now();
  if (confirmingExit && lastShortClickAt && now - lastShortClickAt < DOUBLE_CLICK_MS) {
    // Double click on the exit card = back to the live view.
    lastShortClickAt = 0;
    confirmingExit = false;
    paint(getWardriveService().getStatus());
    return;
  }
  buttonPressedAt = now;
  if (!holdCheckTimer) {
    holdCheckTimer = setInterval(() => {
      if (buttonPressedAt !== null && Date.now() - buttonPressedAt >= HOLD_EXIT_MS) {
        const st = getWardriveService().getStatus();
        if (st.mode !== "inactive") {
          buttonPressedAt = null;
          if (holdCheckTimer) {
            clearInterval(holdCheckTimer);
            holdCheckTimer = null;
          }
          if (!confirmingExit) {
            confirmingExit = true;
            paint(st);
            return;
          }
          console.log("[wifi-audit] physical hold confirmed — leaving audit");
          confirmingExit = false;
          void getWardriveService().exit();
        }
      }
    }, 200);
  }
}

function handleButtonRelease(): void {
  const pressedFor = buttonPressedAt === null ? 0 : Date.now() - buttonPressedAt;
  buttonPressedAt = null;
  if (holdCheckTimer) {
    clearInterval(holdCheckTimer);
    holdCheckTimer = null;
  }
  // A short click is only remembered for double-click detection; on the exit
  // card it does nothing (hold confirms, double click cancels).
  if (pressedFor > 0 && pressedFor < HOLD_EXIT_MS) lastShortClickAt = Date.now();
}

function paint(status: WardriveStatus): void {
  if (confirmingExit) {
    display({
      status: "wardrive",
      emoji: "📡",
      RGB: "#ff9500",
      wardrive_ui: "",
      model_ui: "select",
      model_ui_title: "WIFI AUDIT",
      model_ui_label: "¿Salir de la auditoría?",
      model_ui_description: "Termina la sesión actual",
      model_ui_index: 0,
      model_ui_total: 0,
      model_ui_active: false,
      text: "Mantén: salir\nDoble clic: volver",
    });
    return;
  }
  const captured = status.session?.targets.filter((t) => t.status === "captured").length || 0;
  const total = status.session?.targets.length || 0;
  const attacking = status.mode === "attacking";
  const current = status.session?.targets.find((t) => t.bssid === status.session?.currentBssid);
  // Brief action lines for the LCD (rendered as the small text under the
  // animation): what the audit is doing right now, plain words. "Handshake
  // capturado" shows the moment a capture lands (capturing AND after).
  const sessionCaptured = status.session?.targets.some((t) => t.status === "captured") || captured > 0;
  const statusText =
    status.mode === "scanning"
      ? "Revisando tráfico..."
      : attacking
        ? current
          ? current.method === "deauth"
            ? "Realizando deauth..."
            : "Capturando handshake..."
          : "Revisando tráfico..."
        : sessionCaptured
          ? "Handshake capturado"
          : status.mode === "ready"
            ? "Audit wifi mode activo"
            : "Audit wifi mode activo";
  display({
    status: "wardrive",
    emoji: "📡",
    RGB: attacking ? "#ff3030" : "#ff9500",
    text: statusText,
    // The overlay replaces the whole character UI — no menu card.
    model_ui: "",
    help_ui: "",
    radar_ui: "",
    wardrive_ui: "view",
    wardrive_label: status.iface ? `WIFI AUDIT ${status.iface.toUpperCase()}` : "WIFI AUDIT",
    wardrive_status_text: statusText,
    wardrive_captured: captured,
    wardrive_total: total,
  });
}

export function startWardriveDisplayMirror(): void {
  const service = getWardriveService();
  if (statusListener) return;
  statusListener = (payload: any) => {
    if (payload?.type !== "status") return;
    const st: WardriveStatus = payload.status;
    if (st.mode === "inactive") {
      confirmingExit = false;
      // Leaving wardriving: give the button back to whatever chat-flow
      // state is actually current (see setMainButtonSuspended below).
      setMainButtonSuspended(false);
      // Clear the overlay; the normal sleep screen takes over on the next
      // render (states.ts sleep handler also clears it, but do it here so
      // the screen flips immediately).
      display({
        status: "idle",
        emoji: "😴",
        RGB: "#000055",
        wardrive_ui: "",
        wardrive_label: "",
        wardrive_status_text: "",
        text: "Saliendo del modo wifi audit...",
      });
      return;
    }
    // Entering wardriving suspends the chat-flow's own button handling: a
    // short click otherwise still opens the quick menu (usually still in
    // "sleep" underneath, since the service unloads the LLM on enter) and a
    // hold still triggers push-to-talk, completely out of sync with what's
    // on screen. The hold-to-exit gesture above is wired through
    // onButtonDown/onButtonUp instead, so it keeps working regardless.
    setMainButtonSuspended(true);
    paint(st);
  };
  service.on("status", statusListener);
  // Physical hold-to-exit: registered once, independent of chat-flow state —
  // the check inside the handler only acts while wardriving is active.
  onButtonDown(handleButtonPress);
  onButtonUp(handleButtonRelease);
  // Poll as a fallback (e.g. missed events after a rebuild/restart while
  // the mode stayed active).
  pollTimer = setInterval(() => {
    const st = service.getStatus();
    if (st.mode !== "inactive") paint(st);
  }, POLL_MS);
}

export function stopWardriveDisplayMirror(): void {
  const service = getWardriveService();
  if (statusListener) {
    service.off("status", statusListener);
    statusListener = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}