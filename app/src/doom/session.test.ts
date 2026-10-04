import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { DoomSession, EngineProcess } from "./session";
import { ControlTokens } from "./tokens";
import { ControllerLock } from "./control";
import { FRAME_BYTES } from "./frame-reader";

function fakeEngine() {
  const stdout = new PassThrough();
  const written: string[] = [];
  const stdin = new PassThrough();
  stdin.on("data", (d) => written.push(String(d)));
  let exitCb: (code: number | null) => void = () => {};
  let killed = false;
  const engine: EngineProcess = {
    stdout,
    stdin,
    kill: () => { killed = true; exitCb(null); },
    onExit: (cb) => { exitCb = cb; },
  };
  return { engine, stdout, written, wasKilled: () => killed, crash: () => exitCb(1) };
}

function makeSession(overrides: Partial<ConstructorParameters<typeof DoomSession>[0]> = {}) {
  const fake = fakeEngine();
  let spawns = 0;
  const session = new DoomSession({
    spawnEngine: () => { spawns++; return fake.engine; },
    tokens: new ControlTokens(),
    lock: new ControllerLock(),
    binaryExists: () => true,
    wadExists: () => true,
    ...overrides,
  });
  return { session, fake, spawns: () => spawns };
}

test("start spawns the engine once and returns a token", () => {
  const { session, spawns } = makeSession();
  const a = session.start();
  const b = session.start();
  assert.equal(a.ok, true);
  assert.match(a.token!, /^[0-9a-f]{32}$/);
  assert.equal(b.ok, true);
  assert.equal(spawns(), 1, "second start must reuse the running engine");
});

test("start refuses with a clear message when the WAD is missing", () => {
  const { session, spawns } = makeSession({ wadExists: () => false });
  const r = session.start();
  assert.equal(r.ok, false);
  assert.match(r.error!, /fetch-doom-wad\.sh/);
  assert.equal(spawns(), 0);
});

test("start refuses with a clear message when the binary is missing", () => {
  const { session } = makeSession({ binaryExists: () => false });
  const r = session.start();
  assert.equal(r.ok, false);
  assert.match(r.error!, /fetch-doom-engine\.sh/);
});

test("frames from the engine reach frame listeners", () => {
  const { session, fake } = makeSession();
  session.start();
  const got: Buffer[] = [];
  session.onFrame((f) => got.push(f));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(FRAME_BYTES);
  fake.stdout.write(Buffer.concat([header, Buffer.alloc(FRAME_BYTES, 3)]));
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.equal(got.length, 1);
    resolve();
  }));
});

test("only the claimed client's keys reach the engine", () => {
  const { session, fake } = makeSession();
  const { token } = session.start();
  assert.equal(session.claim("a", token!), true);
  assert.equal(session.key("b", "fire", true), false);
  assert.equal(session.key("a", "fire", true), true);
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.match(fake.written.join(""), /down 163/);
    resolve();
  }));
});

test("a claim with a bad token is refused", () => {
  const { session } = makeSession();
  session.start();
  assert.equal(session.claim("a", "0".repeat(32)), false);
});

test("stop kills the engine and revokes the token", () => {
  const { session, fake } = makeSession();
  const { token } = session.start();
  session.stop();
  assert.equal(fake.wasKilled(), true);
  assert.equal(session.claim("a", token!), false);
  assert.equal(session.state().running, false);
});

test("a crash sets an error and frees the control", () => {
  const { session, fake } = makeSession();
  const { token } = session.start();
  session.claim("a", token!);
  fake.crash();
  assert.equal(session.state().running, false);
  assert.match(session.state().error!, /motor/i);
  assert.equal(session.state().controller, false);
});
