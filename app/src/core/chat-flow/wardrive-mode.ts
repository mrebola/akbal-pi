import { display, onButtonDown, onButtonUp } from "../../device/display";
import { getWardriveService } from "../../wardrive/service";
import { WardriveStatus } from "../../wardrive/types";

// Physical-screen companion of the web "Wardriving" tab. NOT a button-driven
// flow state: entering/leaving wardriving is normally a web-admin action
// (the radio gets held for the whole session). While the mode is active the
// physical button gets a dedicated escape hatch — a HOLD (~1.2s, long press)
// exits wardriving and returns the device to normal Akbal; short clicks are
// ignored (the radio is busy, no menu). This is the physical escape hatch —
// the web can always cancel the session itself via POST /api/wardrive/exit.
//
// Screen: idle look — the same calm Akbal standing loop — but with a red
// "MODO WARDRIVE" band (rendered by chatbot-ui.py's render_wardrive_screen).
// While an audit is running the character is replaced by the wardrive
// attack animation and the brief action status ("deauth", "capturando
// handshake"...) renders over it. The service itself unloads the LLM on
// enter (wardrive/service.ts).

let statusListener: ((payload: any) => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
// Physical-button exit: press-and-hold while in wardriving mode. Timestamps
// come from the display's button press/release callbacks — registered here
// (not in states.ts) so the gesture works no matter which chat-flow state
// the device is in.
let buttonPressedAt: number | null = null;
let holdCheckTimer: ReturnType<typeof setInterval> | null = null;

const POLL_MS = 2000;
const HOLD_EXIT_MS = 1200;

function handleButtonPress(): void {
  buttonPressedAt = Date.now();
  if (!holdCheckTimer) {
    holdCheckTimer = setInterval(() => {
      if (buttonPressedAt !== null && Date.now() - buttonPressedAt >= 1000) {
        const st = getWardriveService().getStatus();
        if (st.mode !== "inactive") {
          console.log("[wardrive] physical hold detected — leaving wardriving");
          buttonPressedAt = null;
          if (holdCheckTimer) {
            clearInterval(holdCheckTimer);
            holdCheckTimer = null;
          }
          void getWardriveService().exit();
        }
      }
    }, 200);
  }
}

function handleButtonRelease(): void {
  buttonPressedAt = null;
  if (holdCheckTimer) {
    clearInterval(holdCheckTimer);
    holdCheckTimer = null;
  }
}

function paint(status: WardriveStatus): void {
  const captured = status.session?.targets.filter((t) => t.status === "captured").length || 0;
  const total = status.session?.targets.length || 0;
  const attacking = status.mode === "attacking";
  const current = status.session?.targets.find((t) => t.bssid === status.session?.currentBssid);
  // Brief action lines for the LCD (rendered as the small text under the
  // animation): what the audit is doing right now, plain words. "Handshake
  // capturado" shows whenever at least one capture exists this session.
  const statusText =
    status.mode === "scanning"
      ? "Revisando tráfico..."
      : attacking
        ? current
          ? current.method === "deauth"
            ? "Realizando deauth..."
            : "Capturando handshake..."
          : "Revisando tráfico..."
        : status.mode === "ready"
          ? captured > 0
            ? "Handshake capturado"
            : "Modo wardriving activo"
          : "Modo wardriving activo";
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
    wardrive_label: status.iface ? `AUDIT WIFI ${status.iface.toUpperCase()}` : "AUDIT WIFI",
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
      // Leaving wardriving: clear the overlay; the normal sleep screen
      // takes over on the next render (states.ts sleep handler also
      // clears it, but do it here so the screen flips immediately).
      display({
        status: "idle",
        emoji: "😴",
        RGB: "#000055",
        wardrive_ui: "",
        wardrive_label: "",
        wardrive_status_text: "",
        text: "Saliendo del modo wardriving...",
      });
      return;
    }
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