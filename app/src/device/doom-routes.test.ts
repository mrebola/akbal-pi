import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { WebSocketServer, WebSocket } from "ws";
import { parseDoomMessage, attachDoomSocket, shouldEncodeNow, canSendTo, isDeadSocket, doomMessageAllowed, decideStartForPlayHere } from "./doom-routes";
import { DoomSession, EngineProcess } from "../doom/session";
import { ControlTokens } from "../doom/tokens";
import { ControllerLock } from "../doom/control";

test("parses claim, release, key and stream", () => {
  assert.deepEqual(parseDoomMessage('{"type":"claim","token":"abc"}'), { type: "claim", token: "abc" });
  assert.deepEqual(parseDoomMessage('{"type":"release"}'), { type: "release" });
  assert.deepEqual(parseDoomMessage('{"type":"key","key":"fire","down":true}'), { type: "key", key: "fire", down: true });
  assert.deepEqual(parseDoomMessage('{"type":"stream","on":false}'), { type: "stream", on: false });
});

test("rejects unknown types, unknown keys and broken JSON", () => {
  assert.equal(parseDoomMessage('{"type":"hack"}'), null);
  assert.equal(parseDoomMessage('{"type":"key","key":"nuke","down":true}'), null);
  assert.equal(parseDoomMessage("no es json"), null);
  assert.equal(parseDoomMessage('{"type":"key","key":"fire","down":"yes"}'), null);
});

// Fake engine whose stdin records what the session writes.
function makeSession() {
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (d) => written.push(String(d)));
  const engine: EngineProcess = {
    stdout: new PassThrough(),
    stdin,
    audio: new PassThrough(),
    control: new PassThrough(),
    kill: () => {},
    onExit: () => {},
  };
  const tokens = new ControlTokens();
  const lock = new ControllerLock();
  const session = new DoomSession({
    spawnEngine: () => engine,
    tokens,
    lock,
    binaryExists: () => true,
    wadExists: () => true,
  });
  return { session, written, token: () => session.start().token! };
}

// Minimal stand-ins for a ws client and the server: enough for attachDoomSocket,
// which only uses on(), send() and readyState.
function fakeClient() {
  const ee = new EventEmitter() as EventEmitter & {
    readyState: number;
    bufferedAmount: number;
    send: (d: unknown) => void;
    ping: () => void;
    terminate: () => void;
    terminated: boolean;
    sent: string[];
  };
  ee.readyState = 1;
  ee.bufferedAmount = 0;
  ee.terminated = false;
  ee.sent = [];
  ee.send = (d: unknown) => {
    ee.sent.push(String(d));
  };
  // A silent client: pings go nowhere, so no pong ever arrives.
  ee.ping = () => {};
  ee.terminate = () => {
    ee.terminated = true;
  };
  return ee;
}

function lastState(ws: { sent: string[] }): Record<string, unknown> {
  return JSON.parse(ws.sent[ws.sent.length - 1]);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("claim with the valid token takes the controller; close releases it", async () => {
  const { session, token } = makeSession();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });

  const client = fakeClient();
  wss.emit("connection", client as unknown as WebSocket);
  client.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: token() })));
  assert.equal(session.state().controller, true);

  client.emit("close");
  assert.equal(session.state().controller, false, "closing the socket must release the controller");
});

test("a claim with a wrong token does not take the controller", () => {
  const { session } = makeSession();
  session.start();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });

  const client = fakeClient();
  wss.emit("connection", client as unknown as WebSocket);
  client.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: "0".repeat(32) })));
  assert.equal(session.state().controller, false);
});

test("only the holder's keys reach the engine", async () => {
  const { session, written, token } = makeSession();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });

  const holder = fakeClient();
  const watcher = fakeClient();
  wss.emit("connection", holder as unknown as WebSocket);
  wss.emit("connection", watcher as unknown as WebSocket);
  holder.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: token() })));
  // The engine's startup "volume" line is not key traffic; start from a clean slate.
  written.length = 0;

  watcher.emit("message", Buffer.from(JSON.stringify({ type: "key", key: "fire", down: true })));
  await tick();
  assert.equal(written.length, 0, "a non-holder key must not reach the engine");

  holder.emit("message", Buffer.from(JSON.stringify({ type: "key", key: "fire", down: true })));
  await tick();
  assert.equal(written.length, 1, "the holder's key must reach the engine");
});

