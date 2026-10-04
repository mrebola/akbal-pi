import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { WebSocketServer, WebSocket } from "ws";
import { parseDoomMessage, attachDoomSocket, shouldEncodeNow, canSendTo, isDeadSocket } from "./doom-routes";
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
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom");

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
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom");

  const client = fakeClient();
  wss.emit("connection", client as unknown as WebSocket);
  client.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: "0".repeat(32) })));
  assert.equal(session.state().controller, false);
});

test("only the holder's keys reach the engine", async () => {
  const { session, written, token } = makeSession();
  const wss = new EventEmitter();
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom");

  const holder = fakeClient();
  const watcher = fakeClient();
  wss.emit("connection", holder as unknown as WebSocket);
  wss.emit("connection", watcher as unknown as WebSocket);
  holder.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: token() })));

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
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom");

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
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { heartbeatMs: 10 });

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
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom", { heartbeatMs: 10 });

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
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom");

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
  attachDoomSocket(wss as unknown as WebSocketServer, session, () => "http://pi.test:8090/doom");

  const client = fakeClient();
  wss.emit("connection", client as unknown as WebSocket);
  client.emit("message", Buffer.from(JSON.stringify({ type: "claim", token: "0".repeat(32) })));
  const s = lastState(client);
  assert.equal(s.controller, false);
  assert.equal(s.error, "Token inválido o vencido");
});
