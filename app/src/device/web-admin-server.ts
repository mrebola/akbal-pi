import fs from "fs";
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
import { getWifiRadarSnapshot } from "../wifiradar/service";
import { getWardriveService } from "../wardrive/service";
import {
  getCurrentModel,
  isModelLoaded,
  listOllamaModelsWithSize,
  ollamaEndpoint,
  switchModel,
  unloadModel,
} from "../cloud-api/local/ollama-llm";
import { isAgentMode } from "../config/device-mode";
import { getBatteryReading } from "../status/battery-status";
import { getSystemStats } from "../utils/system-stats";
import {
  connectToEmergencyWifi,
  connectToWifi,
  forgetWifi,
  getSavedWifiPassword,
  getWifiStatus,
  hasEmergencyWifiConfigured,
  scanWifiNetworks,
  scanWifiNetworksDetailed,
} from "../utils/wifi";
import {
  ensureMounted,
  findVolume,
  listFiles,
  listUsbDevices,
  listUsbVolumes,
  listUsbWifiAdapters,
  resolveFilePath,
} from "../utils/usb";

const SESSION_COOKIE = "akbal_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — a LAN admin
// page for a single household device, not worth re-logging-in constantly for.
// Paths reachable with no session at all — just enough to render and submit
// the login form itself.
const PUBLIC_PATHS = new Set(["/login", "/login.html", "/api/login"]);
// WIFIRADAR broadcasts a snapshot to every connected client on this cadence
// — 2-4Hz per the spec, not per-packet, which is most of what keeps this
// cheap: the aggregator can ingest hundreds of frames/sec while the network
// only ever sees ~3 JSON messages/sec regardless.
const WIFIRADAR_BROADCAST_MS = 300;

// Small local admin UI, reachable from any device on the LAN — a chat page
// for the local Ollama models (like a mini OpenWebUI) and a wifi settings
// page (scan/connect/forget, with a real password field — the physical
// on-screen menu can't do that, see wifi-manager-mode.ts). Same Koa/
// koa-static stack as WebDisplayServer (device/web-display.ts), which this
// intentionally doesn't touch or replace — that one mirrors the device's
// own screen for dev without hardware; this one is a separate, always-on
// admin surface. See docs/web-ui.md.
export class WebAdminServer {
  private app: Koa;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port: number;
  private username: string;
  private password: string;
  // Bare random tokens instead of Koa's signed-cookie helper — same
  // security property (unguessable, 192 bits) but readable from a plain
  // Set both here and in the raw WebSocket upgrade handler below, which
  // never goes through Koa's request/response cycle so ctx.cookies isn't
  // available there.
  private validSessions = new Set<string>();

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
      if (PUBLIC_PATHS.has(ctx.path)) {
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
    if (!cookieHeader) return false;
    for (const part of cookieHeader.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      if (name !== SESSION_COOKIE) continue;
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      return this.validSessions.has(value);
    }
    return false;
  }

