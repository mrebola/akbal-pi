import fs from "fs";
import net from "net";
import path from "path";
import { spawn } from "child_process";
import type { Status } from "../../device/display";
import { DoomSession, DoomState, EngineProcess } from "../../doom/session";
import { ControlTokens } from "../../doom/tokens";
import { ControllerLock } from "../../doom/control";
import { getNetworkInfo, generateConnectQr } from "../../utils/network-info";
import { getApStatus } from "../../utils/access-point";

// DOOM on the Whisplay screen: QR while nobody holds the controller, full
// screen frames once someone does. The web (Task 8) shares these singletons.

const APP_DIR = path.resolve(__dirname, "../../..");
const DOOM_ENGINE_BIN = path.join(APP_DIR, "doom", "bin", "doom-engine");
const DOOM_WAD = path.join(process.env.DOOM_WAD_DIR || path.join(APP_DIR, "data", "doom"), "freedoom1.wad");

const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;

// The screen payload also carries the DOOM-only keys that Python reads
// (game_frame, game_orientation, game_qr_path). display() forwards any key,
// so these only need the type widened here.
type DoomPayload = Partial<Status> & {
  game_frame?: string;
  game_orientation?: number;
  game_qr_path?: string;
};

function sendDisplay(payload: DoomPayload): void {
  // Loaded lazily on purpose: importing device/display starts the Python
  // display process, and the pure helpers in this file must stay importable
  // from tests without it.
  const { display } = require("../../device/display") as typeof import("../../device/display");
  display(payload);
}

export function doomScreenUrl(input: {
  tailscaleHost: string | null;
  apActive: boolean;
  lanIp: string | null;
  port: number;
}): string {
  if (input.tailscaleHost) return `http://${input.tailscaleHost}:${input.port}/doom`;
  if (input.apActive) return `http://10.42.0.1:${input.port}/doom`;
  return `http://${input.lanIp ?? "127.0.0.1"}:${input.port}/doom`;
}

// Any flow change away from DOOM is an exit, whatever caused it (the hold,
// a web chat, an approval, a spoken answer). ChatFlow.transitionTo calls
// leaveDoomMode when this says so.
// The QR carries the control token, so a phone that scans it can claim the
// controller. Only the QR gets it: the socket state never echoes the token.
export function withControlToken(url: string, token: string): string {
  const u = new URL(url);
  u.searchParams.set("t", token);
  return u.toString();
}

export function shouldLeaveDoom(from: string, to: string): boolean {
  return from === "doom" && to !== "doom";
}

// Pantalla directa = Whisplay driver in this process (WhisplayBoard). When the
// whisplay-daemon answers, it owns the panel and cannot rotate it for DOOM.
export function doomBlockedReason(daemonActive: boolean): string | null {
  return daemonActive ? "DOOM requiere la pantalla directa; el daemon está activo" : null;
}

// Same check as whisplay_client.create_whisplay_hardware: a health.ping on the
// daemon socket that answers ok.
export function isWhisplayDaemonActive(socketPath = "/tmp/whisplay-daemon.sock", timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const sock = net.createConnection(socketPath);
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on("error", () => done(false));
    sock.on("connect", () => sock.write(JSON.stringify({ version: 1, cmd: "health.ping", payload: {} }) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      if (!buf.includes("\n")) return;
      try {
        done(JSON.parse(buf.split("\n")[0]).ok === true);
      } catch {
        done(false);
      }
    });
  });
}

export async function resolveDoomScreenUrl(port: number): Promise<string> {
  const net = await getNetworkInfo(port).catch(() => null);
  const ap = await getApStatus().catch(() => null);
  return doomScreenUrl({
    tailscaleHost: net?.tailscaleFqdn ?? null,
    apActive: ap?.active ?? false,
    lanIp: net?.lanIp ?? null,
    port,
  });
}

function spawnDoomEngine(): EngineProcess {
  // -iwad: the engine would otherwise search the process cwd for the WAD.
  const child = spawn(DOOM_ENGINE_BIN, ["-iwad", DOOM_WAD], { stdio: ["pipe", "pipe", "inherit"] });
  return {
    stdout: child.stdout!,
    stdin: child.stdin!,
    kill: () => child.kill(),
    onExit: (cb) => {
      child.once("exit", (code) => cb(code));
      child.once("error", () => cb(null));
    },
  };
}