test("a socket error cleans up like close and does not throw", () => {
  const { session, token } = makeSession();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });

  const client = fakeClient();
  wss.emit("connection", client as unknown as WebSocket);
  client.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: token() })));
  assert.equal(session.state().controller, true);

  // Without an 'error' listener EventEmitter throws here, which is what a
  // malformed frame would do to the whole Akbal process.
  assert.doesNotThrow(() => client.emit("error", new Error("frame malformado")));
  assert.equal(session.state().controller, false, "an error must release the controller like close does");

  // The client was dropped: a later state change must not be sent to it.
  const before = client.sent.length;
  session.start();
  assert.equal(client.sent.length, before, "a dropped client must not get more messages");
});

test("encodes at most every 100 ms", () => {
  assert.equal(shouldEncodeNow(0, 50), false);
  assert.equal(shouldEncodeNow(0, 100), true);
  assert.equal(shouldEncodeNow(1000, 1099), false);
  assert.equal(shouldEncodeNow(1000, 1100), true);
});

test("skips a socket whose send buffer is over 256 KiB", () => {
  assert.equal(canSendTo(0), true);
  assert.equal(canSendTo(256 * 1024), true);
  assert.equal(canSendTo(256 * 1024 + 1), false);
});

test("a client that never answers a ping is dropped and its control released", async () => {
  const { session, token } = makeSession();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { heartbeatMs: 10, isAdminSession: () => true });

  const client = fakeClient();
  wss.emit("connection", client as unknown as WebSocket);
  client.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: token() })));
  assert.equal(session.state().controller, true);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(client.terminated, true, "a silent client must be terminated");
  assert.equal(session.state().controller, false, "a dead client must release its control");
});

test("a client that answers pings keeps its control", async () => {
  const { session, token } = makeSession();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { heartbeatMs: 10, isAdminSession: () => true });

  const client = fakeClient();
  client.ping = () => client.emit("pong");
  wss.emit("connection", client as unknown as WebSocket);
  client.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: token() })));

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(client.terminated, false);
  assert.equal(session.state().controller, true);
});

test("isDeadSocket: a socket is dead when it did not answer the last ping", () => {
  assert.equal(isDeadSocket(true), false);
  assert.equal(isDeadSocket(false), true);
});

test("each client is told whether it holds the control", () => {
  const { session, token } = makeSession();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });

  const holder = fakeClient();
  const other = fakeClient();
  wss.emit("connection", holder as unknown as WebSocket);
  wss.emit("connection", other as unknown as WebSocket);
  holder.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: token() })));
  other.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: token() })));

  const h = lastState(holder);
  assert.equal(h.controller, true);
  assert.equal(h.controlled, true);
  assert.equal(h.error, null);

  const o = lastState(other);
  assert.equal(o.controller, false, "the second client must not look like the holder");
  assert.equal(o.controlled, true, "someone holds the control");
  assert.equal(o.error, "Otro control ya juega");
});

test("a claim with an invalid token says so", () => {
  const { session } = makeSession();
  session.start();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });

  const client = fakeClient();
  wss.emit("connection", client as unknown as WebSocket);
  client.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: "0".repeat(32) })));
  const s = lastState(client);
  assert.equal(s.controller, false);
  assert.equal(s.error, "Token inválido o vencido");
});

test("parses play-here and volume", () => {
  assert.deepEqual(parseDoomMessage('{"type":"play-here"}'), { type: "play-here" });
  assert.deepEqual(parseDoomMessage('{"type":"volume","value":65}'), { type: "volume", value: 65 });
});

test("rejects a volume message without a number", () => {
  assert.equal(parseDoomMessage('{"type":"volume","value":"alto"}'), null);
});

test("mirrors may not send key or claim while the web plays", () => {
  const mirror = { owner: "web" as const, isWebOwner: false, webOwnerOnline: true, adminSession: true, controller: false };
  assert.equal(doomMessageAllowed({ type: "key", key: "fire", down: true }, mirror), false);
  assert.equal(doomMessageAllowed({ type: "claim", token: "t" }, mirror), false);
});

