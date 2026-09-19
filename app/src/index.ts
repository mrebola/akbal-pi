import ChatFlow from "./core/ChatFlow";
import dotenv from "dotenv";
import { startBatteryStatus } from "./status/battery-status";
import { startWifiStatus } from "./status/wifi-status";
import { startVpnStatus } from "./status/vpn-status";
import { WebAdminServer } from "./device/web-admin-server";

dotenv.config();

startBatteryStatus();
startWifiStatus();
startVpnStatus();

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
