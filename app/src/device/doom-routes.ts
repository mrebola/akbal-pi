import { WebSocketServer, WebSocket, RawData } from "ws";
import { randomUUID } from "node:crypto";
import { DoomSession, DoomState } from "../doom/session";
import { DOOM_KEYS, DoomKey } from "../doom/keymap";
import { encodeFrameJpeg } from "../doom/frame-jpeg";

export type DoomClientMessage =
  | { type: "claim"; token: string }
  | { type: "release" }
  | { type: "key"; key: DoomKey; down: boolean }
  | { type: "stream"; on: boolean };

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
  return null;
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
}

// Every socket gets state. Only sockets that asked for video get JPEG frames,
// so an idle Pi with no viewers encodes nothing.
export function attachDoomSocket(
  wss: WebSocketServer,
  session: DoomSession,
  screenUrl: () => string,
  options: DoomSocketOptions = {},
): void {
  const clients = new Map<WebSocket, { id: string; streaming: boolean; alive: boolean }>();

  // The claim error (bad token, busy controller) goes only to the socket that
  // sent the claim. Broadcasts carry the engine's own error, if any.
  const sendState = (ws: WebSocket, claimError?: string) => {
    const s: DoomState = session.state();
    const c = clients.get(ws);
    ws.send(
      JSON.stringify({
        type: "state",
        running: s.running,
        controller: c ? session.isController(c.id) : false,
        controlled: s.controller,
        error: claimError ?? s.error,
        streaming: c?.streaming ?? false,
        url: screenUrl(),
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
    clients.set(ws, { id, streaming: false, alive: true });
    ws.on("pong", () => {
      const c = clients.get(ws);
      if (c) c.alive = true;
    });
    sendState(ws);
    ws.on("message", (raw: RawData) => {
      const msg = parseDoomMessage(raw.toString());
      if (!msg) return;
      let claimError: string | undefined;
      if (msg.type === "claim") {
        if (!session.tokenValid(msg.token)) claimError = "Token inválido o vencido";
        else if (!session.claim(id, msg.token)) claimError = "Otro control ya juega";
      } else if (msg.type === "release") session.release(id);
      else if (msg.type === "key") session.key(id, msg.key, msg.down);
      else if (msg.type === "stream") clients.get(ws)!.streaming = msg.on;
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
