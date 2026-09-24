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
import { getWifiRadarSnapshot, setWifiRadarMode, getWifiRadarMode, getWifiRadarRequestedMode } from "../wifiradar/service";
import { detectMonitorAdapter } from "../wifiradar/adapter";
import { getWardriveService } from "../wardrive/service";
import {
  getCurrentModel,
  isModelLoaded,
  listOllamaModelsWithSize,
  ollamaEndpoint,
  switchModel,
  unloadModel,
} from "../cloud-api/local/ollama-llm";
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
import { getSystemStats } from "../utils/system-stats";
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
// on-screen menu can't do that, see chat-flow/wifi-connect-mode.ts). Same Koa/
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
      // before there's any session to check.
      if (PUBLIC_PATHS.has(ctx.path) || ctx.path.startsWith("/avatar/")) {
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
        audioOutput: getAudioOutputTarget(),
        wifi,
        battery: getBatteryReading(),
        system,
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
    // wardrive/service.ts. No artifacts (handshakes, pcaps, hashes) are
    // ever served here: they live only in ~/wardrive-sessions/ on the
    // device, and this API only reports paths/names, never file contents.
    const wardrive = getWardriveService();

    // Monitor-mode capability of the currently connected USB WiFi adapter — the
    // UI uses this to enable WiFi auditing (Radar/Wardriving) or show a clear
    // "adapter not monitor-capable" message.
    router.get("/api/wifi/monitor-capability", async (ctx) => {
      try {
        ctx.body = await detectMonitorAdapter();
      } catch (err: any) {
        ctx.status = 500;
        ctx.body = { present: false, monitorSupported: false, error: err?.message || String(err) };
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

    // Handshake validation (v2 lab workflow): run aircrack-ng against the
    // captured .cap with the operator-provided password (stdin, never
    // stored). Proves the handshake is complete, not just EAPOL present.
    router.post("/api/wardrive/validate", async (ctx) => {
      const { bssid, password } = (ctx.request.body as any) || {};
      ctx.body = await wardrive.validateHandshake(String(bssid || ""), String(password || ""));
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
        let targets: { bssid: string; ssid: string; status: string; method: string; verified: boolean }[] = [];
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
          startedAt = meta.startedAt || null;
          targets = (meta.targets || []).map((t: any) => ({
            bssid: t.bssid,
            ssid: t.ssid,
            status: t.status,
            method: t.method,
            verified: t.verified === true,
          }));
        } catch {
          // no/corrupt session.json — still list the folder (files may exist)
        }
        const captured = targets.filter((t) => t.status === "captured").length;
        return { id, startedAt, captured, targets };
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
      if (!/^20\d{6}-\d{6}$/.test(cleaned)) {
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
