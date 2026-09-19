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
import { AirspaceService } from "../airspace/service";
import { registerShutdownHook } from "./display";
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
// AIRSPACE broadcasts a snapshot to every connected client on this cadence
// — 2-4Hz per the spec, not per-packet, which is most of what keeps this
// cheap: the aggregator can ingest hundreds of frames/sec while the network
// only ever sees ~3 JSON messages/sec regardless.
const AIRSPACE_BROADCAST_MS = 300;

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
  private airspace: AirspaceService;

  constructor(options: { port: number; username: string; password: string }) {
    this.port = options.port;
    this.username = options.username;
    this.password = options.password;
    this.airspace = new AirspaceService();
    // Restoring wlan1 out of monitor mode and killing tshark has to
    // actually finish before the process exits, or a redeploy/restart
    // leaves the AR9271 stuck in monitor mode and a root tshark orphaned —
    // see display.ts's shutdown hook system for why this isn't a plain
    // SIGTERM listener here.
    registerShutdownHook(() => this.airspace.stop());
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

    // AIRSPACE — fullscreen Three.js WiFi visualization. Its own page
    // (not a tab in index.html's chat/wifi/usb layout — a WebGL scene
    // deserves the whole viewport) backed by the AirspaceService created
    // above; live data streams over /airspace/ws (see start()), this route
    // just serves the page shell and an initial snapshot for first paint
    // before the socket connects.
    router.get("/airspace", (ctx) => {
      ctx.set("Cache-Control", "no-store");
      ctx.type = "text/html";
      ctx.body = fs.createReadStream(path.resolve(__dirname, "../..", "web", "admin", "airspace.html"));
    });

    router.get("/api/airspace/snapshot", (ctx) => {
      const revealFullMac = ctx.query.fullMac === "1";
      ctx.body = this.airspace.getSnapshot(revealFullMac);
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
      if (req.url !== "/airspace/ws" || !this.isValidSessionCookie(req.headers.cookie)) {
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
          ws.send(JSON.stringify(this.airspace.getSnapshot(revealFullMac)));
        } catch (err) {
          console.warn("[WebAdmin] airspace ws send failed:", err);
        }
      };
      send();
      const interval = setInterval(send, AIRSPACE_BROADCAST_MS);
      ws.on("close", () => clearInterval(interval));
      ws.on("error", () => clearInterval(interval));
    });

    void this.airspace.start();

    this.server.listen(this.port, "0.0.0.0", () => {
      console.log(`[WebAdmin] Listening on http://0.0.0.0:${this.port}`);
    });
  }

  stop(): void {
    this.wss?.close();
    this.wss = null;
    void this.airspace.stop();
    this.server?.close();
    this.server = null;
  }
}
