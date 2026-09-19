import fs from "fs";
import path from "path";
import http from "http";
import { Readable } from "stream";
import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";
import serve from "koa-static";
import axios from "axios";
import {
  getCurrentModel,
  listOllamaModelsWithSize,
  ollamaEndpoint,
  switchModel,
} from "../cloud-api/local/ollama-llm";
import { isAgentMode } from "../config/device-mode";
import { getBatteryReading } from "../status/battery-status";
import {
  connectToEmergencyWifi,
  connectToWifi,
  forgetWifi,
  getWifiStatus,
  hasEmergencyWifiConfigured,
  scanWifiNetworks,
} from "../utils/wifi";
import {
  ensureMounted,
  findVolume,
  listFiles,
  listUsbDevices,
  listUsbVolumes,
  resolveFilePath,
} from "../utils/usb";

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
  private port: number;
  private username: string;
  private password: string;

  constructor(options: { port: number; username: string; password: string }) {
    this.port = options.port;
    this.username = options.username;
    this.password = options.password;
    this.app = new Koa();
    this.app.use(this.basicAuth());
    this.app.use(bodyParser());

    const router = new Router();
    this.registerRoutes(router);
    this.app.use(router.routes());
    this.app.use(router.allowedMethods());

    const publicRoot = path.resolve(__dirname, "../..", "web", "admin");
    this.app.use(serve(publicRoot));
  }

  private basicAuth() {
    const username = this.username;
    const password = this.password;
    return async (ctx: Koa.Context, next: Koa.Next) => {
      const header = ctx.headers.authorization || "";
      const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
      if (header !== expected) {
        ctx.status = 401;
        ctx.set("WWW-Authenticate", 'Basic realm="Akbal"');
        ctx.body = "Unauthorized";
        return;
      }
      await next();
    };
  }

  private registerRoutes(router: Router): void {
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

    router.get("/api/status", async (ctx) => {
      const wifi = await getWifiStatus();
      ctx.body = {
        model: getCurrentModel(),
        deviceMode: isAgentMode() ? "agent" : "local",
        wifi,
        battery: getBatteryReading(),
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
    this.server.listen(this.port, "0.0.0.0", () => {
      console.log(`[WebAdmin] Listening on http://0.0.0.0:${this.port}`);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