test("volume needs an admin session or the controller; a plain socket cannot change it", () => {
  const plain = { owner: "web" as const, isWebOwner: false, webOwnerOnline: true, adminSession: false, controller: false };
  assert.equal(doomMessageAllowed({ type: "volume", value: 20 }, plain), false);
  assert.equal(doomMessageAllowed({ type: "volume", value: 20 }, { ...plain, controller: true }), true, "the holder of the control");
  assert.equal(doomMessageAllowed({ type: "volume", value: 20 }, { ...plain, adminSession: true }), true, "an admin session");
});

test("the web owner may send key, claim and volume", () => {
  const owner = { owner: "web" as const, isWebOwner: true, webOwnerOnline: true, adminSession: true, controller: false };
  assert.equal(doomMessageAllowed({ type: "key", key: "fire", down: true }, owner), true);
  assert.equal(doomMessageAllowed({ type: "claim", token: "t" }, owner), true);
  assert.equal(doomMessageAllowed({ type: "volume", value: 20 }, owner), true);
});

test("a second web tab cannot take play-here from the web owner", () => {
  const other = { owner: "web" as const, isWebOwner: false, webOwnerOnline: true, adminSession: true, controller: false };
  assert.equal(doomMessageAllowed({ type: "play-here" }, other), false);
});

test("a web client may take play-here from the Pi", () => {
  assert.equal(doomMessageAllowed({ type: "play-here" }, { owner: "pi", isWebOwner: false, webOwnerOnline: false, adminSession: true, controller: false }), true);
});

test("release and stream are always allowed", () => {
  const mirror = { owner: "pi" as const, isWebOwner: false, webOwnerOnline: false, adminSession: true, controller: false };
  assert.equal(doomMessageAllowed({ type: "release" }, mirror), true);
  assert.equal(doomMessageAllowed({ type: "stream", on: true }, mirror), true);
});

test("a volume change from the web owner reaches the session and every state", () => {
  const { session } = makeSession();
  session.start();
  const wss = new EventEmitter();
  // Only the cookie "none" lacks an admin session; the owner connects without one.
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", {
    isAdminSession: (req) => req?.headers?.cookie !== "none",
  });

  const owner = fakeClient();
  const mirror = fakeClient();
  wss.emit("connection", owner as unknown as WebSocket);
  wss.emit("connection", mirror as unknown as WebSocket, { headers: { cookie: "none" } });

  owner.emit("message", Buffer.from(JSON.stringify({ type: "play-here" })));
  assert.equal(session.owner(), "web");
  assert.equal(lastState(owner).mirror, false);
  assert.equal(typeof lastState(owner).token, "string", "the web owner gets the token");
  assert.equal(lastState(mirror).mirror, true);
  assert.equal(lastState(mirror).token, undefined, "a mirror never gets the token");

  mirror.emit("message", Buffer.from(JSON.stringify({ type: "volume", value: 20 })));
  assert.equal(session.volume(), 60, "a mirror's volume must not reach the session");

  owner.emit("message", Buffer.from(JSON.stringify({ type: "volume", value: 20 })));
  assert.equal(session.volume(), 20);
  assert.equal(lastState(owner).volume, 20);
  assert.equal(lastState(mirror).volume, 20, "every client sees the new volume");
});

test("a takeover is allowed when the web owner's socket is gone", () => {
  const stale = { owner: "web" as const, isWebOwner: false, webOwnerOnline: false, adminSession: true, controller: false };
  assert.equal(doomMessageAllowed({ type: "play-here" }, stale), true);
});

test("a mirror's play-here is refused while the web owns the game", () => {
  const { session } = makeSession();
  session.start();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });

  const owner = fakeClient();
  const other = fakeClient();
  wss.emit("connection", owner as unknown as WebSocket);
  wss.emit("connection", other as unknown as WebSocket);
  owner.emit("message", Buffer.from(JSON.stringify({ type: "play-here" })));
  const before = session.owner();
  const tokenBefore = session.state();

  other.emit("message", Buffer.from(JSON.stringify({ type: "play-here" })));
  assert.equal(session.owner(), before);
  assert.equal(session.state().running, tokenBefore.running);
  assert.equal(typeof lastState(other).error, "string");
  assert.equal(lastState(other).token, undefined);
});

