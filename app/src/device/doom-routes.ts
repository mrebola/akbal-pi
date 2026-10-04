import { WebSocketServer, WebSocket, RawData } from "ws";
import { randomUUID } from "node:crypto";
import { DoomOwner, DoomSession, DoomState } from "../doom/session";
import { DOOM_KEYS, DoomKey } from "../doom/keymap";
import { encodeFrameJpeg } from "../doom/frame-jpeg";
import { clampVolume } from "../doom/volume";

export type DoomClientMessage =
  | { type: "claim"; token: string }
  | { type: "release" }
  | { type: "key"; key: DoomKey; down: boolean }
  | { type: "stream"; on: boolean }
  | { type: "play-here" }
  | { type: "volume"; value: number }
  | { type: "stop" };

export function parseDoomMessage(raw: string): DoomClientMessage | null {
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  if (m.type === "claim" && typeof m.token === "string") return { type: "claim", token: m.token };
  if (m.type === "release") return { type: "release" };
  if (m.type === "key" && (DOOM_KEYS as readonly string[]).includes(m.key) && typeof m.down === "boolean") {
    return { type: "key", key: m.key, down: m.down };
  }
  if (m.type === "stream" && typeof m.on === "boolean") return { type: "stream", on: m.on };
  if (m.type === "play-here") return { type: "play-here" };
  if (m.type === "stop") return { type: "stop" };
  if (m.type === "volume" && typeof m.value === "number") return { type: "volume", value: m.value };
  return null;
}

// What this socket is allowed to do, decided from the session's owner. A
// mirror is a socket that is not the web owner while the web owns the game.
// With the Pi as owner nobody is a mirror: a phone with the QR token may take
// the control (claim and the engine lock check the token).
export interface DoomSocketView {
  owner: DoomOwner;
  isWebOwner: boolean;
  // True when some socket is currently the web owner. If the web owner's
  // socket went away, the web's claim is stale and another tab may take it.
  webOwnerOnline: boolean;
}

// Jugar aquí arranca el motor si no corre; si ya corre solo cambia de dueño.
export function decideStartForPlayHere(running: boolean): "start" | "claim-only" {
  return running ? "claim-only" : "start";
}

export function doomMessageAllowed(msg: DoomClientMessage, view: DoomSocketView): boolean {
  const mirror = view.owner === "web" && !view.isWebOwner;
  switch (msg.type) {
    case "key":
    case "claim":
      return !mirror;
    case "volume":
    case "stop":
      return view.owner === "web" && view.isWebOwner;
    case "play-here":
      return !(view.owner === "web" && view.webOwnerOnline && !view.isWebOwner);
    default:
      return true;
  }
}

// Video is capped: at most one JPEG every FRAME_INTERVAL_MS, and only the
// newest frame is kept. A slow phone must not queue the Pi's CPU or memory.
const FRAME_INTERVAL_MS = 100;
const MAX_BUFFERED_BYTES = 256 * 1024;
const HEARTBEAT_MS = 5000;

export function shouldEncodeNow(lastEncodedAt: number, now: number, minGapMs = FRAME_INTERVAL_MS): boolean {
  return now - lastEncodedAt >= minGapMs;
}

// bufferedAmount is what ws still holds unsent for this socket. Above the
// limit the frame is dropped for that socket; state messages are small and
// always go out.
export function canSendTo(bufferedAmount: number, limit = MAX_BUFFERED_BYTES): boolean {
  return bufferedAmount <= limit;
}

// Heartbeat: each tick clears the flag and pings; a pong sets it again. A
// socket still unset at the next tick never answered, so it is dead.
export function isDeadSocket(alive: boolean): boolean {
  return !alive;
}

export interface DoomSocketOptions {
  heartbeatMs?: number;
  // The same check the Pi's own start uses: a reason string when the
  // whisplay daemon owns the panel and DOOM cannot start, else null.
  daemonBlockedReason?: () => Promise<string | null>;
}

// Production check, from doom-mode.ts. Loaded lazily so that the route module
// (and its tests) do not pull in the display and network modules.
const defaultDaemonBlockedReason = async (): Promise<string | null> => {
  const mode = require("../core/chat-flow/doom-mode") as typeof import("../core/chat-flow/doom-mode");
  return mode.doomBlockedReason(await mode.isWhisplayDaemonActive());
};

