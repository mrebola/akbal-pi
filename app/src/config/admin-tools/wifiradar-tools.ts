// Admin-chat tools for the WIFIRADAR section (docs/wifiradar.md) — Fase 1:
// read-only. Wraps the same service the /wifiradar page and its WebSocket
// already use; never duplicates its state.
import { ToolReturnTag } from "../../type";
import { getWifiRadarSnapshot } from "../../wifiradar/service";
import { AdminToolDescriptor } from "./types";
import { findAccessPoints } from "./ap-search";

export const wifiradarAdminTools: AdminToolDescriptor[] = [
  {
    sectionId: "wifiradar",
    title: "Consultando Radar Wi-Fi…",
    tool: {
      type: "function",
      function: {
        name: "getWifiRadarStatus",
        description:
          "Get a snapshot of Akbal's passive WiFi Radar: access points and devices detected nearby, whether it's running in live or demo mode. Use for '¿qué redes wifi hay cerca?' or '¿cuántos dispositivos ve el radar?'. For a specific network (for example '¿ves akbal_lab?') pass its name in ssid.",
        parameters: {
          type: "object",
          properties: {
            ssid: {
              type: "string",
              description: "Nombre exacto o parcial de una red concreta, por ejemplo akbal_lab. Úsalo cuando pregunten por una red específica; sin él se listan las primeras 15.",
            },
          },
        },
      },
      func: async (params: { ssid?: string } = {}) => {
        const snapshot = getWifiRadarSnapshot();
        const demoNote = snapshot.demo ? " (modo demo, datos sintéticos)" : "";
        if (snapshot.accessPoints.length === 0) {
          return `${ToolReturnTag.Success}El Radar Wi-Fi no ha detectado ningún access point todavía${demoNote}.`;
        }
        const shown = findAccessPoints(snapshot.accessPoints, params?.ssid);
        if (params?.ssid && shown.length === 0) {
          return `${ToolReturnTag.Success}No se encontró ninguna red llamada "${params.ssid}" entre ${snapshot.accessPoints.length} access point(s)${demoNote}.`;
        }
        const lines = shown
          .map(
            (ap) =>
              `- ${ap.ssid || "(sin SSID)"} · ${ap.bssid} · canal ${ap.channel} · ${ap.rssi}dBm · ${ap.security} · ${ap.clients} cliente(s)`,
          )
          .join("\n");
        return `${ToolReturnTag.Success}${snapshot.accessPoints.length} access point(s) y ${snapshot.devices.length} dispositivo(s) detectado(s)${demoNote}:\n${lines}`;
      },
    },
  },
];