test("play-here from the Pi's owner is passed through and the web owns it", async () => {
  const { session } = makeSession();
  session.start();
  session.claimOwner("pi");
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });

  const client = fakeClient();
  wss.emit("connection", client as unknown as WebSocket);
  client.emit("message", Buffer.from(JSON.stringify({ type: "play-here" })));
  await tick();
  assert.equal(session.owner(), "web");
  assert.equal(lastState(client).mirror, false);
});

test("decideStartForPlayHere starts the engine only when no game runs", () => {
  assert.equal(decideStartForPlayHere(false), "start");
  assert.equal(decideStartForPlayHere(true), "claim-only");
});

test("play-here starts the engine when no game runs and leaves the web owning it", async () => {
  const { session } = makeSession();
  assert.equal(session.state().running, false);
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });

  const client = fakeClient();
  wss.emit("connection", client as unknown as WebSocket);
  client.emit("message", Buffer.from(JSON.stringify({ type: "play-here" })));
  await tick();
  assert.equal(session.state().running, true, "play-here must start the engine");
  assert.equal(session.owner(), "web");
  assert.equal(lastState(client).mirror, false);
  assert.equal(lastState(client).error, null);
});

test("play-here reports the start error and keeps the owner when the engine cannot start", async () => {
  const session = new DoomSession({
    spawnEngine: () => { throw new Error("no debe llamarse"); },
    tokens: new ControlTokens(),
    lock: new ControllerLock(),
    binaryExists: () => true,
    wadExists: () => false,
  });
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });

  const client = fakeClient();
  wss.emit("connection", client as unknown as WebSocket);
  client.emit("message", Buffer.from(JSON.stringify({ type: "play-here" })));
  await tick();
  assert.equal(session.state().running, false);
  assert.equal(session.owner(), null);
  assert.match(String(lastState(client).error), /Falta el WAD/);
});

test("parses stop", () => {
  assert.deepEqual(parseDoomMessage('{"type":"stop"}'), { type: "stop" });
});

test("only the web owner may stop", () => {
  const owner = { owner: "web" as const, isWebOwner: true, webOwnerOnline: true, adminSession: true, controller: false };
  const mirror = { owner: "web" as const, isWebOwner: false, webOwnerOnline: true, adminSession: true, controller: false };
  const piMirror = { owner: "pi" as const, isWebOwner: false, webOwnerOnline: false, adminSession: true, controller: false };
  assert.equal(doomMessageAllowed({ type: "stop" }, owner), true);
  assert.equal(doomMessageAllowed({ type: "stop" }, mirror), false);
  assert.equal(doomMessageAllowed({ type: "stop" }, piMirror), false);
});

test("the web owner's stop ends the game for everyone", () => {
  const { session } = makeSession();
  session.start();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });

  const owner = fakeClient();
  const mirror = fakeClient();
  wss.emit("connection", owner as unknown as WebSocket);
  wss.emit("connection", mirror as unknown as WebSocket);
  owner.emit("message", Buffer.from(JSON.stringify({ type: "play-here" })));

  owner.emit("message", Buffer.from(JSON.stringify({ type: "stop" })));
  assert.equal(session.state().running, false);
  assert.equal(session.owner(), null);
  assert.equal(lastState(owner).running, false);
  assert.equal(lastState(mirror).running, false, "every client gets the new state");
});

test("a mirror's stop is refused with a clear message and the game keeps running", () => {
  const { session } = makeSession();
  session.start();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });

  const owner = fakeClient();
  const mirror = fakeClient();
  wss.emit("connection", owner as unknown as WebSocket);
  wss.emit("connection", mirror as unknown as WebSocket);
  owner.emit("message", Buffer.from(JSON.stringify({ type: "play-here" })));

  mirror.emit("message", Buffer.from(JSON.stringify({ type: "stop" })));
  assert.equal(session.state().running, true);
  assert.equal(session.owner(), "web");
  assert.equal(lastState(mirror).error, "Solo quien juega puede salir");
});

test("with the Pi as owner, a phone with the QR token takes the control", () => {
  const { session } = makeSession();
  session.start();
  const piToken = session.claimOwner("pi").token!;
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });

  const phone = fakeClient();
  wss.emit("connection", phone as unknown as WebSocket);
  assert.equal(lastState(phone).mirror, false, "with the Pi as owner nobody is a mirror");
  phone.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: piToken })));
  assert.equal(session.state().controller, true, "the QR token must take the control");
  assert.equal(lastState(phone).controller, true);
});

