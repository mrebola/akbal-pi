// Admin-chat tools for the WIFIRADAR section (docs/wifiradar.md) — Fase 1:
// read-only. Wraps the same service the /wifiradar page and its WebSocket
// already use; never duplicates its state.
import { ToolReturnTag } from "../../type";
import { getWifiRadarSnapshot } from "../../wifiradar/service";
import { AdminToolDescriptor } from "./types";

export const wifiradarAdminTools: AdminToolDescriptor[] = [
  {
    sectionId: "wifiradar",
    title: "Consultando Radar Wi-Fi…",
    tool: {
      type: "function",
      function: {
        name: "getWifiRadarStatus",
        description:
          "Get a snapshot of Akbal's passive WiFi Radar: access points and devices detected nearby, whether it's running in live or demo mode. Use for '¿qué redes wifi hay cerca?' or '¿cuántos dispositivos ve el radar?'.",
        parameters: {},
      },
      func: async () => {
        const snapshot = getWifiRadarSnapshot();
        const demoNote = snapshot.demo ? " (modo demo, datos sintéticos)" : "";
        if (snapshot.accessPoints.length === 0) {
          return `${ToolReturnTag.Success}El Radar Wi-Fi no ha detectado ningún access point todavía${demoNote}.`;
        }
        const lines = snapshot.accessPoints
          .slice(0, 15)
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
