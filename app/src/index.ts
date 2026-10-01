import ChatFlow from "./core/ChatFlow";
import dotenv from "dotenv";
import { startBatteryStatus } from "./status/battery-status";
import { startWifiStatus } from "./status/wifi-status";
import { startVpnStatus } from "./status/vpn-status";
import { WebAdminServer } from "./device/web-admin-server";
import { registerShutdownHook } from "./device/display";
import { startWifiRadarService, stopWifiRadarService } from "./wifiradar/service";
import { getWardriveService } from "./wifi-audit/service";
import { startWardriveDisplayMirror } from "./core/chat-flow/wifi-audit-mode";
import { getDriveWardriveService } from "./wardrive/service";
import { startWardriveDisplayMirror as startDriveMirror } from "./core/chat-flow/wardrive-mode";
import { startAircraftRadarService, stopAircraftRadarService } from "./services/adsb/service";
import { startGnssService, stopGnssService } from "./services/gnss/service";
import { startAutoReconnectWatchdog } from "./utils/wifi";

dotenv.config();

startBatteryStatus();
startWifiStatus();
startVpnStatus();

// Auto-reconnect: if wlan0 drops, try the last-connected SSID again every 5
// minutes, but only while it's actually visible in a scan — see
// utils/wifi.ts's "Always-on auto-reconnect watchdog". Runs for the whole
// process lifetime (unlike the wardrive-scoped home-network watchdog in the
// same file, which only arms during a drive session).
startAutoReconnectWatchdog();

// Shared between the physical device's "WiFi Radar" menu screen
// (chat-flow/wifi-radar-mode.ts) and the web WIFIRADAR page — started
// unconditionally (not gated behind WEB_ADMIN_ENABLED) since the physical
// menu should work even with the web admin server off. Restoring the
// AR9271 out of monitor mode has to actually finish before the process
// exits, or a restart leaves it stuck — see display.ts's shutdown hook
// system for why this isn't a plain SIGTERM listener here.
startWifiRadarService();
registerShutdownHook(() => stopWifiRadarService());

// Aircraft Radar (HackRF One + dump1090, RX-only ADS-B — docs/aircraft-radar.md).
// Unconditional start, same as WIFIRADAR above — but unlike it, no HackRF
// plugged in does NOT auto-fall back to DemoGenerator anymore: it surfaces a
// clear "sin adaptador" state instead (demo only runs if explicitly toggled
// — see AircraftRadarService.handleCaptureFailure in services/adsb/service.ts),
// so the physical menu screen and the web page both still work, honestly,
// without the hardware. ADSB_ENABLED lets it be turned off entirely for
// anyone who doesn't want the extra sweep timer / SQLite file.
if ((process.env.ADSB_ENABLED || "true").toLowerCase() !== "false") {
  startAircraftRadarService();
  registerShutdownHook(() => stopAircraftRadarService());
}

// GNSS satellite metadata (offline-first cache + CelesTrak enrichment,
// docs/gnss.md). Reads the same GPS adapter as the GPS page; GNSS_ENABLED
// lets it be turned off for anyone who doesn't want the extra sweep timer /
// SQLite file, same convention as ADSB_ENABLED above.
if ((process.env.GNSS_ENABLED || "true").toLowerCase() !== "false") {
  startGnssService();
  registerShutdownHook(() => stopGnssService());
}

// WIFI AUDIT (thesis/lab handshake capture — wifi-audit/service.ts). Service
// only: entering the mode is a web-admin action (POST /api/wardrive/enter).
// The physical screen mirror renders the audit overlay while active and
// clears it on exit. Its shutdown hook restores the AR9271 to managed mode
// even if the process dies mid-session.
getWardriveService().registerShutdown();
startWardriveDisplayMirror();

// WARDRIVE (driving capture — wardrive/service.ts, docs/wardrive.md).
// Same service-only shape as Wifi Audit: starting/stopping a drive session
// is a web-admin action (POST /api/wardrive/drive/start|stop) OR a physical
// one (quick menu → Wardrive). The LCD mirror paints the wardrive overlay
// for sessions started from the web too. Its shutdown hook restores the
// AR9271 out of monitor mode even if the process dies mid-session.
getDriveWardriveService().registerShutdown();
startDriveMirror();

// LAN-reachable chat + wifi admin UI — see docs/web-ui.md. On by default
// (matches the physical device's own "just works" setup); set
// WEB_ADMIN_ENABLED=false to turn it off.
let webAdminServer: WebAdminServer | null = null;
if ((process.env.WEB_ADMIN_ENABLED || "true").toLowerCase() !== "false") {
  webAdminServer = new WebAdminServer({
    port: parseInt(process.env.WEB_ADMIN_PORT || "8090", 10),
    username: process.env.WEB_ADMIN_USER || "akbal",
    password: process.env.WEB_ADMIN_PASSWORD || "akbal",
  });
  webAdminServer.start();
}

const chatFlow = new ChatFlow({
  enableCamera: process.env.ENABLE_CAMERA === "true",
});

// Lets a web-triggered "modo agente" switch (POST /api/mode/select) start
// the whisplay-im bridge too, same as the physical device's mode_loading
// flow state — see web-admin-server.ts's setEnsureAgentBridge.
webAdminServer?.setEnsureAgentBridge(() => chatFlow.ensureAgentBridge());
