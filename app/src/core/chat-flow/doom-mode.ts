import fs from "fs";
import net from "net";
import path from "path";
import { spawn } from "child_process";
import type { Readable } from "stream";
import type { Status } from "../../device/display";
import { DoomOwner, DoomSession, DoomState, EngineProcess } from "../../doom/session";
import { DoomGame, wadFileName } from "../../doom/wad";
import { scheduleKillIfAlive, terminateChild } from "../../doom/terminate";
import { AudioOut, AudioProcess } from "../../doom/audio-out";
import { MusicPlayer, MusicProcess } from "../../doom/music";
import { ControlTokens } from "../../doom/tokens";
import { ControllerLock } from "../../doom/control";
import { getNetworkInfo, generateConnectQr } from "../../utils/network-info";
import { getApStatus } from "../../utils/access-point";

// DOOM on the Whisplay screen: QR while nobody holds the controller, full
// screen frames once someone does. The web (Task 8) shares these singletons.

const APP_DIR = path.resolve(__dirname, "../../..");
const DOOM_ENGINE_BIN = path.join(APP_DIR, "doom", "bin", "doom-engine");
// Absolute on purpose: the engine runs with cwd=APP_DIR, so a relative override would break.
// Data the DOOM runtime keeps: WAD, soundfont and settings.json.
const DOOM_DATA_DIR = path.resolve(process.env.DOOM_WAD_DIR || path.join(APP_DIR, "data", "doom"));
const wadPathFor = (game: DoomGame): string => path.join(DOOM_DATA_DIR, wadFileName(game));
// Optional: without it the game runs silent. scripts/fetch-doom-soundfont.sh puts it here.
const DOOM_SOUNDFONT = path.join(DOOM_DATA_DIR, "soundfont.sf2");

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
import { withControlToken } from "../../doom/control-qr";
export { withControlToken };

// What the Whisplay screen shows for the current owner. The web owner gets the
// mirror (frames only, no QR); the Pi owner gets the game once a phone or the
// Pi holds the controller, and the QR until then.
export function screenFaceFor(owner: "pi" | "web" | null, controller: boolean): "qr" | "game" | "mirror" {
  if (owner === "web") return "mirror";
  if (owner === "pi" && controller) return "game";
  return "qr";
}

// The engine stopped cleanly while the flow still is DOOM (the web ended the
// game): the Pi goes back to the menu, the same exit as the button hold. A crash
// (error set) keeps the error card on screen; the button leaves from there.
export function decideOnEngineStopped(
  currentFlow: string,
  running: boolean,
  error: string | null,
): "return-to-sleep" | "none" {
  return currentFlow === "doom" && !running && error === null ? "return-to-sleep" : "none";
}

// The Pi shows the mirror only from sleep: a spoken reply, an approval or the
// listening keep their screen, and the mirror waits for the next sleep.
export function decideMirrorEntry(
  currentFlow: string,
  owner: DoomOwner,
  running: boolean,
): "enter-mirror" | "none" {
  return currentFlow === "sleep" && owner === "web" && running ? "enter-mirror" : "none";
}

// Set by ChatFlow right before it moves to "doom" for a mirror; the doom state
// reads it once, so the button entry (which starts the engine) is unchanged.
let mirrorEntryRequested = false;

export function requestDoomMirror(): void {
  mirrorEntryRequested = true;
}

export function takeDoomEntryIsMirror(): boolean {
  const requested = mirrorEntryRequested;
  mirrorEntryRequested = false;
  return requested;
}

// What the DOOM flow lets this module ask of the flow machine. Reads the live
// flow name and performs the normal transition, so there is one exit path.
export interface DoomFlowHooks {
  currentFlow: () => string;
  returnToSleep: () => void;
}

// Every exit from DOOM gives the vertical screen back, whoever owns the game:
// leaveDoomMode sends game_orientation 1 on each of them.
export function decideLeaveDoom(from: string, to: string, owner: DoomOwner): "restore-orientation" | "none" {
  void owner;
  return from === "doom" && to !== "doom" ? "restore-orientation" : "none";
}