  private registerRoutes(router: Router): void {
    router.get("/login", (ctx) => {
      ctx.set("Cache-Control", "no-store");
      ctx.type = "text/html";
      ctx.body = fs.createReadStream(path.resolve(__dirname, "../..", "web", "admin", "login.html"));
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

    router.get("/api/wifiradar/snapshot", (ctx) => {
      const revealFullMac = ctx.query.fullMac === "1";
      ctx.body = getWifiRadarSnapshot(revealFullMac);
    });

    router.get("/api/status", async (ctx) => {
      const [wifi, system, modelLoaded] = await Promise.all([
        getWifiStatus(),
        getSystemStats(),
        isModelLoaded(),
      ]);
      ctx.body = {
        model: getCurrentModel(),
        modelLoaded,
        deviceMode: isAgentMode() ? "agent" : "local",
        wifi,
        battery: getBatteryReading(),
        system,
      };
    });

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

    // Streams Ollama's own NDJSON chat response straight through — the
    // frontend (web/admin/app.js) parses one JSON object per line as it
    // arrives, same shape Ollama always returns.
    //
    // Two independent safety nets, after a real incident where a stuck
    // model (huihui_ai/qwen3-abliterated:1.7b, already flagged in
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
    router.post("/api/chat", async (ctx) => {
      const body = ctx.request.body as any;
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const model = typeof body?.model === "string" && body.model ? body.model : getCurrentModel();
      if (messages.length === 0) {
        ctx.status = 400;
        ctx.body = { error: "messages requerido" };
        return;
      }
      const abortController = new AbortController();
      // axios' `signal` only cancels the request while it's still being
      // established — once responseType:"stream" resolves, response.data
      // is a live Node Readable already flowing, and aborting the signal
      // at that point does *not* tear it down (confirmed the hard way: the
      // llama-server process kept running well after the browser
      // disconnected). Destroying the stream directly closes its
      // underlying socket to Ollama, which is what actually makes Ollama
      // cancel the generation.
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
      try {
        const response = await axios.post(
          `${ollamaEndpoint}/api/chat`,
          { model, messages, stream: true, options: { num_predict: MAX_PREDICT_TOKENS } },
          { responseType: "stream", signal: abortController.signal },
        );
        upstream = response.data;
        ctx.respond = false;
        ctx.res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.data.pipe(ctx.res);
        response.data.on("error", () => {
          // An unhandled 'error' on a Readable stream crashes the process —
          // Ollama closing the connection after we aborted it lands here,
          // not in the outer catch, since piping already started.
          cleanupListeners();
          ctx.res.end();
        });
        response.data.on("close", cleanupListeners);
      } catch (err: any) {
        cleanupListeners();
        if (axios.isCancel(err) || abortController.signal.aborted) {
          // Client already gone — nothing to send a response to.
          return;
        }
        ctx.status = 502;
        ctx.body = { error: err?.message || String(err) };
      }
    });

    router.get("/api/wifi/status", async (ctx) => {
      ctx.body = await getWifiStatus();
    });

    router.get("/api/wifi/scan-detailed", async (ctx) => {
      ctx.body = await scanWifiNetworksDetailed();
    });

    router.get("/api/wifi/scan", async (ctx) => {
      const networks = await scanWifiNetworks();
      const emergencySsid = process.env.EMERGENCY_WIFI_SSID;
      ctx.body = networks.map((n) => ({
        ...n,
        // Flags the pre-configured emergency network (see docs/wifi.md) so
        // the UI can tag it and skip asking for a password it already has.
        isEmergency: Boolean(emergencySsid) && n.ssid === emergencySsid,
      }));
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

    router.post("/api/wifi/connect-emergency", async (ctx) => {
      if (!hasEmergencyWifiConfigured()) {
        ctx.status = 400;
        ctx.body = { ok: false, error: "No hay red de emergencia configurada" };
        return;
      }
      ctx.body = await connectToEmergencyWifi();
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
    // wardrive/service.ts. No artifacts (handshakes, pcaps, hashes) are
    // ever served here: they live only in ~/wardrive-sessions/ on the
    // device, and this API only reports paths/names, never file contents.
    const wardrive = getWardriveService();

    router.get("/api/wardrive/status", (ctx) => {
      ctx.body = wardrive.getStatus();
    });

    router.post("/api/wardrive/enter", async (ctx) => {
      ctx.body = await wardrive.enter();
    });

    router.post("/api/wardrive/exit", async (ctx) => {
      ctx.body = await wardrive.exit();
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
      const { bssid } = (ctx.request.body as any) || {};
      ctx.body = await wardrive.attackOne(String(bssid || ""));
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
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      if (req.url !== "/wifiradar/ws" || !this.isValidSessionCookie(req.headers.cookie)) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit("connection", ws, req);
      });
    });
    this.wss.on("connection", (ws: WebSocket, req) => {
      const url = new URL(req.url || "", "http://localhost");
      const revealFullMac = url.searchParams.get("fullMac") === "1";
      const send = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify(getWifiRadarSnapshot(revealFullMac)));
        } catch (err) {
          console.warn("[WebAdmin] wifiradar ws send failed:", err);
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

  stop(): void {
    this.wss?.close();
    this.wss = null;
    this.server?.close();
    this.server = null;
  }
}
