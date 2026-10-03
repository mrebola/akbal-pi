// Admin-chat tools for the Wardrive (driving capture) section
// (docs/wardrive.md) — Fase 1 read-only. start()/stop()/attackApExternal()
// are Fase 2/3 territory (start in particular needs to default to passive,
// no opportunistic deauth, unless confirmed — see the plan).
import { ToolReturnTag } from "../../type";
import { getDriveWardriveService } from "../../wardrive/service";
import { AdminToolDescriptor } from "./types";

export const wardriveAdminTools: AdminToolDescriptor[] = [
  {
    sectionId: "wardrive",
    title: "Consultando Wardrive…",
    tool: {
      type: "function",
      function: {
        name: "getWardriveDriveStatus",
        description:
          "Get the current status of the driving Wardrive session: whether it's running, GPS fix, distance/duration, current radio channel and recent activity. Use for '¿está corriendo el wardrive?' or '¿cuánto llevamos recorrido?'.",
        parameters: {},
      },
      func: async () => {
        const status = getDriveWardriveService().getStatus();
        if (!status.running) {
          return `${ToolReturnTag.Success}El wardrive de conducción no está corriendo en este momento.`;
        }
        const session = status.session;
        const distanceKm = session ? (session.distanceMeters / 1000).toFixed(1) : "0";
        const durationMin = session ? Math.round(session.durationSec / 60) : 0;
        const recent = status.activity
          .slice(0, 5)
          .map((a) => `- ${a.text}`)
          .join("\n");
        return `${ToolReturnTag.Success}Wardrive corriendo: ${distanceKm}km recorridos en ${durationMin} minuto(s), canal ${status.channel}, interfaz ${status.iface || "ninguna"}.${
          recent ? `\nActividad reciente:\n${recent}` : ""
        }`;
      },
    },
  },
];
