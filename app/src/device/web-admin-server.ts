import fs from "fs";
import { hasValidSessionCookie } from "./admin-session-cookie";
import path from "path";
import http from "http";
import crypto from "crypto";
import { Readable } from "stream";
import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";
import serve from "koa-static";
import axios from "axios";
import { WebSocketServer, WebSocket } from "ws";
import {
  getWifiRadarSnapshot,
  setWifiRadarMode,
  getWifiRadarMode,
  getWifiRadarRequestedMode,
  getWifiRadarAdapters,
  setWifiRadarPreferredAdapter,
  holdWifiRadar,
  releaseWifiRadar,
} from "../wifiradar/service";
import { detectMonitorAdapter } from "../wifiradar/adapter";

// The web holds the WiFi Radar only while someone asks for it: every request
// on the radar API renews a lease, and 60 s without one lets it go (the radar
// is off while nobody is looking). Open radar websockets hold it until closed.
const WEB_RADAR_IDLE_MS = 60_000;
let webRadarIdleTimer: ReturnType<typeof setTimeout> | null = null;
function touchWebRadar(): void {
  holdWifiRadar("web");
  if (webRadarIdleTimer) clearTimeout(webRadarIdleTimer);
  webRadarIdleTimer = setTimeout(() => {
    webRadarIdleTimer = null;
    releaseWifiRadar("web");
  }, WEB_RADAR_IDLE_MS);
}
import { getWardriveService } from "../wifi-audit/service";
import { getDriveWardriveService } from "../wardrive/service";
import { driveDb, DRIVE_SESSIONS_ROOT } from "../wardrive/drive-db";
import {
  getAircraftRadarSnapshot,
  getAircraftByIcao,
  setAircraftRadarMode,
  getAircraftRadarMode,
  getAircraftRadarRequestedMode,
} from "../services/adsb/service";
import { getRecentHistory, getHistoryForIcao, getZoneRecent, getSightingsForIcao } from "../services/adsb/history";
import { SIGHTING_WINDOW_MS } from "../services/adsb/zone";
import {
  getCurrentModel,
  isModelLoaded,
  listOllamaModelsWithSize,
  ollamaEndpoint,
  switchModel,
  unloadModel,
  startPullModel,
  getPullState,
  cancelPull,
  clearPullState,
  deleteOllamaModel,
  WEB_ADMIN_DEFAULT_MODEL,
} from "../cloud-api/local/ollama-llm";
import { runAdminChatToolLoop, AdminChatMessage } from "../cloud-api/local/admin-chat-tool-loop";
import { llmFuncMap } from "../config/llm-tools";
import { adminTools, adminFuncMap, adminToolMeta } from "../config/admin-tools/registry";
import { linkForSection, AdminSectionId } from "../config/admin-tools/ui-links";
import { getBasePersonaPrompt } from "../config/llm-config";
import { WEB_CHAT_TOOL_RULE } from "../config/web-chat-rules";
import { wantsVoiceReply } from "../voice/voice-intent";
import { toSpeechChunks } from "../voice/speech-chunks";
import { saveClips } from "../voice/piper-clips";
import { selectToolsForMessage } from "../config/admin-tools/route-tools";
import { chatStore, registerChatHistoryRoutes } from "./chat-history-routes";
import { registerChatCommandRoutes } from "./chat-commands-routes";
import { registerAkbalRoutes } from "./akbal-routes";
import { trimToWindow } from "../chat-history/context";
import { fallbackTitle } from "../chat-history/title";
import { generateTitle, generateTitleFromQuestion, getContextWindow } from "../chat-history/ollama";
import type { StoredChat } from "../chat-history/types";
import { firstQuestion, needsAutoTitle, needsTitleBeforeReply, settleExchange } from "../chat-history/settle";
import { applyDecision, abandonWebClaim } from "../memory/model-memory";
import { ollamaDeps } from "../memory/ollama-deps";
import { memoryArbiter, webIdle, cancelHooks } from "../memory/shared";
import { isWebChatModeOn, setWebChatMode } from "../core/chat-flow/web-chat-state";
import { enableRAG } from "../cloud-api/knowledge";
import { getSystemPromptWithKnowledge } from "../core/Knowledge";
import { listSoulEditableFiles, writeSoulEditableFile, triggerKnowledgeReindex } from "../config/soul-files";
import { isAgentMode, setDeviceMode } from "../config/device-mode";
import {
  AudioOutputTarget,
  getAudioOutputTarget,
  setAudioOutputTarget,
  getBluetoothMac,
  bluetoothTarget,
} from "../config/audio-output";
import {
  listPairedSpeakers,
  connectSpeaker,
  scanForNewSpeakers,
  pairSpeaker,
  removeSpeaker,
  isValidMac,
} from "./bluetooth-audio";
import { getCurrentLogPercent, setVolumeByAmixer } from "../utils/volume";
import { getBatteryReading } from "../status/battery-status";
import { getSystemStats, getLocalIp } from "../utils/system-stats";
import {
  listBackups,
  createBackup,
  restoreBackup,
  deleteBackup,
  resolveBackupPath,
} from "../utils/backup";
import {
  getStorageRoots,
  storageList,
  storageResolveFile,
  storageDelete,
  storageMkdir,
  storageUploadTarget,
} from "../utils/storage";
import { jukebox } from "./music-jukebox";
import { getApStatus, getApQrCodes, enableAp, disableAp } from "../utils/access-point";
import { persistEnvVar } from "../utils/env-file";
import {
  connectToWifi,
  forgetWifi,
  getSavedWifiPassword,
  getWifiStatus,
  scanWifiNetworks,
  scanWifiNetworksDetailed,
} from "../utils/wifi";
import {
  ejectVolume,
  ensureMounted,
  findVolume,
  listFiles,
  listUsbDevices,
  listUsbVolumes,
  listUsbWifiAdapters,
  resolveFilePath,
} from "../utils/usb";
import { getGpsStatus, geocodePoint } from "../utils/gps";
import { getGnssSnapshot, getGnssHistory } from "../services/gnss/service";
import { setPlatformMode, getPlatformMode } from "../utils/platform-mode";
import { doomSession, resolveDoomScreenUrl } from "../core/chat-flow/doom-mode";
import { controlQrFor } from "../doom/control-qr";
import { attachDoomSocket } from "./doom-routes";

const SESSION_COOKIE = "akbal_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — a LAN admin
// page for a single household device, not worth re-logging-in constantly for.
// Paths reachable with no session at all — just enough to render and submit
// the login form itself.
// The DOOM page is public: a phone that scans the QR has no admin session.
// Its control socket (/ws/doom) is also public; the control token is checked
// on "claim" in doom-routes.ts, not here.
const PUBLIC_PATHS = new Set(["/login", "/login.html", "/api/login", "/doom", "/doom.js", "/doom.css", "/styles.css", "/topbar.js", "/doom-manifest.json"]);
const DOOM_WS_PATH = "/ws/doom";
// Tailscale/AP/LAN can change while the admin runs; the cached screen URL
// follows them without any lookup on the upgrade path.
const DOOM_URL_REFRESH_MS = 60_000;
// WIFIRADAR broadcasts a snapshot to every connected client on this cadence
// — 2-4Hz per the spec, not per-packet, which is most of what keeps this
// cheap: the aggregator can ingest hundreds of frames/sec while the network
// only ever sees ~3 JSON messages/sec regardless.
const WIFIRADAR_BROADCAST_MS = 300;

// Small local admin UI, reachable from any device on the LAN — a chat page
// for the local Ollama models (like a mini OpenWebUI) and a wifi settings
// page (scan/connect/forget, with a real password field — the physical
// on-screen menu can't do that, see chat-flow/wifi-connect-mode.ts). Same Koa/
// koa-static stack as WebDisplayServer (device/web-display.ts), which this
// intentionally doesn't touch or replace — that one mirrors the device's
// own screen for dev without hardware; this one is a separate, always-on
// admin surface. See docs/web-ui.md.
export class WebAdminServer {
  private app: Koa;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private doomWss: WebSocketServer | null = null;
  // Last resolved DOOM screen URL (Tailscale, AP or LAN), refreshed by a timer
  // in start(). attachDoomSocket reads it synchronously.
  private doomUrl = "";
  private doomUrlTimer: ReturnType<typeof setInterval> | null = null;
  private port: number;
  private username: string;
  private password: string;
  // Bare random tokens instead of Koa's signed-cookie helper — same
  // security property (unguessable, 192 bits) but readable from a plain
  // Set both here and in the raw WebSocket upgrade handler below, which
  // never goes through Koa's request/response cycle so ctx.cookies isn't
  // available there.
  private validSessions = new Set<string>();
  // Wired from index.ts once the ChatFlow instance exists (this server is
  // constructed first) — switching to "modo agente" from the web needs to
  // actually start the whisplay-im bridge, the same way the physical
  // device's mode_loading flow state does (see chat-flow/states.ts), not
  // just flip the DEVICE_MODE flag.
  private ensureAgentBridge: (() => void) | null = null;

  constructor(options: { port: number; username: string; password: string }) {
    this.port = options.port;
    this.username = options.username;
    this.password = options.password;
    // WifiRadarService itself is a shared singleton (see wifiradar/service.ts)
    // started/stopped from index.ts, independent of whether this admin
    // server is even enabled — the physical device's own "WiFi Radar" menu
    // screen reads from the same running capture. This class only reads
    // snapshots from it (getWifiRadarSnapshot), never owns its lifecycle.
    this.app = new Koa();
    this.app.use(this.sessionAuth());
    this.app.use(bodyParser());

    const router = new Router();
    this.registerRoutes(router);
    this.app.use(router.routes());
    this.app.use(router.allowedMethods());

    const publicRoot = path.resolve(__dirname, "../..", "web", "admin");
    this.app.use(serve(publicRoot));
  }

  private sessionAuth() {
    return async (ctx: Koa.Context, next: Koa.Next) => {
      // /avatar/* is also public — the login page shows Akbal's idle GIF
      // before there's any session to check. i18n.js + i18n/*.json are
      // public too: the login page's language selector needs them before
      // there's any session, and they're just UI strings, nothing sensitive.
      if (
        PUBLIC_PATHS.has(ctx.path) ||
        ctx.path.startsWith("/avatar/") ||
        ctx.path === "/i18n.js" ||
        ctx.path.startsWith("/i18n/") ||
        // The tab icon is requested by the login page too, before any session.
        ctx.path === "/favicon.svg"
      ) {
        await next();
        return;
      }
      const token = ctx.cookies.get(SESSION_COOKIE);
      if (token && this.validSessions.has(token)) {
        await next();
        return;
      }
      if (ctx.path.startsWith("/api/")) {
        ctx.status = 401;
        ctx.body = { error: "No autenticado" };
        return;
      }
      ctx.status = 302;
      ctx.redirect("/login");
    };
  }

  // Same token check as sessionAuth(), for the raw upgrade request behind
  // the WebSocket server (see start()) — there is no Koa ctx there.
  private isValidSessionCookie(cookieHeader: string | undefined): boolean {
    return hasValidSessionCookie(cookieHeader, SESSION_COOKIE, this.validSessions);
  }