export function shouldLeaveDoom(from: string, to: string): boolean {
  return decideLeaveDoom(from, to, null) === "restore-orientation";
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

function spawnDoomEngine(game: DoomGame): EngineProcess {
  // -iwad: the WAD is named explicitly. cwd=APP_DIR: the engine writes its
  // converted music to <cwd>/data/doom/music, the same place the player reads.
  // fd 3 = PCM for sound effects, fd 4 = control lines (song/stop/pause/resume).
  const child = spawn(DOOM_ENGINE_BIN, ["-iwad", wadPathFor(game)], {
    cwd: APP_DIR,
    stdio: ["pipe", "pipe", "inherit", "pipe", "pipe"],
  });
  return {
    stdout: child.stdout!,
    stdin: child.stdin!,
    audio: child.stdio[3] as Readable,
    control: child.stdio[4] as Readable,
    kill: () => terminateChild(child),
    onExit: (cb) => {
      child.once("exit", (code) => cb(code));
      child.once("error", () => cb(null));
    },
  };
}

// aplay is optional: if it is missing or dies, AudioOut closes and the game
// simply plays without sound. Its stdout and stderr are dropped on purpose.
function spawnAplay(cmd: string, args: string[]): AudioProcess {
  const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
  return {
    stdin: child.stdin!,
    kill: () => terminateChild(child),
    onExit: (cb) => {
      child.once("exit", () => cb());
      child.once("error", () => cb());
    },
  };
}

// fluidsynth is optional, like aplay: if it is missing the MusicPlayer stays
// silent and the game plays without music. Its output is dropped on purpose.
function spawnFluidsynth(cmd: string, args: string[]): MusicProcess {
  const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
  // Without a listener a write to a dead fluidsynth would crash the whole process.
  child.stdin!.on("error", () => {});
  return {
    signal: (sig) => {
      if (!child.pid) return;
      process.kill(child.pid, sig);
      // Same escalation as the engine: a fluidsynth that ignores SIGTERM is killed.
      if (sig === "SIGTERM") scheduleKillIfAlive(child);
    },
    write: (line) => {
      child.stdin!.write(line);
    },
    onExit: (cb) => {
      child.once("exit", (code) => cb(code));
      child.once("error", (err) => cb(null, err));
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
  wadExists: (game) => fs.existsSync(wadPathFor(game)),
  openAudio: (onError) => new AudioOut(spawnAplay, onError),
  openMusic: (onError) => new MusicPlayer(spawnFluidsynth, DOOM_SOUNDFONT, undefined, onError),
  settingsDir: DOOM_DATA_DIR,
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
export async function enterDoomMode(url: string, flow: DoomFlowHooks): Promise<void> {
  const gen = ++generation;
  baseScreenUrl = url;
  try {
    await startDoom(url, gen, flow);
  } catch (err) {
    if (gen !== generation) return;
    console.warn("[DOOM] enter failed:", (err as Error).message);
    unsubscribers.forEach((off) => off());
    unsubscribers = [];
    doomSession.stop();
    showDoomError("No se pudo iniciar DOOM");
  }
}

async function startDoom(url: string, gen: number, flow: DoomFlowHooks): Promise<void> {
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
  // Entering from the screen makes the Pi the owner. claimOwner reissues the
  // token, so the QR must carry the token it returns, not start()'s.
  const claimed = doomSession.claimOwner("pi");
  if (!claimed.ok) {
    showDoomError(claimed.error ?? "No se pudo iniciar DOOM");
    return;
  }
  // If the player left during the await, leaveDoomMode already stopped the engine.
  const tokenUrl = withControlToken(url, claimed.token!);
  const qr = await generateConnectQr(tokenUrl).catch(() => "");
  if (gen !== generation) return;
  qrPath = qr;
  subscribeScreen(flow);
  // The engine may have stopped during the QR await, before the listener existed.
  const now = doomSession.state();
  if (decideOnEngineStopped(flow.currentFlow(), now.running, now.error) === "return-to-sleep") {
    return flow.returnToSleep();
  }
  paintForState(doomSession.state());
}

// Mirror entry: the engine already runs for the web, so nothing starts and
// no QR is made. The screen only subscribes and paints.
export function enterDoomMirror(flow: DoomFlowHooks): void {
  generation++;
  qrPath = "";
  subscribeScreen(flow);
  paintForState(doomSession.state());
}

// Frames and state for the Pi screen. Shared by the Pi entry and the mirror.
function subscribeScreen(flow: DoomFlowHooks): void {
  unsubscribers.forEach((off) => off());
  unsubscribers = [
    doomSession.onState((s) => {
      if (decideOnEngineStopped(flow.currentFlow(), s.running, s.error) === "return-to-sleep") return flow.returnToSleep();
      paintForState(s);
    }),
    doomSession.onFrame((frame) => {
      const st = doomSession.state();
      if (screenFaceFor(st.owner, st.controller) !== "qr") {
        sendDisplay({ game_frame: frame.toString("base64") });
      }
    }),
  ];
}

// Physical exit: give the screen back vertically. The engine stops unless the
// web owns it: leaving a mirror must not end the web's game.
// Set by the Pi's button hold right before it leaves DOOM: only that exit ends
// the game for everyone, the web owner included.
let holdExit = false;
export function markDoomHoldExit(): void {
  holdExit = true;
}

// A web-chat, reply or approval exit does not end a game the web owns.
export function shouldStopOnLeave(owner: DoomOwner, hold: boolean): boolean {
  return hold || owner !== "web";
}

export function leaveDoomMode(): void {
  generation++;
  unsubscribers.forEach((off) => off());
  unsubscribers = [];
  const hold = holdExit;
  holdExit = false;
  if (shouldStopOnLeave(doomSession.owner(), hold)) doomSession.stop();
  sendDisplay({ game_orientation: 1 });
}

function paintForState(s: DoomState): void {
  if (s.error) return showDoomError(s.error);
  if (!s.running) return;
  const face = screenFaceFor(s.owner, s.controller);
  if (face === "game") {
    sendDisplay({ status: "doom", text: "", game_orientation: 3 });
    return;
  }
  if (face === "mirror") {
    // game_qr_path "" drops the QR so the renderer shows only this text until frames arrive.
    sendDisplay({ status: "doom", text: "Jugando desde la web", game_qr_path: "", game_orientation: 3 });
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
