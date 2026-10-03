// Admin-chat tools for the Wifi Audit section (docs/wifi-audit.md) — Fase 1
// is read-only on purpose: this service also owns attackOne/attackMany/
// deauth, which are Fase 3 territory and will need the `sensitive`
// confirmation flow (see admin-tools/types.ts) before they're ever wired
// into the chat. Nothing here can trigger a scan, capture or attack.
import { ToolReturnTag } from "../../type";
import { getWardriveService } from "../../wifi-audit/service";
import { AdminToolDescriptor } from "./types";

export const wifiAuditAdminTools: AdminToolDescriptor[] = [
  {
    sectionId: "wifi-audit",
    title: "Consultando Wifi Audit…",
    tool: {
      type: "function",
      function: {
        name: "getWifiAuditStatus",
        description:
          "Get the current status of the Wifi Audit lab tool: mode, interface in use, current session, targets seen and which BSSIDs are in the authorization allowlist. Use for '¿qué está pasando en wifi audit?' or '¿qué redes tengo autorizadas para el laboratorio?'.",
        parameters: {},
      },
      func: async () => {
        const status = getWardriveService().getStatus();
        if (status.error) {
          return `${ToolReturnTag.Error}Wifi Audit reporta un error: ${status.error}`;
        }
        const sessionNote = status.session ? `Sesión activa (${status.session.id}).` : "Sin sesión activa.";
        const allowlistNote =
          status.allowlist.length > 0
            ? `Allowlist: ${status.allowlist.join(", ")}.`
            : "Allowlist vacía (ninguna red autorizada para ataques de laboratorio).";
        const targetsNote =
          status.targets.length > 0
            ? `${status.targets.length} red(es) vistas en el último scan: ${status.targets
                .slice(0, 10)
                .map((t) => `${t.ssid || "(sin SSID)"} (${t.bssid}${t.inAllowlist ? ", autorizada" : ""})`)
                .join(", ")}.`
            : "Sin redes en el último scan.";
        return `${ToolReturnTag.Success}Modo: ${status.mode}, interfaz: ${status.iface || "ninguna"}. ${sessionNote} ${allowlistNote} ${targetsNote}`;
      },
    },
  },
  {
    sectionId: "crack-station",
    title: "Consultando handshakes capturados…",
    tool: {
      type: "function",
      function: {
        name: "listCapturedHandshakes",
        description:
          "List WiFi handshakes captured so far (lab Wifi Audit + driving Wardrive sessions), including which ones already have a cracked password. Use for '¿qué handshakes tengo?' or '¿ya se descifró la contraseña de X red?'.",
        parameters: {},
      },
      func: async () => {
        const { items } = getWardriveService().handshakeInventory();
        if (items.length === 0) {
          return `${ToolReturnTag.Success}No hay handshakes capturados todavía.`;
        }
        const lines = items
          .slice(0, 15)
          .map(
            (h) =>
              `- ${h.ssid || "(sin SSID)"} · ${h.bssid} · ${h.hasHandshake ? "con handshake" : "sin handshake"}${
                h.password ? ` · contraseña: ${h.password}` : h.verified ? " · verificado, sin crackear" : ""
              } · origen: ${h.source}`,
          )
          .join("\n");
        return `${ToolReturnTag.Success}${items.length} handshake(s) registrado(s):\n${lines}`;
      },
    },
  },
];