// Every socket gets state. Only sockets that asked for video get JPEG frames,
// so an idle Pi with no viewers encodes nothing.
export function attachDoomSocket(
  wss: WebSocketServer,
  session: DoomSession,
  screenUrl: () => string,
  options: DoomSocketOptions = {},
): void {
  type ClientEntry = { id: string; streaming: boolean; alive: boolean; webOwnerFlag: boolean; token?: string };
  const clients = new Map<WebSocket, ClientEntry>();

  // The flag is only meaningful while the session is owned by the web.
  const isWebOwner = (c: ClientEntry | undefined): boolean => c?.webOwnerFlag === true && session.owner() === "web";

  const viewFor = (ws: WebSocket): DoomSocketView => ({
    owner: session.owner(),
    isWebOwner: isWebOwner(clients.get(ws)),
    webOwnerOnline: session.owner() === "web" && [...clients.values()].some((c) => isWebOwner(c)),
  });

  // The claim error (bad token, busy controller) goes only to the socket that
  // sent the claim. Broadcasts carry the engine's own error, if any.
  const sendState = (ws: WebSocket, claimError?: string) => {
    const s: DoomState = session.state();
    const c = clients.get(ws);
    const webOwner = isWebOwner(c);
    ws.send(
      JSON.stringify({
        type: "state",
        running: s.running,
        controller: c ? session.isController(c.id) : false,
        controlled: s.controller,
        error: claimError ?? s.error,
        audioError: s.audioError,
        musicError: s.musicError,
        streaming: c?.streaming ?? false,
        url: screenUrl(),
        owner: s.owner,
        mirror: s.owner === "web" && !webOwner,
        volume: session.volume(),
        // Only the web owner's own socket ever gets the token.
        token: webOwner ? c?.token : undefined,
      }),
    );
  };

  // Removing a client always releases its control and any keys it held. Safe
  // to call twice: a second call finds the client already gone.
  const dropClient = (ws: WebSocket) => {
    const c = clients.get(ws);
    if (!c) return;
    session.release(c.id);
    clients.delete(ws);
  };

  let latest: Buffer | null = null;
  let lastEncodedAt = 0;
  session.onState(() => clients.forEach((_, ws) => sendState(ws)));
  session.onFrame((rgb565) => {
    // Copied: the frame reader's buffer is not ours to keep.
    if ([...clients.values()].some((c) => c.streaming)) latest = Buffer.from(rgb565);
  });
  const flushFrame = () => {
    if (!latest) return;
    const now = Date.now();
    if (!shouldEncodeNow(lastEncodedAt, now)) return;
    const frame = latest;
    latest = null;
    const wanting = [...clients].filter(
      ([ws, c]) => c.streaming && ws.readyState === WebSocket.OPEN && canSendTo(ws.bufferedAmount),
    );
    if (wanting.length === 0) return;
    let jpg: Buffer;
    try {
      jpg = encodeFrameJpeg(frame);
    } catch (err) {
      console.warn("[DOOM] frame encode failed:", (err as Error).message);
      return;
    }
    lastEncodedAt = now;
    for (const [ws] of wanting) ws.send(jpg);
  };
  // unref: these timers alone must not keep the process alive.
  setInterval(flushFrame, FRAME_INTERVAL_MS).unref();

  // A phone that vanishes without a close frame would otherwise hold the
  // control and any pressed keys forever.
  const heartbeat = setInterval(() => {
    for (const [ws, c] of [...clients]) {
      if (isDeadSocket(c.alive)) {
        dropClient(ws);
        ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        ws.ping();
      } catch {
        // Already closing: its close event will clean up.
      }
    }
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();

  wss.on("connection", (ws: WebSocket) => {
    const id = randomUUID();
    clients.set(ws, { id, streaming: false, alive: true, webOwnerFlag: false });
    ws.on("pong", () => {
      const c = clients.get(ws);
      if (c) c.alive = true;
    });
    sendState(ws);
    // Jugar aquí from the web starts the engine, so it passes the same daemon
    // check as the Pi's own start. Async: the reply waits for the check.
    const playHere = async () => {
      if (decideStartForPlayHere(session.state().running) === "start") {
        const blocked = await (options.daemonBlockedReason ?? defaultDaemonBlockedReason)();
        if (!clients.has(ws)) return;
        if (blocked) {
          sendState(ws, blocked);
          return;
        }
      }
      let claimError: string | undefined;
      let r: { ok: boolean; token?: string; error?: string };
      if (decideStartForPlayHere(session.state().running) === "start") {
        const started = session.start();
        r = started.ok ? session.claimOwner("web") : { ok: false, error: started.error };
      } else r = session.claimOwner("web");
      if (r.ok) {
        // One web owner at a time: the previous owner's flag and token go.
        for (const c of clients.values()) {
          c.webOwnerFlag = false;
          c.token = undefined;
        }
        const c = clients.get(ws)!;
        c.webOwnerFlag = true;
        c.token = r.token;
      } else claimError = r.error;
      sendState(ws, claimError);
    };
    ws.on("message", (raw: RawData) => {
      const msg = parseDoomMessage(raw.toString());
      if (!msg) return;
      let claimError: string | undefined;
      // Enforced here, not only in the session: a mirror's key, claim, volume
      // or takeover is dropped before it gets anywhere near the engine.
      if (!doomMessageAllowed(msg, viewFor(ws))) {
        if (msg.type === "play-here") claimError = "Otro dispositivo ya juega desde la web";
        if (msg.type === "stop") claimError = "Solo quien juega puede salir";
        sendState(ws, claimError);
        return;
      }
      if (msg.type === "play-here") {
        void playHere();
        return;
      }
      if (msg.type === "claim") {
        if (!session.tokenValid(msg.token)) claimError = "Token inválido o vencido";
        else if (!session.claim(id, msg.token)) claimError = "Otro control ya juega";
      } else if (msg.type === "release") session.release(id);
      else if (msg.type === "key") session.key(id, msg.key, msg.down);
      else if (msg.type === "stream") clients.get(ws)!.streaming = msg.on;
      else if (msg.type === "volume") session.setVolume(clampVolume(msg.value));
      else if (msg.type === "stop") session.stop();
      sendState(ws, claimError);
    });
    ws.on("close", () => dropClient(ws));
    // A malformed frame emits 'error' on the socket. Without a listener Node
    // throws and takes the whole Akbal process down, so the error only drops
    // this client.
    ws.on("error", (err: Error) => {
      console.warn("[DOOM] socket error:", err.message);
      dropClient(ws);
    });
  });
}
