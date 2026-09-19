import { display } from "../../device/display";
import { getWardriveService } from "../../wardrive/service";
import { WardriveStatus } from "../../wardrive/types";

// Physical-screen companion of the web "Wardriving" tab. NOT a button-driven
// flow state: entering/leaving wardriving is a web-admin action (the radio
// gets held for the whole session), so this module only mirrors the live
// WardriveService status onto the LCD while the mode is active — plus a
// "WARDRIVE" badge and a distinct RGB so it's obvious at a glance the
// device is not running as Akbal right now. The LLM is unloaded by the
// service itself on enter (wardrive/service.ts), so nothing else needed
// here for "quita los modelos de ia de memoria".
//
// The screen shows: big WARDRIVE title, one-line status ("Escaneando" /
// "PMKID <ssid>" / "Deauth <ssid>"), and captured/total handshake counters
// for the current session. Exiting wardriving from the web triggers
// status.mode === "inactive", which clears the overlay automatically —
// there's no physical button interaction to worry about.

let statusListener: ((payload: any) => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const POLL_MS = 2000;

function paint(status: WardriveStatus): void {
  const captured = status.session?.targets.filter((t) => t.status === "captured").length || 0;
  const total = status.session?.targets.length || 0;
  const attacking = status.mode === "attacking";
  const current = status.session?.targets.find((t) => t.bssid === status.session?.currentBssid);
  const statusText =
    status.mode === "scanning"
      ? "Escaneando el aire..."
      : attacking
        ? current
          ? `${current.method === "deauth" ? "Deauth" : "PMKID"}: ${current.ssid || current.bssid}`
          : "Preparando ataque..."
        : status.mode === "ready"
          ? "Listo. Esperando orden."
          : "Iniciando...";
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
    wardrive_label: status.iface ? `WARDRIVE ${status.iface.toUpperCase()}` : "WARDRIVE",
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