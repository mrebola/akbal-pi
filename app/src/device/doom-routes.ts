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

// Every socket gets state. Only sockets that asked for video get JPEG frames,
// so an idle Pi with no viewers encodes nothing.
export function attachDoomSocket(wss: WebSocketServer, session: DoomSession, screenUrl: () => string): void {
  const clients = new Map<WebSocket, { id: string; streaming: boolean }>();

  const sendState = (ws: WebSocket) => {
    const s: DoomState = session.state();
    ws.send(JSON.stringify({ type: "state", ...s, streaming: clients.get(ws)?.streaming ?? false, url: screenUrl() }));
  };

  session.onState(() => clients.forEach((_, ws) => sendState(ws)));
  session.onFrame((rgb565) => {
    const wanting = [...clients].filter(([, c]) => c.streaming);
    if (wanting.length === 0) return;
    const jpg = encodeFrameJpeg(rgb565);
    for (const [ws] of wanting) if (ws.readyState === WebSocket.OPEN) ws.send(jpg);
  });

  wss.on("connection", (ws: WebSocket) => {
    const id = randomUUID();
    clients.set(ws, { id, streaming: false });
    sendState(ws);
    ws.on("message", (raw: RawData) => {
      const msg = parseDoomMessage(raw.toString());
      if (!msg) return;
      if (msg.type === "claim") session.claim(id, msg.token);
      else if (msg.type === "release") session.release(id);
      else if (msg.type === "key") session.key(id, msg.key, msg.down);
      else if (msg.type === "stream") clients.get(ws)!.streaming = msg.on;
      sendState(ws);
    });
    ws.on("close", () => {
      session.release(id);
      clients.delete(ws);
    });
  });
}