test("with the Pi as owner, a claim with a bad token is refused", () => {
  const { session } = makeSession();
  session.start();
  session.claimOwner("pi");
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });

  const phone = fakeClient();
  wss.emit("connection", phone as unknown as WebSocket);
  phone.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: "0".repeat(32) })));
  assert.equal(session.state().controller, false);
  assert.match(String(lastState(phone).error), /Token inválido/);
});

test("the state carries the audio and music errors when the player reports them", () => {
  let reportAudio: (m: string) => void = () => {};
  let reportMusic: (m: string) => void = () => {};
  const session = new DoomSession({
    spawnEngine: () => fakeEngineFor(),
    tokens: new ControlTokens(),
    lock: new ControllerLock(),
    binaryExists: () => true,
    wadExists: () => true,
    openAudio: (onError) => {
      reportAudio = onError;
      return { start: () => {}, write: () => {}, stop: () => {} };
    },
    openMusic: (onError) => {
      reportMusic = onError;
      return { handle: () => {}, setGain: () => {}, stop: () => {} };
    },
  });
  session.start();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });
  const client = fakeClient();
  wss.emit("connection", client as unknown as WebSocket);
  assert.equal(lastState(client).audioError, null);
  assert.equal(lastState(client).musicError, null);

  reportAudio("sin dispositivo de audio");
  assert.equal(lastState(client).audioError, "sin dispositivo de audio");
  reportMusic("no hay reproductor de música");
  assert.equal(lastState(client).musicError, "no hay reproductor de música");
});

function fakeEngineFor(): EngineProcess {
  return { stdout: new PassThrough(), stdin: new PassThrough(), audio: new PassThrough(), control: new PassThrough(), kill: () => {}, onExit: () => {} };
}

test("play-here refuses to start the engine when the daemon owns the panel", async () => {
  const { session } = makeSession();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", {
    isAdminSession: () => true,
    daemonBlockedReason: async () => "DOOM requiere la pantalla directa; el daemon está activo",
  });
  const client = fakeClient();
  wss.emit("connection", client as unknown as WebSocket);
  client.emit("message", Buffer.from(JSON.stringify({ type: "play-here" })));
  await tick();
  assert.equal(session.state().running, false, "the engine must not start");
  assert.equal(session.owner(), null);
  assert.match(String(lastState(client).error), /daemon está activo/);
});

test("play-here starts the engine when the daemon is not active", async () => {
  const { session } = makeSession();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", {
    isAdminSession: () => true,
    daemonBlockedReason: async () => null,
  });
  const client = fakeClient();
  wss.emit("connection", client as unknown as WebSocket);
  client.emit("message", Buffer.from(JSON.stringify({ type: "play-here" })));
  await tick();
  assert.equal(session.state().running, true);
  assert.equal(session.owner(), "web");
});

test("parses play-here with a game, and rejects an unknown game", () => {
  assert.deepEqual(parseDoomMessage('{"type":"play-here","game":"freedoom1"}'), { type: "play-here", game: "freedoom1" });
  assert.deepEqual(parseDoomMessage('{"type":"play-here"}'), { type: "play-here" });
  assert.equal(parseDoomMessage('{"type":"play-here","game":"doom2"}'), null);
});

test("play-here with a game starts that game and the state names it", async () => {
  const seen: string[] = [];
  const session = new DoomSession({
    spawnEngine: (game: string) => { seen.push(game); return fakeEngineFor(); },
    tokens: new ControlTokens(),
    lock: new ControllerLock(),
    binaryExists: () => true,
    wadExists: () => true,
  });
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });
  const client = fakeClient();
  wss.emit("connection", client as unknown as WebSocket);
  client.emit("message", Buffer.from(JSON.stringify({ type: "play-here", game: "freedoom1" })));
  await tick();
  assert.deepEqual(seen, ["freedoom1"]);
  assert.equal(lastState(client).game, "freedoom1");
  assert.equal(lastState(client).closed, false);
});

