import ChatFlow from "./core/ChatFlow";
import dotenv from "dotenv";
import { startBatteryStatus } from "./status/battery-status";
import { startWifiStatus } from "./status/wifi-status";
import { startVpnStatus } from "./status/vpn-status";
import { WebAdminServer } from "./device/web-admin-server";
import { registerShutdownHook } from "./device/display";
import { startWifiRadarService, stopWifiRadarService } from "./wifiradar/service";
import { getWardriveService } from "./wardrive/service";
import { startWardriveDisplayMirror } from "./core/chat-flow/wardrive-mode";

dotenv.config();

startBatteryStatus();
startWifiStatus();
startVpnStatus();

// Shared between the physical device's "WiFi Radar" menu screen
// (chat-flow/wifi-radar-mode.ts) and the web WIFIRADAR page — started
// unconditionally (not gated behind WEB_ADMIN_ENABLED) since the physical
// menu should work even with the web admin server off. Restoring the
// AR9271 out of monitor mode has to actually finish before the process
// exits, or a restart leaves it stuck — see display.ts's shutdown hook
// system for why this isn't a plain SIGTERM listener here.
startWifiRadarService();
registerShutdownHook(() => stopWifiRadarService());

// WARDRIVE (thesis/lab handshake capture — wardrive/service.ts). Service
// only: entering the mode is a web-admin action (POST /api/wardrive/enter).
// The physical screen mirror renders the WARDRIVE overlay while active and
// clears it on exit. Its shutdown hook restores the AR9271 to managed mode
// even if the process dies mid-session.
getWardriveService().registerShutdown();
startWardriveDisplayMirror();

// LAN-reachable chat + wifi admin UI — see docs/web-ui.md. On by default
// (matches the physical device's own "just works" setup); set
// WEB_ADMIN_ENABLED=false to turn it off.
if ((process.env.WEB_ADMIN_ENABLED || "true").toLowerCase() !== "false") {
  new WebAdminServer({
    port: parseInt(process.env.WEB_ADMIN_PORT || "8090", 10),
    username: process.env.WEB_ADMIN_USER || "akbal",
    password: process.env.WEB_ADMIN_PASSWORD || "akbal",
  }).start();
}

new ChatFlow({
  enableCamera: process.env.ENABLE_CAMERA === "true",
});