export const doomTokens = new ControlTokens();
export const doomLock = new ControllerLock();
export const doomSession = new DoomSession({
  spawnEngine: spawnDoomEngine,
  tokens: doomTokens,
  lock: doomLock,
  binaryExists: () => fs.existsSync(DOOM_ENGINE_BIN),
  wadExists: () => fs.existsSync(DOOM_WAD),
});

let unsubscribers: Array<() => void> = [];
let baseScreenUrl = "";
let qrPath = "";
// Bumped on every enter and leave, so an enter still generating its QR
// cannot start the engine after the player already left.
let generation = 0;

// The QR text is shown on the device, and display() logs a preview of it, so
// it carries the base URL only. The token lives in the QR image.
export function doomQrText(hasQr: boolean, baseUrl: string): string {
  return hasQr ? "Escanea el QR para controlar DOOM" : `Abre ${baseUrl} para controlar DOOM`;
}

// Entry from the flow. Any failure ends in the error card, never in a
// half-built screen: subscriptions are dropped and the engine is stopped.
export async function enterDoomMode(url: string): Promise<void> {
  const gen = ++generation;
  baseScreenUrl = url;
  try {
    await startDoom(url, gen);
  } catch (err) {
    if (gen !== generation) return;
    console.warn("[DOOM] enter failed:", (err as Error).message);
    unsubscribers.forEach((off) => off());
    unsubscribers = [];
    doomSession.stop();
    showDoomError("No se pudo iniciar DOOM");
  }
}

async function startDoom(url: string, gen: number): Promise<void> {
  const daemonActive = await isWhisplayDaemonActive();
  if (gen !== generation) return;
  const blocked = doomBlockedReason(daemonActive);
  if (blocked) {
    showDoomError(blocked);
    return;
  }
  const started = doomSession.start();
  if (!started.ok) {
    showDoomError(started.error ?? "No se pudo iniciar DOOM");
    return;
  }
  // The token only exists once the engine starts, so the QR is built after it.
  // If the player left during the await, leaveDoomMode already stopped the engine.
  const tokenUrl = withControlToken(url, started.token!);
  const qr = await generateConnectQr(tokenUrl).catch(() => "");
  if (gen !== generation) return;
  qrPath = qr;
  unsubscribers.forEach((off) => off());
  unsubscribers = [
    doomSession.onState((s) => paintForState(s)),
    doomSession.onFrame((frame) => {
      if (doomSession.state().controller) {
        sendDisplay({ game_frame: frame.toString("base64") });
      }
    }),
  ];
  paintForState(doomSession.state());
}

// Physical exit: stop the engine and give the screen back vertically.
export function leaveDoomMode(): void {
  generation++;
  unsubscribers.forEach((off) => off());
  unsubscribers = [];
  doomSession.stop();
  sendDisplay({ game_orientation: 1 });
}

function paintForState(s: DoomState): void {
  if (s.error) return showDoomError(s.error);
  if (!s.running) return;
  if (s.controller) {
    sendDisplay({ status: "doom", text: "", game_orientation: 3 });
    return;
  }
  showDoomQr();
}

function showDoomQr(): void {
  sendDisplay({
    status: "doom",
    emoji: "🎮",
    RGB: "#ff3030",
    text: doomQrText(qrPath !== "", baseScreenUrl),
    game_qr_path: qrPath,
    game_orientation: 3,
  });
}

function showDoomError(text: string): void {
  sendDisplay({
    status: "doom",
    emoji: "⚠️",
    RGB: "#ff3030",
    text,
    game_qr_path: "",
    game_orientation: 1,
  });
}

// Same hold grammar as web-chat-mode.ts: hold ~0.9s to leave.
let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;

function clearHoldTimers(): void {
  if (holdTicker) {
    clearInterval(holdTicker);
    holdTicker = null;
  }
  if (confirmTimer) {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }
}

export function handleDoomPress(onExit: () => void): void {
  clearHoldTimers();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    sendDisplay({
      model_ui: "confirm",
      model_ui_title: "DOOM",
      model_ui_label: "Salir del modo",
      model_ui_description: "",
      model_ui_percent: percent,
      text: "Manteniendo presionado...",
    });
  }, HOLD_TICK_MS);
  confirmTimer = setTimeout(() => {
    clearHoldTimers();
    onExit();
  }, CONFIRM_HOLD_MS);
}

export function handleDoomRelease(): void {
  const wasHolding = holdTicker !== null || confirmTimer !== null;
  clearHoldTimers();
  pressStartedAt = 0;
  if (wasHolding) sendDisplay({ model_ui: "" });
}