test("the web's stop reports closed and no game", async () => {
  const { session } = makeSession();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { isAdminSession: () => true });
  const owner = fakeClient();
  wss.emit("connection", owner as unknown as WebSocket);
  owner.emit("message", Buffer.from(JSON.stringify({ type: "play-here" })));
  await tick();
  owner.emit("message", Buffer.from(JSON.stringify({ type: "stop" })));
  assert.equal(lastState(owner).running, false);
  assert.equal(lastState(owner).closed, true);
  assert.equal(lastState(owner).game, null);
});

test("play-here, volume and stop need an admin session; claim and key do not", () => {
  const noSession = { owner: "web" as const, isWebOwner: false, webOwnerOnline: false, adminSession: false, controller: false };
  assert.equal(doomMessageAllowed({ type: "play-here" }, noSession), false);
  assert.equal(doomMessageAllowed({ type: "volume", value: 20 }, { ...noSession, owner: "web", isWebOwner: true }), false);
  assert.equal(doomMessageAllowed({ type: "stop" }, { ...noSession, owner: "web", isWebOwner: true }), false);
  assert.equal(doomMessageAllowed({ type: "claim", token: "t" }, { owner: "pi", isWebOwner: false, webOwnerOnline: false, adminSession: false, controller: false }), true);
  assert.equal(doomMessageAllowed({ type: "key", key: "fire", down: true }, { owner: "pi", isWebOwner: false, webOwnerOnline: false, adminSession: false, controller: false }), true);
});

test("a socket without an admin session is told so, and its owner actions do nothing", async () => {
  const { session } = makeSession();
  session.start();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", {
    isAdminSession: () => false,
  });
  const phone = fakeClient();
  wss.emit("connection", phone as unknown as WebSocket, { headers: {} });
  phone.emit("message", Buffer.from(JSON.stringify({ type: "play-here" })));
  await tick();
  assert.equal(session.owner(), null, "play-here without a session must not take the game");
  assert.equal(lastState(phone).error, "Inicia sesión en el admin");

  session.claimOwner("pi");
  phone.emit("message", Buffer.from(JSON.stringify({ type: "volume", value: 20 })));
  assert.equal(session.volume(), 60, "volume without a session must not change");
  assert.equal(lastState(phone).error, "Inicia sesión en el admin");

  phone.emit("message", Buffer.from(JSON.stringify({ type: "stop" })));
  assert.equal(session.state().running, true, "stop without a session must not end the game");
  assert.equal(lastState(phone).error, "Inicia sesión en el admin");
});

test("the admin session is read from the connection's cookie, on every message", async () => {
  let loggedIn = true;
  const { session } = makeSession();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", {
    isAdminSession: (req) => loggedIn && req.headers.cookie === "akbal_session=ok",
  });
  const admin = fakeClient();
  wss.emit("connection", admin as unknown as WebSocket, { headers: { cookie: "akbal_session=ok" } });
  admin.emit("message", Buffer.from(JSON.stringify({ type: "play-here" })));
  await tick();
  assert.equal(session.owner(), "web", "a socket with the session may play here");

  loggedIn = false;
  admin.emit("message", Buffer.from(JSON.stringify({ type: "stop" })));
  assert.equal(session.state().running, true, "after the admin logs out the socket loses its rights");
});

test("claim with the QR token works without an admin session", () => {
  const { session } = makeSession();
  session.start();
  const piToken = session.claimOwner("pi").token!;
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", {
    isAdminSession: () => false,
  });
  const phone = fakeClient();
  wss.emit("connection", phone as unknown as WebSocket, { headers: {} });
  phone.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: piToken })));
  assert.equal(session.state().controller, true);
});

test("the holder of the control changes the volume without an admin session; a plain socket cannot", () => {
  const { session } = makeSession();
  session.start();
  const piToken = session.claimOwner("pi").token!;
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", {
    isAdminSession: () => false,
  });
  const holder = fakeClient();
  const plain = fakeClient();
  wss.emit("connection", holder as unknown as WebSocket, { headers: {} });
  wss.emit("connection", plain as unknown as WebSocket, { headers: {} });
  holder.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: piToken })));
  assert.equal(session.state().controller, true);

  plain.emit("message", Buffer.from(JSON.stringify({ type: "volume", value: 20 })));
  assert.equal(session.volume(), 60, "a socket with no control and no session must not change the volume");

  holder.emit("message", Buffer.from(JSON.stringify({ type: "volume", value: 20 })));
  assert.equal(session.volume(), 20, "the holder of the control may change the volume");
});
