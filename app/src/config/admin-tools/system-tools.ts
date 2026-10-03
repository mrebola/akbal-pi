// Admin-chat tools for general system/wifi status — read-only. Reuses the
// same utils/wifi.ts helpers the web admin's own /api/wifi/* endpoints call
// (web-admin-server.ts), so the chat never re-implements the nmcli parsing.
// connectToWifi/forgetWifi (Fase 3, `sensitive`) stay out of this module.
import { ToolReturnTag } from "../../type";
import { getWifiStatus, scanWifiNetworksDetailed } from "../../utils/wifi";
import { AdminToolDescriptor } from "./types";

export const systemAdminTools: AdminToolDescriptor[] = [
  {
    sectionId: "settings",
    title: "Consultando estado de Wi-Fi…",
    tool: {
      type: "function",
      function: {
        name: "getWifiConnectionStatus",
        description:
          "Get Akbal's current WiFi connection: connected or not, and which SSID. Use for '¿a qué wifi estoy conectado?'.",
        parameters: {},
      },
      func: async () => {
        const status = await getWifiStatus();
        return status.connected
          ? `${ToolReturnTag.Success}Conectado a la red "${status.ssid}".`
          : `${ToolReturnTag.Success}No hay conexión WiFi activa en este momento.`;
      },
    },
  },
  {
    sectionId: "settings",
    title: "Escaneando redes Wi-Fi cercanas…",
    tool: {
      type: "function",
      function: {
        name: "scanNearbyWifiNetworks",
        description:
          "Scan and list WiFi networks currently visible to Akbal's main wifi radio (ssid, signal, channel, security). Use for '¿qué redes wifi hay cerca?' when asked about normal (not WifiRadar/monitor-mode) scanning.",
        parameters: {},
      },
      func: async () => {
        const networks = await scanWifiNetworksDetailed();
        if (networks.length === 0) {
          return `${ToolReturnTag.Success}No se detectaron redes WiFi en el escaneo.`;
        }
        const lines = networks
          .slice(0, 15)
          .map((n) => `- ${n.ssid || "(sin SSID)"} · canal ${n.channel} · ${n.signalPercent}% (${n.signalDbm}dBm) · ${n.security}${n.active ? " · conectada" : ""}`)
          .join("\n");
        return `${ToolReturnTag.Success}${networks.length} red(es) detectada(s):\n${lines}`;
      },
    },
  },
];
