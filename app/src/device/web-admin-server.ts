import fs from "fs";
import path from "path";
import http from "http";
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
import {
  connectToWifi,
  forgetWifi,
  getWifiStatus,
  scanWifiNetworks,
} from "../utils/wifi";

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

    router.get("/api/status", async (ctx) => {
      const wifi = await getWifiStatus();
      ctx.body = {
        model: getCurrentModel(),
        deviceMode: isAgentMode() ? "agent" : "local",
        wifi,
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
    router.post("/api/chat", async (ctx) => {
      const body = ctx.request.body as any;
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const model = typeof body?.model === "string" && body.model ? body.model : getCurrentModel();
      if (messages.length === 0) {
        ctx.status = 400;
        ctx.body = { error: "messages requerido" };
        return;
      }
      try {
        const response = await axios.post(
          `${ollamaEndpoint}/api/chat`,
          { model, messages, stream: true },
          { responseType: "stream" },
        );
        ctx.respond = false;
        ctx.res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.data.pipe(ctx.res);
      } catch (err: any) {
        ctx.status = 502;
        ctx.body = { error: err?.message || String(err) };
      }
    });

    router.get("/api/wifi/status", async (ctx) => {
      ctx.body = await getWifiStatus();
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