  private registerRoutes(router: Router): void {
    router.get("/login", (ctx) => {
      ctx.set("Cache-Control", "no-store");
      ctx.type = "text/html";
      ctx.body = fs.createReadStream(path.resolve(__dirname, "../..", "web", "admin", "login.html"));
    });

    // Public (see PUBLIC_PATHS). Answers 404 until doom.html exists (Task 9).
    router.get("/doom", (ctx) => {
      const file = path.resolve(__dirname, "../..", "web", "admin", "doom.html");
      if (!fs.existsSync(file)) {
        ctx.status = 404;
        return;
      }
      ctx.set("Cache-Control", "no-store");
      ctx.type = "text/html";
      ctx.body = fs.createReadStream(file);
    });

    router.post("/api/login", (ctx) => {
      const { username: u, password: p } = (ctx.request.body as any) || {};
      if (u === this.username && p === this.password) {
        const token = crypto.randomBytes(24).toString("hex");
        this.validSessions.add(token);
        ctx.cookies.set(SESSION_COOKIE, token, {
          httpOnly: true,
          sameSite: "lax",
          maxAge: SESSION_MAX_AGE_MS,
        });
        ctx.body = { ok: true };
      } else {
        ctx.status = 401;
        ctx.body = { ok: false, error: "Usuario o contraseña incorrectos" };
      }
    });

    router.post("/api/logout", (ctx) => {
      const token = ctx.cookies.get(SESSION_COOKIE);
      if (token) this.validSessions.delete(token);
      ctx.cookies.set(SESSION_COOKIE, "", { maxAge: 0 });
      ctx.body = { ok: true };
    });

    router.get("/", (ctx) => {
      ctx.set("Cache-Control", "no-store");
      ctx.type = "text/html";
      ctx.body = fs.createReadStream(path.resolve(__dirname, "../..", "web", "admin", "index.html"));
    });

    // Same two GIFs the physical screen animates between (standing = idle,
    // talking = answering) — see docs/display-ui.md. Served from
    // python/img/ directly instead of duplicating the files under web/admin/.
    router.get("/avatar/:name", (ctx) => {
      const name = ctx.params.name;
      if (name !== "standing.gif" && name !== "talking.gif") {
        ctx.status = 404;
        return;
      }
      const filePath = path.resolve(__dirname, "../..", "python", "img", name);
      if (!fs.existsSync(filePath)) {
        ctx.status = 404;
        return;
      }
      ctx.set("Cache-Control", "public, max-age=86400");
      ctx.type = "image/gif";
      ctx.body = fs.createReadStream(filePath);
    });

    // WIFIRADAR — fullscreen Three.js WiFi visualization. Its own page
    // (not a tab in index.html's chat/wifi/usb layout — a WebGL scene
    // deserves the whole viewport) backed by the WifiRadarService created
    // above; live data streams over /wifiradar/ws (see start()), this route
    // just serves the page shell and an initial snapshot for first paint
    // before the socket connects.
    router.get("/wifiradar", (ctx) => {
      ctx.set("Cache-Control", "no-store");
      ctx.type = "text/html";
      ctx.body = fs.createReadStream(path.resolve(__dirname, "../..", "web", "admin", "wifiradar.html"));
    });

    // Aircraft Radar — HackRF One + dump1090 ADS-B (docs/aircraft-radar.md).
    // Own page like /wifiradar; live data streams over /aircraft-radar/ws
    // (see start()), this route just serves the page shell.
    router.get("/aircraft-radar", (ctx) => {
      ctx.set("Cache-Control", "no-store");
      ctx.type = "text/html";
      ctx.body = fs.createReadStream(path.resolve(__dirname, "../..", "web", "admin", "aircraft-radar.html"));
    });

    // GPS — fullscreen world map with the dongle's live position (docs/gps.md).
    // Own page like /wifiradar (a map deserves the whole viewport); position
    // and satellite data come from /api/gps/status (polled by gps.js).
    router.get("/gps", (ctx) => {
      ctx.set("Cache-Control", "no-store");
      ctx.type = "text/html";
      ctx.body = fs.createReadStream(path.resolve(__dirname, "../..", "web", "admin", "gps.html"));
    });

    // WARDRIVE — fullscreen driving-capture map (docs/wardrive.md).
    // Own page like /gps (same Leaflet engine + HUD overlays); live data
    // comes from /api/wardrive/drive/* (polled by wardrive.js at 1Hz, aggregated server-side).
    router.get("/wardrive", (ctx) => {
      ctx.set("Cache-Control", "no-store");
      ctx.type = "text/html";
      ctx.body = fs.createReadStream(path.resolve(__dirname, "../..", "web", "admin", "wardrive.html"));
    });

    // CRACK STATION — persistent handshake inventory + crack controls
    // (dictionary rockyou + mask brute force). Own page like /wardrive: it
    // works on handshakes from BOTH Wifi Audit and Wardrive (merged by
    // handshakeInventory() in wifi-audit/service.ts), so it doesn't belong
    // under just one of the two anymore. Live data comes from the existing
    // /api/wardrive/handshakes, /mask/* and /dict/* endpoints below.
    router.get("/crack-station", (ctx) => {
      ctx.set("Cache-Control", "no-store");
      ctx.type = "text/html";
      ctx.body = fs.createReadStream(path.resolve(__dirname, "../..", "web", "admin", "crack-station.html"));
    });

    // AKBAL VISION — local face detection/tracking HUD (camera → MediaPipe →
    // tracker → Three.js HUD). Self-contained static frontend under
    // web/admin/akbal-vision/; behind the login like every other section.
    router.get("/akbal-vision", (ctx) => {
      ctx.set("Cache-Control", "no-store");
      ctx.type = "text/html";
      ctx.body = fs.createReadStream(path.resolve(__dirname, "../..", "web", "admin", "akbal-vision", "index.html"));
    });

    // ACERCA DE — static page: Cypher404: El Manifiesto (the book Akbal is
    // named after, see README.md) + why this project exists. No API calls,
    // same mirror of the physical device's "Acerca de" quick-menu item
    // (chat-flow/about-mode.ts).
    router.get("/about", (ctx) => {
      ctx.set("Cache-Control", "no-store");
      ctx.type = "text/html";
      ctx.body = fs.createReadStream(path.resolve(__dirname, "../..", "web", "admin", "about.html"));
    });

    // Behind the admin session (sessionAuth answers 401 for /api/ paths). The
    // QR is the control link for the desktop: same token as the phone's.
    router.get("/api/doom/control-qr", async (ctx) => {
      const result = await controlQrFor({ token: doomSession.controlToken(), baseUrl: this.doomUrl });
      ctx.status = result.status;
      ctx.body = result.body;
    });

    router.get("/api/gps/status", async (ctx) => {
      ctx.body = await getGpsStatus();
    });

    // GNSS satellite metadata (offline-first cache + CelesTrak enrichment,
    // docs/gnss.md). Additive to /api/gps/status: gps.js keeps working
    // untouched, and gnss.js/gps.js can layer this in for satellite names
    // and orbital freshness without changing the position/fix payload.
    router.get("/api/gnss/status", (ctx) => {
      ctx.body = getGnssSnapshot();
    });

    router.get("/api/gnss/history", (ctx) => {
      const minutes = parseInt(String(ctx.query.minutes || "60"), 10) || 60;
      ctx.body = getGnssHistory(Date.now() - minutes * 60_000);
    });

    // Platform-wide source mode: LIVE (real dongles feed radar/wardrive/gps)
    // or DEMO (synthetic data everywhere, dongles released — never storage).
    // One switch drives all three pages.
    router.get("/api/platform/mode", (ctx) => {
      ctx.body = { mode: getPlatformMode() };
    });

    router.post("/api/platform/mode", async (ctx) => {
      const { mode } = (ctx.request.body as any) || {};
      if (mode !== "demo" && mode !== "live") {
        ctx.status = 400;
        ctx.body = { ok: false, error: "mode debe ser 'demo' o 'live'" };
        return;
      }
      ctx.body = await setPlatformMode(mode);
    });

    router.get("/api/wifiradar/snapshot", (ctx) => {
      touchWebRadar();
      const revealFullMac = ctx.query.fullMac === "1";
      ctx.body = getWifiRadarSnapshot(revealFullMac);
    });

    // Dongle selection for WiFi Radar — same picker pattern as Wifi Audit's
    // and wardrive's driving mode.
    router.get("/api/wifiradar/adapters", async (ctx) => {
      ctx.body = await getWifiRadarAdapters();
    });

    router.post("/api/wifiradar/adapter", async (ctx) => {
      const { iface } = (ctx.request.body as any) || {};
      ctx.body = await setWifiRadarPreferredAdapter(
        iface == null || String(iface).trim() === "" ? null : String(iface),
      );
    });

    router.get("/api/status", async (ctx) => {
      const [wifi, system, modelLoaded] = await Promise.all([
        getWifiStatus(),
        getSystemStats(),
        isModelLoaded(),
      ]);
      ctx.body = {
        model: getCurrentModel(),
        // The Chat tab's model <select> defaults to this instead of
        // `model` above (voice's resident model) — see WEB_ADMIN_DEFAULT_MODEL
        // in cloud-api/local/ollama-llm.ts for why they're intentionally
        // different.
        webDefaultModel: WEB_ADMIN_DEFAULT_MODEL,
        modelLoaded,
        deviceMode: isAgentMode() ? "agent" : "local",
        audioOutput: getAudioOutputTarget(),
        wifi,
        battery: getBatteryReading(),
        system,
        ip: getLocalIp(),
      };
    });

    // Compact GPS summary for header indicators (full payload: /api/gps/status).
    router.get("/api/gps/summary", async (ctx) => {
      const gps = await getGpsStatus();
      ctx.body = {
        present: gps.present,
        hasFix: gps.hasFix,
        satellitesUsed: gps.satellitesUsed,
        satellitesInView: gps.satellitesInView,
        satellitesNeeded: gps.satellitesNeeded,
        error: gps.error,
      };
    });

    // "Modo agente" (OpenClaw via whisplay-im) vs "modo local" (Ollama) —
    // same switch as the physical device's quick-menu (chat-flow/
    // mode-select-mode.ts, docs/agent-mode.md), reachable from the web too.
    router.post("/api/mode/select", async (ctx) => {
      const mode = (ctx.request.body as any)?.mode;
      if (mode !== "local" && mode !== "agent") {
        ctx.status = 400;
        ctx.body = { ok: false, error: "mode debe ser 'local' o 'agent'" };
        return;
      }
      setDeviceMode(mode);
      if (mode === "agent") this.ensureAgentBridge?.();
      ctx.body = { ok: true, mode };
    });

    // Speaker options: HAT (onboard Whisplay speaker, default) + one entry per
    // paired Bluetooth speaker, discovered live. See config/audio-output.ts,
    // device/bluetooth-audio.ts and device/audio.ts.
    router.get("/api/audio-output/options", async (ctx) => {
      const active = getAudioOutputTarget();
      let speakers: { mac: string; name: string; connected: boolean }[] = [];
      try {
        speakers = await listPairedSpeakers();
      } catch {
        speakers = [];
      }
      const options = [
        { key: "hat", label: "Bocina de la Pi", connected: true },
        ...speakers.map((sp) => ({
          key: bluetoothTarget(sp.mac),
          label: sp.name,
          connected: sp.connected,
        })),
      ];
      ctx.body = { active, options };
    });

    router.post("/api/audio-output/select", async (ctx) => {
      const target = (ctx.request.body as any)?.target;
      if (typeof target !== "string" || !target) {
        ctx.status = 400;
        ctx.body = { error: "target requerido" };
        return;
      }
      // A specific Bluetooth speaker must be connected before we route to it
      // (single-A2DP radio → this also disconnects any other speaker).
      const mac = target.startsWith("bt:") ? target.slice(3) : null;
      if (mac) {
        const res = await connectSpeaker(mac);
        if (!res.ok) {
          ctx.status = 502;
          ctx.body = { ok: false, error: res.error || "no se pudo conectar la bocina" };
          return;
        }
      }
      setAudioOutputTarget(target as AudioOutputTarget);
      ctx.body = { ok: true, audioOutput: getAudioOutputTarget() };
    });

    // Output volume — same amixer path + 10-point step as the physical
    // device's quick-menu (chat-flow/volume-adjust-mode.ts) and "sube/baja
    // el volumen" voice command (chat-flow/voice-commands.ts). Used by the
    // OST player's volume buttons so switching speakers doesn't require
    // leaving the web page.
    router.get("/api/volume", async (ctx) => {
      ctx.body = { percent: Math.round(getCurrentLogPercent()) };
    });

    router.post("/api/volume", async (ctx) => {
      const { percent, delta } = (ctx.request.body as any) || {};
      let next: number;
      if (typeof percent === "number") {
        next = percent;
      } else if (typeof delta === "number") {
        next = getCurrentLogPercent() + delta;
      } else {
        ctx.status = 400;
        ctx.body = { ok: false, error: "percent o delta requerido" };
        return;
      }
      next = Math.min(100, Math.max(0, Math.round(next)));
      setVolumeByAmixer(next);
      ctx.body = { ok: true, percent: next };
    });

    // Discover nearby, not-yet-paired Bluetooth speakers. Blocks for the scan
    // window, so the frontend shows a spinner.
    router.get("/api/bluetooth/scan", async (ctx) => {
      try {
        ctx.body = { speakers: await scanForNewSpeakers() };
      } catch (err: any) {
        ctx.status = 500;
        ctx.body = { error: err?.message || String(err) };
      }
    });

    // Pair + trust + connect a discovered speaker, then make it the active
    // output. Anyone with admin access can add their own speaker this way.
    router.post("/api/bluetooth/pair", async (ctx) => {
      const mac = (ctx.request.body as any)?.mac;
      if (typeof mac !== "string" || !isValidMac(mac)) {
        ctx.status = 400;
        ctx.body = { error: "mac inválida" };
        return;
      }
      const res = await pairSpeaker(mac);
      if (!res.ok) {
        ctx.status = 502;
        ctx.body = { ok: false, error: res.error || "no se pudo emparejar" };
        return;
      }
      setAudioOutputTarget(bluetoothTarget(mac));
      ctx.body = { ok: true, audioOutput: getAudioOutputTarget() };
    });

    // Unpair/forget a speaker so it leaves the picker and can be paired fresh.
    router.post("/api/bluetooth/remove", async (ctx) => {
      const mac = (ctx.request.body as any)?.mac;
      if (typeof mac !== "string" || !isValidMac(mac)) {
        ctx.status = 400;
        ctx.body = { error: "mac inválida" };
        return;
      }
      const res = await removeSpeaker(mac);
      if (!res.ok) {
        ctx.status = 502;
        ctx.body = { ok: false, error: res.error || "no se pudo eliminar" };
        return;
      }
      // If we just removed the active speaker, fall back to the HAT so the
      // assistant stays audible.
      if (getBluetoothMac()?.toUpperCase() === mac.toUpperCase()) {
        setAudioOutputTarget("hat");
      }
      ctx.body = { ok: true, audioOutput: getAudioOutputTarget() };
    });

    // ---- Config backups (stored on the Pi's microSD, never in git) ----
    router.get("/api/backup/list", async (ctx) => {
      try {
        ctx.body = { backups: listBackups() };
      } catch (err: any) {
        ctx.status = 500;
        ctx.body = { error: err?.message || String(err) };
      }
    });

    router.post("/api/backup/create", async (ctx) => {
      try {
        const entry = await createBackup();
        ctx.body = { ok: true, backup: entry };
      } catch (err: any) {
        ctx.status = 500;
        ctx.body = { ok: false, error: err?.message || String(err) };
      }
    });

    router.get("/api/backup/download", async (ctx) => {
      const name = String(ctx.query.name || "");
      try {
        const full = resolveBackupPath(name);
        if (!fs.existsSync(full)) {
          ctx.status = 404;
          ctx.body = { error: "no existe" };
          return;
        }
        ctx.set("Content-Type", "application/gzip");
        ctx.set("Content-Disposition", `attachment; filename="${name}"`);
        ctx.body = fs.createReadStream(full);
      } catch (err: any) {
        ctx.status = 400;
        ctx.body = { error: err?.message || String(err) };
      }
    });

    router.post("/api/backup/restore", async (ctx) => {
      const name = (ctx.request.body as any)?.name;
      if (typeof name !== "string" || !name) {
        ctx.status = 400;
        ctx.body = { error: "nombre requerido" };
        return;
      }
      try {
        const res = await restoreBackup(name);
        ctx.body = {
          ok: true,
          safetyBackup: res.safetyBackup,
          note: "Reinicia el servicio para aplicar la configuración restaurada.",
        };
      } catch (err: any) {
        ctx.status = 500;
        ctx.body = { ok: false, error: err?.message || String(err) };
      }
    });

    router.post("/api/backup/delete", async (ctx) => {
      const name = (ctx.request.body as any)?.name;
      if (typeof name !== "string" || !name) {
        ctx.status = 400;
        ctx.body = { error: "nombre requerido" };
        return;
      }
      try {
        deleteBackup(name);
        ctx.body = { ok: true };
      } catch (err: any) {
        ctx.status = 400;
        ctx.body = { ok: false, error: err?.message || String(err) };
      }
    });

    // ---- Music jukebox (Cypher OST) ----
    router.get("/api/music/tracks", async (ctx) => {
      ctx.body = { tracks: jukebox.getTracks(), status: jukebox.status() };
    });
    router.get("/api/music/status", async (ctx) => {
      ctx.body = jukebox.status();
    });
    router.post("/api/music/play", async (ctx) => {
      const index = Number((ctx.request.body as any)?.index);
      const status = await jukebox.play(Number.isFinite(index) ? index : 0);
      ctx.body = status;
    });
    router.post("/api/music/pause", async (ctx) => {
      ctx.body = jukebox.pause();
    });
    router.post("/api/music/resume", async (ctx) => {
      ctx.body = jukebox.resume();
    });
    router.post("/api/music/playpause", async (ctx) => {
      ctx.body = await jukebox.playPause();
    });
    router.post("/api/music/stop", async (ctx) => {
      ctx.body = jukebox.stop();
    });
    router.post("/api/music/seek", async (ctx) => {
      const ms = Number((ctx.request.body as any)?.ms);
      ctx.body = await jukebox.seek(Number.isFinite(ms) ? ms : 0);
    });
    router.post("/api/music/next", async (ctx) => {
      ctx.body = await jukebox.next();
    });
    router.post("/api/music/prev", async (ctx) => {
      ctx.body = await jukebox.prev();
    });
    // Lyrics for one track (by playlist index): plain text from the sibling
    // .txt in the library dir. {ok:false} when the track has no lyrics.
    router.get("/api/music/lyrics", async (ctx) => {
      const index = Number(ctx.query.index);
      const lyrics = jukebox.getLyrics(Number.isFinite(index) ? index : -1);
      ctx.body = { ok: lyrics !== null, index, lyrics };
    });

    // ---- Unified file manager (internal storage + USB) ----
    router.get("/api/storage/roots", async (ctx) => {
      ctx.body = { roots: await getStorageRoots() };
    });
    router.get("/api/storage/list", async (ctx) => {
      const root = String(ctx.query.root || "internal");
      const rel = String(ctx.query.path || "");
      const res = await storageList(root, rel);
      ctx.status = res.ok ? 200 : 400;
      ctx.body = res;
    });
    router.get("/api/storage/download", async (ctx) => {
      const root = String(ctx.query.root || "");
      const rel = String(ctx.query.path || "");
      const full = await storageResolveFile(root, rel);
      if (!full) {
        ctx.status = 400;
        ctx.body = { error: "ruta inválida" };
        return;
      }
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        ctx.status = 404;
        ctx.body = { error: "no existe" };
        return;
      }
      if (!stat.isFile()) {
        ctx.status = 400;
        ctx.body = { error: "no es un archivo" };
        return;
      }
      ctx.set("Content-Length", String(stat.size));
      // inline=1 serves viewable types with a real content-type (no attachment)
      // so the web file viewer can preview images/text/PDF in place.
      const inline = String(ctx.query.inline || "") === "1";
      const ext = path.extname(full).toLowerCase();
      const VIEW_TYPES: Record<string, string> = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
        ".svg": "image/svg+xml", ".pdf": "application/pdf",
        ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
        ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8",
        ".csv": "text/plain; charset=utf-8", ".ini": "text/plain; charset=utf-8",
        ".conf": "text/plain; charset=utf-8", ".sh": "text/plain; charset=utf-8",
        ".xml": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8",
        ".yaml": "text/plain; charset=utf-8",
      };
      if (inline && VIEW_TYPES[ext]) {
        ctx.type = VIEW_TYPES[ext];
        ctx.set("Content-Disposition", `inline; filename="${path.basename(full)}"`);
      } else {
        ctx.type = "application/octet-stream";
        ctx.set("Content-Disposition", `attachment; filename="${path.basename(full)}"`);
      }
      ctx.body = fs.createReadStream(full);
    });
    router.post("/api/storage/delete", async (ctx) => {
      const { root, path: rel, password } = (ctx.request.body as any) || {};
      // Deleting requires re-entering the web password (an extra gate beyond
      // the session), on top of the confirmation the UI asks for.
      if (password !== this.password) {
        ctx.status = 403;
        ctx.body = { ok: false, error: "contraseña incorrecta" };
        return;
      }
      const res = await storageDelete(String(root || ""), String(rel || ""));
      // Jukebox caches its track list (see Jukebox.getTracks() in
      // music-jukebox.ts) — a delete through the shared file manager must
      // invalidate it or the removed track keeps "playing" from the cache.
      if (res.ok && root === "music") jukebox.rescan();
      ctx.status = res.ok ? 200 : 400;
      ctx.body = res;
    });
    router.post("/api/storage/mkdir", async (ctx) => {
      const { root, path: rel, name } = (ctx.request.body as any) || {};
      const res = await storageMkdir(String(root || ""), String(rel || ""), String(name || ""));
      ctx.status = res.ok ? 200 : 400;
      ctx.body = res;
    });
    // Raw-body upload: PUT the file bytes directly (avoids a multipart parser).
    router.put("/api/storage/upload", async (ctx) => {
      const root = String(ctx.query.root || "");
      const rel = String(ctx.query.path || "");
      const filename = String(ctx.query.name || "");
      const target = await storageUploadTarget(root, rel, filename);
      if (!target) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "destino inválido" };
        return;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(target);
          ctx.req.on("error", reject);
          out.on("error", reject);
          out.on("finish", () => resolve());
          ctx.req.pipe(out);
        });
        if (root === "music") jukebox.rescan();
        ctx.body = { ok: true };
      } catch (err: any) {
        ctx.status = 500;
        ctx.body = { ok: false, error: err?.message || String(err) };
      }
    });

    // ---- Direct WiFi (AP / hotspot) mode ----
    router.get("/api/ap/status", async (ctx) => {
      const status = await getApStatus();
      const qr = await getApQrCodes(status);
      ctx.body = { ...status, ...qr };
    });
    router.post("/api/ap/enable", async (ctx) => {
      try {
        const status = await enableAp();
        const qr = await getApQrCodes(status);
        ctx.body = { ok: true, ...status, ...qr };
      } catch (err: any) {
        ctx.status = 500;
        ctx.body = { ok: false, error: err?.message || String(err) };
      }
    });
    router.post("/api/ap/disable", async (ctx) => {
      try {
        const status = await disableAp();
        ctx.body = { ok: true, ...status };
      } catch (err: any) {
        ctx.status = 500;
        ctx.body = { ok: false, error: err?.message || String(err) };
      }
    });

    // Changing the web admin password persists it to the device's own .env
    // (plain text, readable over SSH — see AGENTS.md's anti-secrets
    // checklist: this file is never committed) so it's recoverable if
    // forgotten, the same way AP_PASSWORD already works.
    router.post("/api/settings/password", async (ctx) => {
      const { currentPassword, newPassword } = (ctx.request.body as any) || {};
      if (currentPassword !== this.password) {
        // 403, not 401 — apiFetch() on the client treats 401 as "session
        // expired, go to /login", which would be wrong here (the session
        // is fine, just the typed password).
        ctx.status = 403;
        ctx.body = { ok: false, error: "La contraseña actual no coincide" };
        return;
      }
      if (typeof newPassword !== "string" || newPassword.length < 4) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "La contraseña nueva debe tener al menos 4 caracteres" };
        return;
      }
      this.password = newPassword;
      process.env.WEB_ADMIN_PASSWORD = newPassword;
      persistEnvVar("WEB_ADMIN_PASSWORD", newPassword);
      ctx.body = { ok: true };
    });

    // ── SOUL (Settings > Soul tab) — edit Akbal's identity files from the
    // browser: the persona/system-prompt file (soul/akbal.md) and the
    // self-knowledge files that feed the RAG (knowledge/akbal-*.md). Fixed
    // allowlist of ids in config/soul-files.ts — never an arbitrary path.
    router.get("/api/soul/files", async (ctx) => {
      ctx.body = listSoulEditableFiles();
    });

    router.post("/api/soul/files/:id", async (ctx) => {
      const content = (ctx.request.body as any)?.content;
      if (typeof content !== "string") {
        ctx.status = 400;
        ctx.body = { ok: false, error: "content requerido" };
        return;
      }
      const result = writeSoulEditableFile(ctx.params.id, content);
      ctx.status = result.ok ? 200 : 404;
      ctx.body = result;
    });

    // Manual re-embed trigger (Settings > Soul's "Reindexar conocimiento
    // ahora" button) — saving a knowledge file already triggers this on
    // its own; this is for re-running it without editing anything (e.g.
    // after turning ENABLE_RAG on for the first time).
    router.post("/api/soul/reindex", async (ctx) => {
      ctx.body = triggerKnowledgeReindex();
    });

    registerChatHistoryRoutes(router);
    registerChatCommandRoutes(router);
    registerAkbalRoutes(router);

    router.get("/api/models", async (ctx) => {
      ctx.body = await listOllamaModelsWithSize();
    });

    router.post("/api/models/select", async (ctx) => {
      const tag = (ctx.request.body as any)?.tag;
      if (!tag || typeof tag !== "string") {
        ctx.status = 400;
        ctx.body = { error: "tag requerido" };
        return;
      }
      try {
        // Every model switchModel() has ever loaded stays resident
        // "Forever" (keep_alive:-1, see ollama-llm.ts) — intentional so a
        // flow that bounces between two models (e.g. modo agente's local
        // fallback) doesn't pay a cold-load each time. But this endpoint
        // is the one a human uses to try several models back-to-back from
        // the dropdown, with no such fast-toggling need, and stacking 2-3
        // of the bigger ones (2-4GB each) exhausted the Pi's RAM+swap
        // hard enough to make even SSH stop responding (see
        // docs/llm-model-selection.md, incident 2026-10-03). Unload
        // everything else resident before loading the pick so this UI
        // only ever holds one model in memory at a time.
        await unloadModel();
        await switchModel(tag);
        ctx.body = { ok: true, model: getCurrentModel() };
      } catch (err: any) {
        ctx.status = 500;
        ctx.body = { ok: false, error: err?.message || String(err) };
      }
    });

    // Frees the Pi's RAM back up without changing which model is
    // "selected" — picking a model again afterward (physical menu, voice,
    // or this same web UI) reloads it the normal way (switchModel already
    // always calls warmUpModel, whether or not the tag actually changed).
    router.post("/api/models/unload", async (ctx) => {
      try {
        await unloadModel();
        ctx.body = { ok: true };
      } catch (err: any) {
        ctx.status = 500;
        ctx.body = { ok: false, error: err?.message || String(err) };
      }
    });

    // Install a new model (Settings > IA). One pull at a time, polled via
    // GET .../status — same shape as Crack Station's dict-crack status.
    router.post("/api/models/pull/start", async (ctx) => {
      const tag = (ctx.request.body as any)?.tag;
      if (!tag || typeof tag !== "string") {
        ctx.status = 400;
        ctx.body = { ok: false, error: "tag requerido" };
        return;
      }
      ctx.body = startPullModel(tag.trim());
    });

    router.get("/api/models/pull/status", (ctx) => {
      ctx.body = { state: getPullState() };
    });

    router.post("/api/models/pull/cancel", (ctx) => {
      cancelPull();
      ctx.body = { ok: true };
    });

    router.post("/api/models/pull/clear", (ctx) => {
      clearPullState();
      ctx.body = { ok: true };
    });

    router.post("/api/models/delete", async (ctx) => {
      const tag = (ctx.request.body as any)?.tag;
      if (!tag || typeof tag !== "string") {
        ctx.status = 400;
        ctx.body = { ok: false, error: "tag requerido" };
        return;
      }
      if (tag === getCurrentModel()) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "No se puede borrar el modelo seleccionado — cambiá a otro primero" };
        return;
      }
      ctx.body = await deleteOllamaModel(tag);
    });

    // Streams Ollama's chat response as NDJSON (one JSON object per line,
    // same shape Ollama itself uses for `message.content`) — the frontend
    // (web/admin/app.js) already parses it that way. Unlike a straight
    // passthrough, this goes through runAdminChatToolLoop() so the admin
    // chat can call the admin-tools registry (docs/admin-chat-tools.md —
    // read-only in Fase 1: wifiradar/aircraft-radar/gnss/wifi-audit/
    // wardrive status + wifi scan) and report back which sections it
    // touched. Two new NDJSON frame types ride alongside `message.content`,
    // additive to the existing contract:
    //   - {admin_tool_call:{name,title,status}} — a tool starting/finishing,
    //     so the UI can show "Consultando Radar Wi-Fi…" while it runs.
    //   - {admin_links:[{label,href}]} — sent once at the end, built from
    //     which sections actually ran a tool this turn (never parsed out of
    //     the model's own text — see admin-tools/ui-links.ts).
    // The tool loop itself is intentionally NOT the same one ollama-llm.ts
    // uses for the voice flow — that one owns a module-level history
    // singleton shared with the physical device; this one is stateless
    // per-request (see cloud-api/local/admin-chat-tool-loop.ts) so a web
    // chat session can never race a voice conversation over the same array.
    //
    // Two independent safety nets carried over from the old plain
    // passthrough, after a real incident where a stuck model
    // (huihui_ai/qwen3-abliterated:1.7b, already flagged in
    // docs/llm-model-selection.md for sometimes looping) ran the Pi's CPU
    // at ~70% for 45+ minutes with no way to stop it:
    //   1. num_predict caps how many tokens a single reply can ever
    //      generate, so a repetition loop can't run forever even if nobody
    //      notices or clicks cancel.
    //   2. Closing the browser connection (cancel button, tab close, lost
    //      network) aborts *this* request to Ollama — Ollama cancels
    //      generation as soon as its caller disconnects, so the
    //      llama-server process actually stops instead of continuing to
    //      burn CPU on an orphaned response nobody's reading.
    const MAX_PREDICT_TOKENS = parseInt(process.env.WEB_ADMIN_CHAT_MAX_TOKENS || "2048", 10);
    // Same reasoning as OLLAMA_MAX_TOOL_ROUNDS in ollama-llm.ts — bounds how
    // many tool round-trips a single admin chat turn can take before the
    // loop just stops, instead of possibly spinning forever on this
    // hardware.
    const WEB_ADMIN_CHAT_MAX_TOOL_ROUNDS = Math.max(
      0,
      parseInt(process.env.WEB_ADMIN_CHAT_MAX_TOOL_ROUNDS || "4", 10) || 0,
    );
    // Same switch as ollama-llm.ts's enableThinking (default off, see
    // docs/llm-model-selection.md) — sin esto, un modelo "thinking" como
    // los qwen3 gasta la mayoría de num_predict en razonamiento oculto
    // (chunk.message.thinking, que web/admin/app.js ni siquiera lee) antes
    // de llegar al texto visible, haciendo el chat visiblemente más lento
    // sin ganancia perceptible.
    const chatThinkingEnabled = process.env.ENABLE_THINKING === "true";
    router.post("/api/chat", async (ctx) => {
      const body = ctx.request.body as any;
      // Falls back to the web chat's own default (NOT getCurrentModel(),
      // voice's resident model). Only the legacy messages[] path uses it:
      // for a stored chat the chat's own model wins, so a stale <select>
      // cannot switch models mid-conversation.
      const requestedModel = typeof body?.model === "string" && body.model ? body.model : WEB_ADMIN_DEFAULT_MODEL;
      const persisted = typeof body?.message === "string";
      const chatIdInput: string | null = typeof body?.chatId === "string" ? body.chatId : null;
      const newMessage: string = persisted ? body.message.trim() : "";
      const isNewChat = persisted && chatIdInput === null;
      let chat: StoredChat | null = null;

      if (persisted) {
        if (!newMessage) {
          ctx.status = 400;
          ctx.body = { error: "message requerido" };
          return;
        }
        // The user turn hits disk before generation starts, so a reload
        // during a long reply still shows what was asked.
        chat = isNewChat
          ? chatStore.createWithMessage(requestedModel, "user", newMessage)
          : chatStore.appendMessage(chatIdInput!, "user", newMessage);
        if (!chat) {
          ctx.status = 404;
          ctx.body = { error: "chat no encontrado" };
          return;
        }
      }

      const model = chat ? chat.model : requestedModel;
      const messages: AdminChatMessage[] = chat
        ? chat.messages.map((m) => ({ role: m.role, content: m.content }))
        : Array.isArray(body?.messages) ? body.messages : [];
      if (messages.length === 0) {
        ctx.status = 400;
        ctx.body = { error: "messages requerido" };
        return;
      }
      // app.js's `history` never carries a system message (see sendMessage()
      // there) — unlike the voice flow, whose module-level `messages`
      // singleton in ollama-llm.ts starts with one. Without this, the web
      // chat model has no idea it's Akbal at all. Uses basePersonaPrompt
      // (config/llm-config.ts, sourced from the soul file app/soul/akbal.md)
      // rather than the voice flow's `systemPrompt`, which also bakes in
      // "format for text-to-speech" — wrong constraint for a text UI.
      if (!messages.some((m) => m.role === "system")) {
        messages.unshift(
          { role: "system", content: getBasePersonaPrompt() },
          { role: "system", content: WEB_CHAT_TOOL_RULE },
        );
      }
      // RAG, same knowledge base the voice flow already queries
      // (core/Knowledge.ts) — grounds "¿qué es X?" / "¿qué hace Akbal?"
      // questions in app/knowledge/*.md instead of the model improvising.
      // Looked up against the latest user turn, inserted right before it so
      // the model reads "relevant knowledge" then "user asks". Skipped
      // entirely when RAG is disabled (default), and any failure here is
      // non-fatal — chat still answers without it.
      if (enableRAG) {
        try {
          const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
          const lastUserMessage = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
          if (lastUserMessage?.content) {
            const knowledgePrompt = await getSystemPromptWithKnowledge(lastUserMessage.content);
            if (knowledgePrompt && !messages.some((m) => m.role === "system" && m.content === knowledgePrompt)) {
              messages.splice(lastUserIndex, 0, { role: "system", content: knowledgePrompt });
            }
          }
        } catch (err: any) {
          console.error("[AdminChat] RAG lookup failed:", err?.message || err);
        }
      }
      // One system message, at the very start. Qwen3.5's chat template
      // raises "System message must be at the beginning" (Ollama 500) on
      // anything else, and the persona + tool rule + RAG knowledge above
      // would otherwise each be a separate system turn.
      const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      if (systemText) {
        const turns = messages.filter((m) => m.role !== "system");
        messages.splice(0, messages.length, { role: "system", content: systemText }, ...turns);
      }
      if (chat) {
        // Budget = model window minus room for the reply. Falls back to a
        // conservative 4096 when Ollama does not report a window. Messages on
        // disk stay complete; only what the model sees is trimmed.
        const windowTokens = (await getContextWindow(model).catch(() => undefined)) ?? 4096;
        const replyReserve = Math.min(MAX_PREDICT_TOKENS, Math.floor(windowTokens / 4));
        const trimmed = trimToWindow(messages as any, windowTokens - replyReserve);
        messages.splice(0, messages.length, ...(trimmed as AdminChatMessage[]));
      }

      // The web chat takes the one resident model before generating. A voice
      // reply still running is cancelled first, so two models never sit in RAM.
      const memoryDecision = memoryArbiter.requestWeb();
      if (memoryDecision.cancel === "device") cancelHooks.cancelDeviceReply();
      webIdle.cancel();
      try {
        await applyDecision(memoryDecision, { device: getCurrentModel(), web: model }, ollamaDeps);
      } catch (err: any) {
        // A failed load must not leave the arbiter on "web" with nothing to release it.
        webIdle.cancel();
        await abandonWebClaim(memoryArbiter, ollamaDeps).catch(() => undefined);
        // Same rollback as a failed upstream call: the user turn does not stay orphaned.
        if (chat && isNewChat) chatStore.delete(chat.id);
        else if (chat) chatStore.removeLastUserMessage(chat.id);
        ctx.status = 503;
        ctx.body = { error: `no se pudo preparar el modelo: ${err?.message || err}` };
        return;
      }

      // A new chat is titled from its first question before the reply starts,
      // so the sidebar shows the title as soon as the stream opens.
      if (chat && needsTitleBeforeReply(chat)) {
        const question = firstQuestion(chat) || newMessage;
        const titled = (await generateTitleFromQuestion(model, question)) || fallbackTitle(question);
        chat = chatStore.update(chat.id, { title: titled }) ?? chat;
      }

      const abortController = new AbortController();
      // axios' `signal` only cancels a request while it's still being
      // established — once responseType:"stream" resolves, the response
      // body is a live Node Readable already flowing, and aborting the
      // signal at that point does *not* tear it down (confirmed the hard
      // way: the llama-server process kept running well after the browser
      // disconnected). Destroying the stream directly closes its
      // underlying socket to Ollama, which is what actually makes Ollama
      // cancel the generation. onUpstream below keeps this pointed at
      // whichever round's stream is currently live.
      let upstream: Readable | null = null;
      const onClientGone = () => {
        abortController.abort();
        upstream?.destroy();
      };
      // Belt and suspenders: which of these actually fires for a given
      // disconnect (client abort vs. tab close vs. lost network) varies,
      // so all four are wired — cleanupListeners removes them all once,
      // however we got there.
      const emitters: [NodeJS.EventEmitter, string][] = [
        [ctx.req, "close"],
        [ctx.req, "aborted"],
        [ctx.res, "close"],
        [ctx.req.socket, "close"],
      ];
      for (const [emitter, event] of emitters) emitter.on(event, onClientGone);
      const cleanupListeners = (): void => {
        for (const [emitter, event] of emitters) emitter.off(event, onClientGone);
      };
      // Headers/stream only open once Ollama has actually accepted the
      // first round's request (onUpstream fires) — if that very first
      // connection fails outright (Ollama down, etc.) we can still answer
      // with a normal 502 JSON body instead of an empty NDJSON stream,
      // same as the old passthrough did.
      let streaming = false;
      const startStreaming = (): void => {
        if (streaming) return;
        streaming = true;
        ctx.respond = false;
        ctx.res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      };
      const writeFrame = (obj: unknown): void => {
        if (!ctx.res.writableEnded) ctx.res.write(`${JSON.stringify(obj)}\n`);
      };
      // A small local model picks the wrong tool when all of them are offered:
      // a question that names a subsystem gets only that subsystem's tools.
      const lastUserText = [...messages].reverse().find((m) => m.role === "user")?.content || "";
      const sectioned = adminTools.map((tool) => ({
        tool,
        sectionId: adminToolMeta[tool.function.name]?.sectionId,
      }));
      const toolsForTurn = selectToolsForMessage(
        lastUserText,
        sectioned.filter((item): item is { tool: typeof item.tool; sectionId: AdminSectionId } => !!item.sectionId),
      ).map((item) => item.tool);
      const touchedSections = new Set<AdminSectionId>();
      let assistantText = "";
      // The device can take the one resident model mid-reply (see memory/device-takeover.ts).
      cancelHooks.cancelWebReply = () => {
        abortController.abort();
        upstream?.destroy();
      };
      // One place decides what a finished, cancelled or failed exchange leaves
      // on disk and whether it gets a title (see chat-history/settle.ts).
      const finishChat = async (aborted: boolean): Promise<void> => {
        // Every web turn ends here, chat or not: the idle clock restarts now.
        webIdle.touch();
        if (!chat) return;
        settleExchange(chatStore, chat.id, { assistantText, isNewChat });
        if (!streaming || !needsAutoTitle(chatStore.get(chat.id))) return;
        // A cancelled or empty first reply gets the fallback label right away.
        const generated = !aborted && assistantText ? await generateTitle(model, newMessage, assistantText) : null;
        const title = generated || fallbackTitle(newMessage);
        chatStore.update(chat.id, { title });
        if (!aborted) writeFrame({ chat_title: { id: chat.id, title } });
      };
      try {
        await runAdminChatToolLoop({
          model,
          messages,
          // All admin-tools, not a per-section subset: unlike the voice
          // flow (one shared conversation across every physical-menu
          // mode), the chat only ever lives on the shell page (index.html)
          // — there's no "current page" signal narrower than "the chat is
          // open" to filter on. The Fase 1 catalog is small enough (wifi,
          // wifiradar, aircraft radar, gnss, wifi-audit, wardrive status)
          // that sending it in full is fine; registry.ts's
          // adminToolsForSection() is kept ready for when Fase 2/3 grow
          // the catalog enough to need trimming.
          tools: toolsForTurn,
          funcMap: { ...llmFuncMap, ...adminFuncMap },
          maxToolRounds: WEB_ADMIN_CHAT_MAX_TOOL_ROUNDS,
          numPredict: MAX_PREDICT_TOKENS,
          think: chatThinkingEnabled,
          signal: abortController.signal,
          onContent: (text) => {
            assistantText += text;
            writeFrame({ message: { content: text } });
          },
          onToolStart: (name) => {
            const meta = adminToolMeta[name];
            writeFrame({ admin_tool_call: { name, title: meta?.title || name, status: "running" } });
          },
          onToolEnd: (name) => {
            const meta = adminToolMeta[name];
            if (meta) touchedSections.add(meta.sectionId);
            writeFrame({ admin_tool_call: { name, title: meta?.title || name, status: "done" } });
          },
          onUpstream: (stream) => {
            const wasStreaming = streaming;
            startStreaming();
            if (!wasStreaming && chat && isNewChat) {
              writeFrame({ chat: { id: chat.id, title: chat.title, model: chat.model } });
            }
            upstream = stream;
          },
        });
        if (touchedSections.size > 0) {
          writeFrame({ admin_links: [...touchedSections].map((id) => linkForSection(id)) });
        }
      } catch (err: any) {
        if (axios.isCancel(err) || abortController.signal.aborted) {
          // Client already gone — nothing to send a response to, but the
          // partial reply still belongs in the chat.
          cleanupListeners();
          await finishChat(true);
          if (streaming) ctx.res.end();
          return;
        }
        if (!streaming) {
          cleanupListeners();
          await finishChat(false);
          ctx.status = 502;
          ctx.body = { error: err?.message || String(err) };
          return;
        }
        console.error("[AdminChat] Error mid-stream:", err?.message || err);
      }
      cleanupListeners();
      await finishChat(abortController.signal.aborted);
      // A reply asked for by voice: speak it with Akbal's voice, save the
      // clips on the message and send their names to the page. A failure here
      // keeps the written reply; the page shows the error instead of the player.
      if (chat && streaming && !abortController.signal.aborted && assistantText && wantsVoiceReply(newMessage)) {
        try {
          const index = (chatStore.get(chat.id)?.messages.length ?? 1) - 1;
          const names = await saveClips(chat.id, index, toSpeechChunks(assistantText));
          chatStore.setLastAssistantAudio(chat.id, names);
          writeFrame({ audio: { chatId: chat.id, files: names } });
        } catch (err: any) {
          console.error("[AdminChat] voice reply failed:", err?.message || err);
          writeFrame({ audio_error: "No se pudo generar el audio con la voz de Akbal." });
        }
      }
      // The page needs the reply's index for its speaker button.
      if (chat && streaming && assistantText) {
        const idx = (chatStore.get(chat.id)?.messages.length ?? 1) - 1;
        writeFrame({ message_index: { chatId: chat.id, index: idx } });
      }
      if (streaming) ctx.res.end();
    });

    router.get("/api/wifi/status", async (ctx) => {
      ctx.body = await getWifiStatus();
    });

    router.get("/api/wifi/scan-detailed", async (ctx) => {
      ctx.body = await scanWifiNetworksDetailed();
    });

    router.get("/api/wifi/scan", async (ctx) => {
      ctx.body = await scanWifiNetworks();
    });

    router.post("/api/wifi/connect", async (ctx) => {
      const { ssid, password } = (ctx.request.body as any) || {};
      if (!ssid || typeof ssid !== "string") {
        ctx.status = 400;
        ctx.body = { ok: false, error: "ssid requerido" };
        return;
      }
      ctx.body = await connectToWifi(ssid, typeof password === "string" ? password : undefined);
    });

    router.post("/api/wifi/forget", async (ctx) => {
      const { ssid } = (ctx.request.body as any) || {};
      if (!ssid || typeof ssid !== "string") {
        ctx.status = 400;
        ctx.body = { ok: false, error: "ssid requerido" };
        return;
      }
      ctx.body = await forgetWifi(ssid);
    });

    router.get("/api/wifi/password", async (ctx) => {
      const ssid = String(ctx.query.ssid || "");
      if (!ssid) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "ssid requerido" };
        return;
      }
      ctx.body = await getSavedWifiPassword(ssid);
    });

    // ── WARDRIVE (thesis/lab handshake capture) ──
    // All routes gate through the same session cookie as the rest of the
    // admin UI. Attack authorization is the service's allowlist — see
    // wifi-audit/service.ts. No artifacts (handshakes, pcaps, hashes) are
    // ever served here: they live only in ~/wardrive-sessions/ on the
    // device, and this API only reports paths/names, never file contents.
    const wardrive = getWardriveService();

    // Monitor-mode capability of the currently connected USB WiFi adapter — the
    // UI uses this to enable WiFi auditing (Radar/Wardriving) or show a clear
    // "adapter not monitor-capable" message. In platform demo mode the UI
    // drives a simulated wardrive instead, so it doesn't need the adapter:
    // demo:true tells the frontend the enter button stays enabled.
    router.get("/api/wifi/monitor-capability", async (ctx) => {
      try {
        const cap = await detectMonitorAdapter();
        ctx.body = { ...cap, demo: getPlatformMode() === "demo" };
      } catch (err: any) {
        ctx.status = 500;
        ctx.body = { present: false, monitorSupported: false, error: err?.message || String(err), demo: getPlatformMode() === "demo" };
      }
    });

    // Live/demo toggle for the WiFi Radar — also switches the wardrive
    // discovery source (same radio, same preference). In demo mode the
    // radar stops its capture process entirely and feeds synthetic data;
    // requesting live re-attempts real capture immediately (with the
    // service's own retry loop if the adapter isn't ready yet).
    router.post("/api/wifiradar/mode", async (ctx) => {
      const { mode } = (ctx.request.body as any) || {};
      if (mode !== "demo" && mode !== "live") {
        ctx.status = 400;
        ctx.body = { ok: false, error: "mode debe ser 'demo' o 'live'" };
        return;
      }
      const wardriveSvc = getWardriveService();
      wardriveSvc.setSource(mode);
      const applied = await setWifiRadarMode(mode);
      ctx.body = { ok: true, mode: applied, requested: getWifiRadarRequestedMode() };
    });

    router.get("/api/wifiradar/mode", (ctx) => {
      ctx.body = {
        mode: getWifiRadarMode(),
        requested: getWifiRadarRequestedMode(),
      };
    });

    // ── AIRCRAFT RADAR (HackRF One + dump1090 ADS-B) ──
    // Same live/demo shape as WIFIRADAR above — also wired into the shared
    // platform mode toggle (utils/platform-mode.ts), but exposed here too
    // for a per-feature toggle independent of GPS/WiFi Radar.
    router.get("/api/aircraft", (ctx) => {
      ctx.body = getAircraftRadarSnapshot();
    });

    router.get("/api/aircraft/nearest", (ctx) => {
      const snapshot = getAircraftRadarSnapshot();
      const nearest = snapshot.aircraft.find((a) => a.distanceKm !== null) || snapshot.aircraft[0] || null;
      ctx.body = nearest;
    });

    // Aircraft captured inside the zone around Akbal in the last 24 h, newest
    // first, one row per aircraft. Empty when there is no known own position.
    // Each row carries its own captures in the window, so the page draws one
    // card per aircraft with no extra request per card.
    router.get("/api/aircraft/zone", (ctx) => {
      const since = Date.now() - SIGHTING_WINDOW_MS;
      ctx.body = getZoneRecent(since).map((row) => ({
        ...row,
        sightings: getSightingsForIcao(row.icao, since, 20),
      }));
    });

    // Zone captures of one aircraft in the last 24 h, newest first.
    router.get("/api/aircraft/sightings", (ctx) => {
      const icao = ctx.query.icao ? String(ctx.query.icao) : "";
      if (!/^[0-9A-Fa-f]{6}$/.test(icao)) {
        ctx.status = 400;
        ctx.body = { error: "icao invalido" };
        return;
      }
      ctx.body = getSightingsForIcao(icao, Date.now() - SIGHTING_WINDOW_MS);
    });

    router.get("/api/aircraft/history", (ctx) => {
      const minutes = parseInt(String(ctx.query.minutes || "30"), 10) || 30;
      const icao = ctx.query.icao ? String(ctx.query.icao) : null;
      ctx.body = icao
        ? getHistoryForIcao(icao)
        : getRecentHistory(Date.now() - minutes * 60_000);
    });

    router.post("/api/aircraft/mode", async (ctx) => {
      const { mode } = (ctx.request.body as any) || {};
      if (mode !== "demo" && mode !== "live") {
        ctx.status = 400;
        ctx.body = { ok: false, error: "mode debe ser 'demo' o 'live'" };
        return;
      }
      const applied = await setAircraftRadarMode(mode);
      ctx.body = { ok: true, mode: applied, requested: getAircraftRadarRequestedMode() };
    });

    router.get("/api/aircraft/mode", (ctx) => {
      ctx.body = {
        mode: getAircraftRadarMode(),
        requested: getAircraftRadarRequestedMode(),
      };
    });

    // :icao catch-all must come after every more specific /api/aircraft/*
    // route above — @koa/router matches path segments literally, so e.g.
    // "/api/aircraft/nearest" would otherwise be captured as icao="nearest".
    router.get("/api/aircraft/:icao", (ctx) => {
      const aircraft = getAircraftByIcao(ctx.params.icao);
      if (!aircraft) {
        ctx.status = 404;
        ctx.body = { error: "Aeronave no encontrada" };
        return;
      }
      ctx.body = aircraft;
    });

    router.get("/api/wardrive/status", (ctx) => {
      ctx.body = wardrive.getStatus();
    });

    // Live/demo discovery toggle. Applying it here (not in the service) also
    // re-scans immediately so the target list reflects the new source.
    router.post("/api/wardrive/source", async (ctx) => {
      const { source } = (ctx.request.body as any) || {};
      if (source !== "demo" && source !== "live") {
        ctx.status = 400;
        ctx.body = { ok: false, error: "source debe ser 'demo' o 'live'" };
        return;
      }
      wardrive.setSource(source);
      await wardrive.refreshTargets().catch(() => {});
      ctx.body = { ok: true, source: wardrive.getSource() };
    });

    router.post("/api/wardrive/enter", async (ctx) => {
      ctx.body = await wardrive.enter();
    });

    router.post("/api/wardrive/exit", async (ctx) => {
      ctx.body = await wardrive.exit();
    });

    // "Modo chat web": the physical screen freezes on a card and the web chat
    // keeps the device until it is turned off here or by a hold on the button.
    router.get("/api/web-chat-mode", (ctx) => {
      ctx.body = { on: isWebChatModeOn() };
    });

    router.post("/api/web-chat-mode", (ctx) => {
      const { on } = (ctx.request.body as any) || {};
      if (typeof on !== "boolean") {
        ctx.status = 400;
        ctx.body = { ok: false, error: "on debe ser true o false" };
        return;
      }
      ctx.body = { on: setWebChatMode(on) };
    });

    // Dongle selection for Wifi Audit — same picker pattern as wardrive's
    // driving mode (/api/wardrive/drive/adapter*) and WiFi Radar's.
    router.get("/api/wardrive/adapters", async (ctx) => {
      ctx.body = await wardrive.listAdapters();
    });

    router.post("/api/wardrive/adapter", (ctx) => {
      const { iface } = (ctx.request.body as any) || {};
      ctx.body = wardrive.setPreferredAdapter(
        iface == null || String(iface).trim() === "" ? null : String(iface),
      );
    });

    router.post("/api/wardrive/allowlist", (ctx) => {
      const { bssid } = (ctx.request.body as any) || {};
      const ok = wardrive.addToAllowlist(String(bssid || ""));
      if (!ok) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "bssid inválido" };
        return;
      }
      ctx.body = { ok: true };
    });

    router.post("/api/wardrive/allowlist/remove", (ctx) => {
      const { bssid } = (ctx.request.body as any) || {};
      const ok = wardrive.removeFromAllowlist(String(bssid || ""));
      if (!ok) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "bssid inválido o atacándose ahora" };
        return;
      }
      ctx.body = { ok: true };
    });

    router.post("/api/wardrive/attack/one", async (ctx) => {
      const { bssid, method } = (ctx.request.body as any) || {};
      // method: undefined|"auto" = full cycle (PMKID+deauth), "pmkid" = PMKID
      // explicit, "deauth" = deauth-only cycle.
      ctx.body = await wardrive.attackOne(String(bssid || ""), method);
    });

    router.post("/api/wardrive/attack/many", async (ctx) => {
      const { bssids } = (ctx.request.body as any) || {};
      if (!Array.isArray(bssids)) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "bssids (array) requerido" };
        return;
      }
      ctx.body = await wardrive.attackMany(bssids.map(String));
    });

    router.post("/api/wardrive/attack/cancel", (ctx) => {
      ctx.body = wardrive.cancelAttacks();
    });

    // Handshake validation (v2 lab workflow): run aircrack-ng against the
    // captured .cap with the operator-provided password (stdin, never
    // stored). Proves the handshake is complete, not just EAPOL present.
    router.post("/api/wardrive/validate", async (ctx) => {
      const { bssid, password } = (ctx.request.body as any) || {};
      ctx.body = await wardrive.validateHandshake(String(bssid || ""), String(password || ""));
    });

    // Dictionary crack against a captured target — one at a time, progress
    // polled via /dict-status, cancellable. Runs at low priority (nice +2
    // threads) so the Pi keeps responding while it runs. `wordlist` picks
    // "rockyou" (default, plain file) or "weakpass" (big gzip wordlist,
    // streamed via zcat — see DictCrack's "gzip" source in crack.ts);
    // anything else falls back to rockyou.
    router.post("/api/wardrive/dict/start", async (ctx) => {
      const { bssid, cap, wordlist } = (ctx.request.body as any) || {};
      // `cap` targets a past session's capture (path relative to the
      // sessions root, traversal-checked in the service).
      ctx.body = await wardrive.startDictCrack(
        String(bssid || ""),
        cap ? String(cap) : undefined,
        wordlist === "weakpass" ? "weakpass" : "rockyou",
      );
    });

    router.post("/api/wardrive/dict/stop", (ctx) => {
      ctx.body = wardrive.stopDictCrack();
    });

    // Dismiss a finished dict-crack widget (✕ button) — clears backend state.
    router.post("/api/wardrive/dict/clear", (ctx) => {
      ctx.body = wardrive.clearDictCrack();
    });

    router.get("/api/wardrive/dict/status", (ctx) => {
      ctx.body = wardrive.dictCrackStatus();
    });

    // Export a captured handshake as a hashcat 22000 file for off-device GPU
    // cracking (hashcat -m 22000) — the only route to an order-of-magnitude
    // speedup over the Pi's CPU. `cap` targets a past session's capture
    // (traversal-checked in the service). Streams the tiny hash file and
    // deletes the temp.
    router.get("/api/wardrive/dict/export", async (ctx) => {
      const bssid = String(ctx.query.bssid || "");
      const cap = ctx.query.cap ? String(ctx.query.cap) : undefined;
      const res = await wardrive.exportHandshakeHc22000(bssid, cap);
      if (!res.ok || !res.path) {
        ctx.status = 400;
        ctx.body = { ok: false, error: res.error || "No se pudo exportar el handshake" };
        return;
      }
      try {
        const buf = fs.readFileSync(res.path);
        ctx.set("Content-Length", String(buf.length));
        ctx.set("Content-Disposition", `attachment; filename="${res.filename}"`);
        ctx.type = "application/octet-stream";
        ctx.body = buf;
      } finally {
        try {
          fs.unlinkSync(res.path);
        } catch {
          /* already gone */
        }
      }
    });

    // Notification bell (every admin page's topbar) — dict-crack lifecycle
    // log: start/success/fail with timestamps. Newest first, capped at 20.
    router.get("/api/wardrive/dict/events", (ctx) => {
      ctx.body = { ok: true, events: wardrive.dictEventLog() };
    });

    // ── Crack Station (persistent captured-handshake inventory) ──
    // List every captured handshake — Wifi Audit's live + past sessions,
    // PLUS Wardrive's driving sessions (handshakeInventory() merges both,
    // see wifi-audit/service.ts) — with SSID, MAC, handshake/password
    // flags. No file contents leave the device from this endpoint; see
    // /api/wardrive/files for that (works for either source, same root).
    router.get("/api/wardrive/handshakes", (ctx) => {
      ctx.body = { ok: true, ...wardrive.handshakeInventory() };
    });

    // Reverse geocode for Crack Station's capture-location map modal (where
    // was this handshake taken — street, colonia, ciudad, CP). Cached and
    // throttled in geocodePoint() itself (shares the same Nominatim 1 req/s
    // budget as the live GPS page), so this is safe to call freely.
    router.get("/api/wardrive/geocode", async (ctx) => {
      const lat = parseFloat(String(ctx.query.lat || ""));
      const lon = parseFloat(String(ctx.query.lon || ""));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "lat/lon inválidos" };
        return;
      }
      const address = await geocodePoint(lat, lon);
      ctx.body = { ok: true, address };
    });

    // Mask brute force (Crack Station): built-in + operator presets, run
    // status, launch/stop/clear. Runs aircrack with a generated wordlist
    // piped over stdin (crunch-style mask).
    router.get("/api/wardrive/mask/status", (ctx) => {
      ctx.body = wardrive.maskRunStatus();
    });

    router.post("/api/wardrive/mask/run", async (ctx) => {
      const { bssid, presetId, pattern, autoMacSuffix, cap } = (ctx.request.body as any) || {};
      ctx.body = await wardrive.startMaskRun(String(bssid || ""), {
        presetId: presetId ? String(presetId) : undefined,
        pattern: pattern ? String(pattern) : undefined,
        autoMacSuffix: autoMacSuffix === true,
        cap: cap ? String(cap) : undefined,
      });
    });

    router.post("/api/wardrive/mask/stop", (ctx) => {
      ctx.body = wardrive.stopMaskRun();
    });

    router.post("/api/wardrive/mask/clear", (ctx) => {
      ctx.body = wardrive.clearMaskRun();
    });

    // Mask recipe CRUD: list (with built-ins), add/edit (persisted to
    // ~/wardrive-sessions/crack-station.json), remove (builtins refused
    // for edit and remove alike).
    router.get("/api/wardrive/mask/presets", (ctx) => {
      ctx.body = { ok: true, presets: wardrive.listMaskPresets() };
    });

    router.post("/api/wardrive/mask/presets", (ctx) => {
      const { name, description, pattern, autoMacSuffix } = (ctx.request.body as any) || {};
      ctx.body = wardrive.addMaskPreset({
        name,
        description,
        pattern,
        autoMacSuffix,
      } as any);
    });

    router.post("/api/wardrive/mask/presets/update", (ctx) => {
      const { id, name, description, pattern, autoMacSuffix } = (ctx.request.body as any) || {};
      ctx.body = wardrive.updateMaskPreset(String(id || ""), {
        name,
        description,
        pattern,
        autoMacSuffix,
      } as any);
    });

    router.post("/api/wardrive/mask/presets/remove", (ctx) => {
      const { id } = (ctx.request.body as any) || {};
      ctx.body = wardrive.removeMaskPreset(String(id || ""));
    });

    // Dictionary attack against a past-session or in-progress handshake
    // (Crack Station launch point — same engine as the sessions browser).
    // The original route (above, next to the other dict/* ones) still owns
    // this path; no duplicate registration here.

    // Cancel an in-flight password validation (aircrack killed mid-run).
    router.post("/api/wardrive/validate/cancel", (ctx) => {
      const { bssid } = (ctx.request.body as any) || {};
      ctx.body = wardrive.cancelValidation(String(bssid || ""));
    });

    // The password that cracked a captured handshake (🔑 icon). Session-
    // scoped, in-memory only (never written to disk by this endpoint); the
    // UI masks it behind an eye toggle. Lab-only by design.
    router.post("/api/wardrive/password", (ctx) => {
      const { bssid } = (ctx.request.body as any) || {};
      const data = wardrive.getFoundPassword(String(bssid || ""));
      ctx.body = data;
    });

    // Step-by-step progress for the UI stepper. Returns full history so a
    // reopened browser tab can show "where we are" without missing anything.
    router.get("/api/wardrive/progress", (ctx) => {
      const bssid = String(ctx.query.bssid || "");
      if (!bssid) {
        ctx.status = 400;
        ctx.body = { error: "bssid requerido" };
        return;
      }
      ctx.body = {
        bssid,
        entries: wardrive.getSession()?.getProgress(bssid) ?? [],
      };
    });

    // Manual target list refresh (scan button in the UI).
    router.post("/api/wardrive/refresh", async (ctx) => {
      await wardrive.refreshTargets();
      ctx.body = { ok: true };
    });

    // ── WARDRIVE deauth tab ──
    // Client-directed deauth with its own authorization list. listDevices
    // is a read-only view (works even with wardriving off); any attack
    // route requires wardrive mode + per-device authorization.
    router.get("/api/wardrive/devices", (ctx) => {
      ctx.body = wardrive.listDevices();
    });

    router.post("/api/wardrive/deauth/authorize", (ctx) => {
      const { mac } = (ctx.request.body as any) || {};
      const ok = wardrive.authorizeDeauth(String(mac || ""));
      if (!ok) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "mac inválida" };
        return;
      }
      ctx.body = { ok: true };
    });

    router.post("/api/wardrive/deauth/deauthorize", (ctx) => {
      const { mac } = (ctx.request.body as any) || {};
      const ok = wardrive.deauthorizeDeauth(String(mac || ""));
      if (!ok) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "mac inválida" };
        return;
      }
      ctx.body = { ok: true };
    });

    router.post("/api/wardrive/deauth/attack", async (ctx) => {
      const { mac, seconds } = (ctx.request.body as any) || {};
      ctx.body = await wardrive.deauthDevice(String(mac || ""), Number(seconds) || 10);
    });

    router.post("/api/wardrive/deauth/stop", (ctx) => {
      const { mac } = (ctx.request.body as any) || {};
      ctx.body = wardrive.stopDeauth(String(mac || ""));
    });

    // ── WARDRIVE file browser ──
    // Read/list/download/delete over ~/wardrive-sessions/ only. Path
    // traversal is blocked by keeping every path relative to that root
    // (realpath check); downloads stream a single file, never a directory.
    // Sessions listing: every folder = one session (folder name IS the
    // date), with per-target summary so the UI can show what's inside
    // without browsing files one by one.
    router.get("/api/wardrive/sessions", (ctx) => {
      const sessionsRoot = path.join(process.env.HOME || "/home/akbal", "wardrive-sessions");
      let dirs: string[] = [];
      try {
        dirs = fs
          .readdirSync(sessionsRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
          .reverse(); // newest first
      } catch {
        ctx.body = { ok: true, sessions: [] };
        return;
      }
      const sessions = dirs.map((id) => {
        const dir = path.join(sessionsRoot, id);
        let startedAt: number | null = null;
        let targets: { bssid: string; ssid: string; status: string; method: string; verified: boolean; password?: string }[] = [];
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
          startedAt = meta.startedAt || null;
          targets = (meta.targets || []).map((t: any) => ({
            bssid: t.bssid,
            ssid: t.ssid,
            status: t.status,
            method: t.method,
            verified: t.verified === true,
            // Cracked password, if any — the UI masks it behind the eye
            // toggle. Never logged by this endpoint.
            ...(typeof t.password === "string" && t.password ? { password: t.password } : {}),
          }));
        } catch {
          // no/corrupt session.json — still list the folder (files may exist)
        }
        const captured = targets.filter((t) => t.status === "captured").length;
        // Eye icon in the session list: targets with a recovered password.
        const found = targets
          .filter((t) => t.status === "captured" && t.password)
          .map((t) => ({ bssid: t.bssid, ssid: t.ssid, password: t.password as string }));
        return { id, startedAt, captured, targets, found };
      });
      ctx.body = { ok: true, sessions };
    });

    router.get("/api/wardrive/files", (ctx) => {
      const relativePath = String(ctx.query.path || "");
      const resolved = wardrive.resolveSessionPath(relativePath);
      if (!resolved) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "Ruta inválida" };
        return;
      }
      let entries;
      try {
        entries = fs.readdirSync(resolved, { withFileTypes: true });
      } catch {
        ctx.status = 404;
        ctx.body = { ok: false, error: "No encontrado" };
        return;
      }
      const items = entries
        .filter((e) => e.isFile() || e.isDirectory())
        .map((e) => {
          const itemPath = path.join(resolved, e.name);
          let size = 0;
          try {
            size = e.isDirectory() ? 0 : fs.statSync(itemPath).size;
          } catch {
            // vanished mid-listing — report 0, it'll be gone next refresh
          }
          return {
            name: e.name,
            type: e.isDirectory() ? "dir" : "file",
            size,
            path: path.posix.join(relativePath.replace(/\\/g, "/"), e.name),
          };
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      ctx.body = { ok: true, path: relativePath, items };
    });

    router.get("/api/wardrive/files/download", (ctx) => {
      const relativePath = String(ctx.query.path || "");
      const resolved = wardrive.resolveSessionPath(relativePath);
      if (!resolved) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "Ruta inválida" };
        return;
      }
      let stat;
      try {
        stat = fs.statSync(resolved);
      } catch {
        ctx.status = 404;
        ctx.body = { ok: false, error: "Archivo no encontrado" };
        return;
      }
      if (!stat.isFile()) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "No es un archivo" };
        return;
      }
      ctx.set("Content-Length", String(stat.size));
      ctx.set("Content-Disposition", `attachment; filename="${path.basename(resolved)}"`);
      ctx.type = "application/octet-stream";
      ctx.body = fs.createReadStream(resolved);
    });

    // Inline preview: text files (info/log/progress) render as-is, binary
    // captures get a human-readable summary + a hexdump-style head so the
    // user can confirm what a file is before downloading it. Same path
    // traversal rules as /files.
    router.get("/api/wardrive/files/preview", (ctx) => {
      const relativePath = String(ctx.query.path || "");
      const resolved = wardrive.resolveSessionPath(relativePath);
      if (!resolved || !fs.statSync(resolved).isFile()) {
        ctx.status = 404;
        ctx.body = { ok: false, error: "No encontrado" };
        return;
      }
      const name = path.basename(resolved);
      if (/\.(txt|json|jsonl|csv|log)$/i.test(name)) {
        // Text: read up to 64KB — enough for any info/log excerpt.
        const text = fs.readFileSync(resolved, "utf8").slice(0, 64 * 1024);
        ctx.body = { ok: true, kind: "text", name, content: text };
        return;
      }
      if (/\.hc22000$/i.test(name)) {
        // Hash lines are printable text too — show them (they're the point
        // of the file) with a warning about what they are.
        const text = fs.readFileSync(resolved, "utf8").slice(0, 16 * 1024);
        ctx.body = { ok: true, kind: "text", name, content: text, note: "hash WPA (hashcat -m 22000) — crack offline aparte" };
        return;
      }
      // Binary (.cap/.pcapng): hexdump the first 4KB + file size summary.
      const stat = fs.statSync(resolved);
      const head = fs.readFileSync(resolved).subarray(0, 4096);
      const lines: string[] = [];
      for (let i = 0; i < head.length; i += 16) {
        const chunk = head.subarray(i, i + 16);
        const hex = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ");
        const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
        lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
      }
      ctx.body = {
        ok: true,
        kind: "binary",
        name,
        size: stat.size,
        content: lines.join("\n"),
        note: "captura binaria — vista parcial (primeros 4KB). Descargá el archivo para analizarlo.",
      };
    });

    // Delete one session folder (or all of them). The UI must confirm —
    // "all" is only honored when the body carries confirm:"DELETE ALL",
    // a literal type-to-confirm string, so a stray click can't wipe
    // every handshake on the device.
    router.post("/api/wardrive/sessions/delete", (ctx) => {
      const { id } = (ctx.request.body as any) || {};
      const confirm = String(((ctx.request.body as any) || {}).confirm || "");
      const sessionsRoot = path.join(process.env.HOME || "/home/akbal", "wardrive-sessions");
      if (id === "ALL") {
        if (confirm !== "DELETE ALL") {
          ctx.body = { ok: false, error: "confirmación requerida: confirm='DELETE ALL'" };
          return;
        }
        if (wardrive.getStatus().mode !== "inactive") {
          ctx.body = { ok: false, error: "Salí del modo wardriving antes de borrar sesiones" };
          return;
        }
        let n = 0;
        try {
          for (const d of fs.readdirSync(sessionsRoot)) {
            const full = path.join(sessionsRoot, d);
            if (fs.statSync(full).isDirectory()) {
              fs.rmSync(full, { recursive: true, force: true });
              n++;
            }
          }
        } catch (err: any) {
          ctx.body = { ok: false, error: err?.message || String(err) };
          return;
        }
        ctx.body = { ok: true, deleted: n };
        return;
      }
      const cleaned = String(id || "").trim();
      // Demo sessions (folders prefixed "demo-") follow the same rules but
      // with their own prefix (the id regex below only matches live ones).
      const demoSession = /^demo-20\d{6}-\d{6}$/.test(cleaned);
      if (!demoSession && !/^20\d{6}-\d{6}$/.test(cleaned)) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "id de sesión inválido" };
        return;
      }
      if (wardrive.getStatus().mode !== "inactive") {
        ctx.body = { ok: false, error: "Salí del modo wardriving antes de borrar la sesión" };
        return;
      }
      const full = path.join(sessionsRoot, cleaned);
      const resolvedReal = fs.existsSync(full) ? fs.realpathSync(full) : "";
      if (!resolvedReal || !resolvedReal.startsWith(fs.realpathSync(sessionsRoot) + path.sep)) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "Sesión no encontrada" };
        return;
      }
      try {
        fs.rmSync(resolvedReal, { recursive: true, force: true });
        ctx.body = { ok: true };
      } catch (err: any) {
        ctx.body = { ok: false, error: err?.message || String(err) };
      }
    });

    router.post("/api/wardrive/files/delete", (ctx) => {
      const { path: relativePath } = (ctx.request.body as any) || {};
      const resolved = wardrive.resolveSessionPath(String(relativePath || ""));
      if (!resolved) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "Ruta inválida" };
        return;
      }
      try {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          // Sessions themselves (top-level dirs) and their subfolders —
          // rm -rf, but only ever under the sessions root (resolveSessionPath
          // already guarantees containment).
          fs.rmSync(resolved, { recursive: true, force: true });
        } else {
          fs.unlinkSync(resolved);
        }
        ctx.body = { ok: true };
      } catch (err: any) {
        ctx.status = 500;
        ctx.body = { ok: false, error: err?.message || String(err) };
      }
    });

    // ── WARDRIVE (driving capture — wardrive/service.ts, docs/wardrive.md)
    // Separate module from Wifi Audit above: continuous passive discovery
    // + opportunistic handshake capture while driving, GPS track per
    // session, global SSID archive. Artifacts land in
    // ~/wardrive-sessions/drive-*/; counters and "already captured" state
    // live in data/wardrive-drive.db.
    const drive = getDriveWardriveService();

    router.get("/api/wardrive/drive/status", (ctx) => {
      ctx.body = drive.getStatus();
    });

    router.post("/api/wardrive/drive/start", async (ctx) => {
      ctx.body = await drive.start();
    });

    router.post("/api/wardrive/drive/stop", async (ctx) => {
      ctx.body = await drive.stop();
    });

    // Manual attack against one visible AP (⚡ button in the wardrive list):
    // the operator picks the target NOW instead of waiting for the
    // scheduler — same PMKID→deauth smart round the auto-engine runs.
    // Refuses: engine off, attack in flight, invisible/protected targets.
    router.post("/api/wardrive/drive/attack", async (ctx) => {
      const { bssid, method } = (ctx.request.body as any) || {};
      ctx.body = await drive.attackApExternal(String(bssid || ""), method === "deauth" ? "deauth" : method === "pmkid" ? "pmkid" : undefined);
    });

    // The deauth toggle is gone from the UI: the engine runs PMKID first
    // and the deauth fallback fires automatically when slow/stopped. This
    // route stays as a no-op for older clients that POST to it.

    // Dongle selection: list the USB wifi adapters present and pin the one
    // wardrive should use. Only changeable with the attack stopped.
    router.get("/api/wardrive/drive/adapters", async (ctx) => {
      ctx.body = await drive.listAdapters();
    });

    router.post("/api/wardrive/drive/adapter", (ctx) => {
      const { iface } = (ctx.request.body as any) || {};
      ctx.body = drive.setPreferredAdapter(
        iface == null || String(iface).trim() === "" ? null : String(iface),
      );
    });

    // Radio-count preference: "auto" = every connected monitor radio (default),
    // "single" = 1 shared radio, "dual" = 2 radios (1 attack + 1 discovery),
    // "triple" = 3 radios (1 attack + 2 discovery). Only changeable with the
    // session stopped.
    router.get("/api/wardrive/drive/radio-mode", (ctx) => {
      ctx.body = { ok: true, mode: drive.getRadioMode() };
    });

    router.post("/api/wardrive/drive/radio-mode", (ctx) => {
      const { mode } = (ctx.request.body as any) || {};
      ctx.body = drive.setRadioMode(String(mode || ""));
    });

    // Scan mode toggle (like the header's LIVE/DEMO): "atacar" = what the
    // engine always did (PMKID/deauth rounds); "mapear" = strictly passive
    // capture — sight every SSID, anchor it on the map, save the session
    // with NO handshakes. Only changeable with the session stopped.
    router.get("/api/wardrive/drive/scan-mode", (ctx) => {
      ctx.body = { ok: true, mode: drive.getScanMode() };
    });

    router.post("/api/wardrive/drive/scan-mode", (ctx) => {
      const { mode } = (ctx.request.body as any) || {};
      if (mode !== "mapear" && mode !== "atacar") {
        ctx.status = 400;
        ctx.body = { ok: false, error: "mode debe ser 'atacar' o 'mapear'" };
        return;
      }
      ctx.body = drive.setScanMode(mode);
    });

    // 1-vs-2-adapter efficiency comparison, from the attack_rounds table.
    router.get("/api/wardrive/drive/rounds/comparison", (ctx) => {
      ctx.body = { ok: true, comparison: driveDb.roundComparison() };
    });

    // Session list (DB-backed, includes track shape flags for the UI).
    router.get("/api/wardrive/drive/sessions", (ctx) => {
      ctx.body = { ok: true, sessions: driveDb.sessions() };
    });

    // Delete one past session: its folder (captures, logs, hashes) + its
    // DB rows (session, track, handshakes). Refused while a session runs.
    router.post("/api/wardrive/drive/sessions/delete", async (ctx) => {
      const { id } = (ctx.request.body as any) || {};
      const cleaned = String(id || "").trim();
      if (!/^drive-20\d{6}-\d{6}$/.test(cleaned)) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "id de sesión inválido" };
        return;
      }
      if (drive.getStatus().running) {
        ctx.body = { ok: false, error: "Detené la sesión activa antes de borrar recorridos" };
        return;
      }
      let ok = driveDb.deleteSession(cleaned);
      try {
        fs.rmSync(path.join(DRIVE_SESSIONS_ROOT, cleaned), { recursive: true, force: true });
        ok = true;
      } catch (err: any) {
        console.warn(`[wardrive] session folder delete failed: ${err?.message || err}`);
      }
      ctx.body = { ok };
    });

    // Full all-time historial export (every network ever seen).
    router.get("/api/wardrive/drive/export/historial", (ctx) => {
      const stamp = new Date().toISOString().slice(0, 10);
      ctx.set("Content-Disposition", `attachment; filename="akbal-wardrive-historial-${stamp}.csv"`);
      ctx.type = "text/csv";
      ctx.body = driveDb.historialCsv();
    });

    // Track polyline for the map (live session or any past one).
    router.get("/api/wardrive/drive/track", (ctx) => {
      const id = String(ctx.query.id || "");
      if (!/^drive-20\d{6}-\d{6}$/.test(id)) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "id de sesión inválido" };
        return;
      }
      const track = driveDb.trackPoints(id);
      ctx.body = { ok: true, id, points: track };
    });

    // Networks recorded during one session (the "what did I find" table).
    router.get("/api/wardrive/drive/session-networks", (ctx) => {
      const id = String(ctx.query.id || "");
      if (!/^drive-20\d{6}-\d{6}$/.test(id)) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "id de sesión inválido" };
        return;
      }
      ctx.body = { ok: true, id, networks: driveDb.sessionNetworks(id) };
    });

    // WiGLE CSV export (networks + capture positions for the session).
    router.get("/api/wardrive/drive/export/csv", (ctx) => {
      const id = String(ctx.query.id || "");
      const csv = drive.sessionCsv(id);
      if (csv == null) {
        ctx.status = 404;
        ctx.body = { ok: false, error: "Sesión inválida o sin datos" };
        return;
      }
      ctx.set("Content-Disposition", `attachment; filename="${id}.csv"`);
      ctx.type = "text/csv";
      ctx.body = csv;
    });

    // GPX export (the driven track, for Google Earth / OSM).
    router.get("/api/wardrive/drive/export/gpx", (ctx) => {
      const id = String(ctx.query.id || "");
      const gpx = drive.sessionGpx(id);
      if (gpx == null) {
        ctx.status = 404;
        ctx.body = { ok: false, error: "Sesión inválida o sin datos" };
        return;
      }
      ctx.set("Content-Disposition", `attachment; filename="${id}.gpx"`);
      ctx.type = "application/gpx+xml";
      ctx.body = gpx;
    });

    // Capture artifacts (.cap/.hc22000) of a drive session: same traversal-
    // safe download contract as the lab sessions above, restricted to
    // drive-* folders.
    router.get("/api/wardrive/drive/files", (ctx) => {
      const id = String(ctx.query.id || "");
      if (!/^drive-20\d{6}-\d{6}$/.test(id)) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "id de sesión inválido" };
        return;
      }
      const dir = path.join(DRIVE_SESSIONS_ROOT, id);
      let items: { name: string; size: number; path: string }[] = [];
      try {
        items = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile() && /\.(cap|hc22000|json|log|csv)$/i.test(e.name))
          .map((e) => {
            let size = 0;
            try {
              size = fs.statSync(path.join(dir, e.name)).size;
            } catch {
              // vanished
            }
            return { name: e.name, size, path: `${id}/${e.name}` };
          })
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        ctx.body = { ok: true, items: [] };
        return;
      }
      ctx.body = { ok: true, id, items };
    });

    router.get("/api/wardrive/drive/files/download", (ctx) => {
      const relative = String(ctx.query.path || "");
      const id = relative.split("/")[0] || "";
      const name = path.basename(relative);
      if (!/^drive-20\d{6}-\d{6}$/.test(id) || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "Ruta inválida" };
        return;
      }
      const resolved = path.join(DRIVE_SESSIONS_ROOT, id, name);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        ctx.status = 404;
        ctx.body = { ok: false, error: "Archivo no encontrado" };
        return;
      }
      ctx.set("Content-Disposition", `attachment; filename="${name}"`);
      ctx.type = "application/octet-stream";
      ctx.body = fs.createReadStream(resolved);
    });

    router.get("/api/usb/devices", async (ctx) => {
      ctx.body = await listUsbDevices();
    });

    router.get("/api/usb/volumes", async (ctx) => {
      ctx.body = await listUsbVolumes();
    });

    router.get("/api/usb/wifi-adapters", async (ctx) => {
      ctx.body = await listUsbWifiAdapters();
    });

    router.post("/api/usb/mount", async (ctx) => {
      const { volume } = (ctx.request.body as any) || {};
      if (!volume || typeof volume !== "string") {
        ctx.status = 400;
        ctx.body = { ok: false, error: "volume requerido" };
        return;
      }
      ctx.body = await ensureMounted(volume);
    });

    router.post("/api/usb/eject", async (ctx) => {
      const { volume } = (ctx.request.body as any) || {};
      if (!volume || typeof volume !== "string") {
        ctx.status = 400;
        ctx.body = { ok: false, error: "volume requerido" };
        return;
      }
      ctx.body = await ejectVolume(volume);
    });

    router.get("/api/usb/files", async (ctx) => {
      const volumeName = String(ctx.query.volume || "");
      const relativePath = String(ctx.query.path || "");
      const volume = await findVolume(volumeName);
      if (!volume) {
        ctx.status = 404;
        ctx.body = { ok: false, error: "Volumen no encontrado" };
        return;
      }
      if (!volume.mounted) {
        ctx.status = 409;
        ctx.body = { ok: false, error: "Volumen no montado" };
        return;
      }
      ctx.body = await listFiles(volume.mountPath, relativePath);
    });

    const IMAGE_TYPES: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
    };

    router.get("/api/usb/file", async (ctx) => {
      const volumeName = String(ctx.query.volume || "");
      const relativePath = String(ctx.query.path || "");
      const volume = await findVolume(volumeName);
      if (!volume || !volume.mounted) {
        ctx.status = 404;
        ctx.body = { ok: false, error: "Volumen no encontrado o no montado" };
        return;
      }
      const filePath = resolveFilePath(volume.mountPath, relativePath);
      if (!filePath) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "Ruta inválida" };
        return;
      }
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        ctx.status = 404;
        ctx.body = { ok: false, error: "Archivo no encontrado" };
        return;
      }
      if (!stat.isFile()) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "No es un archivo" };
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const imageType = IMAGE_TYPES[ext];
      ctx.set("Content-Length", String(stat.size));
      if (imageType) {
        ctx.type = imageType;
      } else {
        ctx.type = "application/octet-stream";
        ctx.set("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
      }
      ctx.body = fs.createReadStream(filePath);
    });
  }

  setEnsureAgentBridge(fn: () => void): void {
    this.ensureAgentBridge = fn;
  }

  start(): void {
    if (this.server) return;
    const publicRoot = path.resolve(__dirname, "../..", "web", "admin");
    if (!fs.existsSync(publicRoot)) {
      console.warn(`[WebAdmin] Public dir not found at ${publicRoot}, UI will 404`);
    }
    this.server = http.createServer(this.app.callback());

    // Mounted on the same http.Server/port as the rest of the admin UI
    // (path-routed, not a separate port) so there's nothing new to open in
    // a firewall — `noServer: true` + a manual `upgrade` handler below is
    // what makes that possible, and is also where the session cookie gets
    // checked, since a WebSocket upgrade request never goes through Koa.
    const WS_PATHS = ["/wifiradar/ws", "/aircraft-radar/ws"];
    this.wss = new WebSocketServer({ noServer: true });
    // Separate server so the radar 'connection' handler below never sees DOOM
    // sockets. Attached once: start() can run again after stop(), and a second
    // attach would double the session listeners.
    if (!this.doomWss) {
      this.doomWss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
      attachDoomSocket(this.doomWss, doomSession, () => this.doomUrl, {
        // The same cookie check as the admin pages (see isValidSessionCookie).
        isAdminSession: (req) => this.isValidSessionCookie(req.headers.cookie),
      });
    }
    this.refreshDoomUrl();
    if (!this.doomUrlTimer) {
      this.doomUrlTimer = setInterval(() => this.refreshDoomUrl(), DOOM_URL_REFRESH_MS);
      this.doomUrlTimer.unref();
    }
    this.server.on("upgrade", (req, socket, head) => {
      // Registered first: a reset before the handshake finishes would otherwise
      // be an unhandled 'error' on the raw socket.
      socket.on("error", () => socket.destroy());
      // req.url can carry a query string (/wifiradar/ws?fullMac=1) — strip it
      // for the path check or the upgrade is rejected and the socket dies.
      const pathname = (req.url || "").split("?")[0];
      if (pathname === DOOM_WS_PATH) {
        // No session cookie here: the phone on the DOOM QR page has no admin
        // login. The token is checked on the "claim" message instead. The
        // upgrade stays synchronous: the screen URL is cached by a timer, so
        // nothing async runs between the raw socket and handleUpgrade.
        const doomWss = this.doomWss!;
        doomWss.handleUpgrade(req, socket, head, (ws) => {
          doomWss.emit("connection", ws, req);
        });
        return;
      }
      if (!WS_PATHS.includes(pathname) || !this.isValidSessionCookie(req.headers.cookie)) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit("connection", ws, req);
      });
    });
    this.wss.on("connection", (ws: WebSocket, req) => {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== "/aircraft-radar/ws") {
        // A WiFi Radar page holds the radar for as long as its socket is open.
        const holder = `web-ws-${Date.now()}-${Math.random()}`;
        holdWifiRadar(holder);
        ws.on("close", () => releaseWifiRadar(holder));
      }
      const send = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          if (url.pathname === "/aircraft-radar/ws") {
            ws.send(JSON.stringify(getAircraftRadarSnapshot()));
          } else {
            ws.send(JSON.stringify(getWifiRadarSnapshot(url.searchParams.get("fullMac") === "1")));
          }
        } catch (err) {
          console.warn("[WebAdmin] radar ws send failed:", err);
        }
      };
      send();
      const interval = setInterval(send, WIFIRADAR_BROADCAST_MS);
      ws.on("close", () => clearInterval(interval));
      ws.on("error", () => clearInterval(interval));
    });

    this.server.listen(this.port, "0.0.0.0", () => {
      console.log(`[WebAdmin] Listening on http://0.0.0.0:${this.port}`);
    });
  }

  private refreshDoomUrl(): void {
    resolveDoomScreenUrl(this.port)
      .then((url) => {
        this.doomUrl = url;
      })
      .catch(() => {});
  }

  stop(): void {
    if (this.doomUrlTimer) clearInterval(this.doomUrlTimer);
    this.doomUrlTimer = null;
    this.wss?.close();
    this.wss = null;
    this.server?.close();
    this.server = null;
  }
}
