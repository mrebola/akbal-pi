import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { WebSocketServer, WebSocket } from "ws";
import { parseDoomMessage, attachDoomSocket } from "./doom-routes";
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
  const ee = new EventEmitter() as EventEmitter & { readyState: number; send: (d: unknown) => void; sent: string[] };
  ee.readyState = 1;
  ee.sent = [];
  ee.send = (d: unknown) => {
    ee.sent.push(String(d));
  };
  return ee;
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
