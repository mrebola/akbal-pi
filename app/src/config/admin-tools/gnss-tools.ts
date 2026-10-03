// Admin-chat tools for the GPS/GNSS section (docs/gnss.md) — read-only.
import { ToolReturnTag } from "../../type";
import { getGnssSnapshot } from "../../services/gnss/service";
import { AdminToolDescriptor } from "./types";

export const gnssAdminTools: AdminToolDescriptor[] = [
  {
    sectionId: "gps",
    title: "Consultando GPS/GNSS…",
    tool: {
      type: "function",
      function: {
        name: "getGnssStatus",
        description:
          "Get the current GNSS/GPS status: whether a GPS dongle is detected, how many satellites are visible/used, and which constellations (GPS, GLONASS, Galileo, BeiDou). Use for '¿cuántos satélites tengo?' or '¿hay GPS conectado?'.",
        parameters: {},
      },
      func: async () => {
        const snapshot = getGnssSnapshot();
        if (!snapshot.present) {
          return `${ToolReturnTag.Success}No hay un dongle GPS conectado en este momento.`;
        }
        const used = snapshot.satellites.filter((s) => s.used).length;
        const byConstellation = new Map<string, number>();
        for (const sat of snapshot.satellites) {
          byConstellation.set(sat.constellation, (byConstellation.get(sat.constellation) || 0) + 1);
        }
        const breakdown = [...byConstellation.entries()].map(([c, n]) => `${c}:${n}`).join(", ");
        const cacheNote = snapshot.cacheOnly ? " (datos orbitales solo de cache, sin refresh reciente)" : "";
        return `${ToolReturnTag.Success}${snapshot.satellites.length} satélite(s) visible(s), ${used} en uso para el fix${cacheNote}. Por constelación: ${breakdown || "sin datos"}.`;
      },
    },
  },
];
