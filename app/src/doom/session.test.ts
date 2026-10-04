import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { DoomSession, EngineProcess } from "./session";
import { ControlTokens } from "./tokens";
import { ControllerLock } from "./control";
import { FRAME_BYTES } from "./frame-reader";
import { VOLUME_DEFAULT } from "./volume";

function fakeEngine() {
  const stdout = new PassThrough();
  const written: string[] = [];
  const stdin = new PassThrough();
  stdin.on("data", (d) => written.push(String(d)));
  let exitCb: (code: number | null) => void = () => {};
  let killed = false;
  const audio = new PassThrough();
  const control = new PassThrough();
  const engine: EngineProcess = {
    stdout,
    stdin,
    audio,
    control,
    kill: () => { killed = true; exitCb(null); },
    onExit: (cb) => { exitCb = cb; },
  };
  return { engine, stdin, stdout, audio, control, written, wasKilled: () => killed, crash: () => exitCb(1) };
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

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("an error on the engine's stdin ends the session without throwing", () => {
  const { session, fake } = makeSession();
  session.start();
  assert.doesNotThrow(() => fake.stdin.emit("error", new Error("EPIPE")));
  assert.equal(session.state().running, false);
  assert.match(session.state().error!, /detuvo/);
  assert.equal(fake.wasKilled(), true);
});

test("an error on the engine's stdout ends the session without throwing", () => {
  const { session, fake } = makeSession();
  session.start();
  assert.doesNotThrow(() => fake.stdout.emit("error", new Error("EIO")));
  assert.equal(session.state().running, false);
  assert.match(session.state().error!, /detuvo/);
});

test("key after the engine's stdin has closed does not throw", async () => {
  const { session, fake } = makeSession();
  const { token } = session.start();
  session.claim("a", token!);
  fake.stdin.end();
  assert.doesNotThrow(() => session.key("a", "fire", true));
  await flush();
  assert.equal(session.state().running, false);
});

test("releasing the controller sends up for keys still held", async () => {
  const { session, fake } = makeSession();
  const { token } = session.start();
  session.claim("a", token!);
  session.key("a", "fire", true);
  session.release("a");
  await flush();
  assert.match(fake.written.join(""), /up 163\n/);
});

test("a key released before the controller lets go is not sent up twice", async () => {
  const { session, fake } = makeSession();
  const { token } = session.start();
  session.claim("a", token!);
  session.key("a", "fire", true);
  session.key("a", "fire", false);
  session.release("a");
  await flush();
  assert.equal(fake.written.join("").split("up 163\n").length - 1, 1);
});

test("a crash sends up for keys still held", async () => {
  const { session, fake } = makeSession();
  const { token } = session.start();
  session.claim("a", token!);
  session.key("a", "fire", true);
  fake.crash();
  await flush();
  assert.match(fake.written.join(""), /up 163\n/);
});

test("stop sends up for keys still held before killing the engine", async () => {
  const { session, fake } = makeSession();
  const { token } = session.start();
  session.claim("a", token!);
  session.key("a", "fire", true);
  session.stop();
  await flush();
  assert.match(fake.written.join(""), /up 163\n/);
  assert.equal(fake.wasKilled(), true);
});

test("owner is null until someone claims it, and stop clears it", () => {
  const { session } = makeSession();
  session.start();
  assert.equal(session.owner(), null);
  const r = session.claimOwner("pi");
  assert.equal(r.ok, true);
  assert.equal(session.owner(), "pi");
  session.stop();
  assert.equal(session.owner(), null);
});

test("claimOwner refuses when no game is running", () => {
  const { session } = makeSession();
  const r = session.claimOwner("web");
  assert.equal(r.ok, false);
  assert.match(r.error!, /No hay juego/);
});

test("switching owner releases held keys and revokes the old token", () => {
  const { session, fake } = makeSession();
  session.start();
  const pi = session.claimOwner("pi").token!;
  session.claim("pi-client", pi);
  session.key("pi-client", "fire", true);
  const second = session.claimOwner("web");
  assert.equal(second.ok, true);
  assert.notEqual(second.token, pi);
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.match(fake.written.join(""), /up 163/);
    assert.equal(session.claim("pi-client", pi), false);
    resolve();
  }));
});

test("switching owner also takes the controller lock away from the old holder", () => {
  const { session } = makeSession();
  session.start();
  const pi = session.claimOwner("pi").token!;
  session.claim("pi-client", pi);
  assert.equal(session.isController("pi-client"), true);
  session.claimOwner("web");
  assert.equal(session.isController("pi-client"), false);
  assert.equal(session.state().controller, false);
  assert.equal(session.claim("pi-client", pi), false);
});

test("the same owner claiming again keeps the token", () => {
  const { session } = makeSession();
  session.start();
  const a = session.claimOwner("web");
  const b = session.claimOwner("web");
  assert.equal(a.token, b.token);
});

test("volume starts at the default and setVolume stores a clamped, stepped value", () => {
  const { session } = makeSession();
  assert.equal(session.volume(), VOLUME_DEFAULT);
  session.setVolume(42);
  assert.equal(session.volume(), 40);
  session.setVolume(250);
  assert.equal(session.volume(), 100);
  session.setVolume(-3);
  assert.equal(session.volume(), 0);
});

const nextTick = () => new Promise<void>((r) => setImmediate(r));

test("fd 4 lines reach onControl whole, even when split across chunks; junk is skipped", async () => {
  const { session, fake } = makeSession();
  const got: unknown[] = [];
  session.onControl((m) => got.push(m));
  session.start();
  fake.control.write("song /data/doom/music/0.mid 1\nsto");
  fake.control.write("p\nhack\n");
  await nextTick();
  assert.deepEqual(got, [
    { kind: "song", path: "/data/doom/music/0.mid", loop: true },
    { kind: "stop" },
  ]);
});

test("fd 3 PCM reaches onAudio", async () => {
  const { session, fake } = makeSession();
  const got: Buffer[] = [];
  session.onAudio((pcm) => got.push(pcm));
  session.start();
  fake.audio.write(Buffer.from([1, 2, 3, 4]));
  await nextTick();
  assert.deepEqual(Buffer.concat(got), Buffer.from([1, 2, 3, 4]));
});

test("the volume is sent to the engine at start and on every change", async () => {
  const { session, fake } = makeSession();
  session.start();
  session.setVolume(35);
  await nextTick();
  assert.equal(fake.written.join(""), `volume ${VOLUME_DEFAULT}\nvolume 35\n`);
});

function countingSink() {
  const sinks: Array<{ started: number; stopped: number; written: Buffer[] }> = [];
  const openAudio = () => {
    const sink = { started: 0, stopped: 0, written: [] as Buffer[] };
    sinks.push(sink);
    return {
      start: () => { sink.started++; },
      write: (pcm: Buffer) => { sink.written.push(pcm); },
      stop: () => { sink.stopped++; },
    };
  };
  return { sinks, openAudio };
}

test("one audio sink per engine run: opened on start, fed PCM, stopped on stop", async () => {
  const { sinks, openAudio } = countingSink();
  const { session, fake } = makeSession({ openAudio });
  session.start();
  fake.audio.write(Buffer.from([7, 8]));
  await nextTick();
  assert.equal(sinks.length, 1);
  assert.equal(sinks[0].started, 1);
  assert.deepEqual(Buffer.concat(sinks[0].written), Buffer.from([7, 8]));
  session.stop();
  assert.equal(sinks[0].stopped, 1);
});

test("an engine that dies stops its audio sink too", () => {
  const { sinks, openAudio } = countingSink();
  const { session, fake } = makeSession({ openAudio });
  session.start();
  fake.crash();
  assert.equal(sinks[0].stopped, 1);
  assert.equal(session.state().running, false);
});

test("a second start after stop opens a fresh sink", () => {
  const { sinks, openAudio } = countingSink();
  const { session } = makeSession({ openAudio });
  session.start();
  session.stop();
  session.start();
  assert.equal(sinks.length, 2);
  assert.equal(sinks[1].started, 1);
  assert.equal(sinks[1].stopped, 0);
});

test("AudioOut behind the session: PCM reaches aplay's stdin, and a missing aplay is silent", async () => {
  const { AudioOut } = require("./audio-out") as typeof import("./audio-out");
  const aplayIn = new PassThrough();
  const aplayWritten: Buffer[] = [];
  aplayIn.on("data", (d) => aplayWritten.push(d));
  const spawned: string[] = [];
  const { session, fake } = makeSession({
    openAudio: () => new AudioOut((cmd) => { spawned.push(cmd); return { stdin: aplayIn, kill: () => {}, onExit: () => {} }; }),
  });
  session.start();
  fake.audio.write(Buffer.from([9, 9]));
  await nextTick();
  assert.deepEqual(spawned, ["aplay"]);
  assert.deepEqual(Buffer.concat(aplayWritten), Buffer.from([9, 9]));

  const missing = makeSession({
    openAudio: () => new AudioOut(() => { throw new Error("spawn aplay ENOENT"); }),
  });
  assert.equal(missing.session.start().ok, true, "a missing aplay must not fail the engine start");
});

test("if aplay cannot start, the state says so and the game keeps running", () => {
  const { AudioOut } = require("./audio-out") as typeof import("./audio-out");
  const { session } = makeSession({
    openAudio: (onError) => new AudioOut(() => { throw new Error("ENOENT"); }, onError),
  });
  assert.equal(session.start().ok, true);
  assert.equal(session.state().running, true);
  assert.match(session.state().audioError ?? "", /aplay/);
});

test("an aplay that dies mid-run sets audioError and the engine keeps running", () => {
  const { AudioOut } = require("./audio-out") as typeof import("./audio-out");
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const exits: Array<() => void> = [];
    const { session } = makeSession({
      openAudio: (onError) => new AudioOut(() => ({ stdin: new PassThrough(), kill: () => {}, onExit: (cb) => exits.push(cb) }), onError),
    });
    session.start();
    assert.equal(session.state().audioError, null);
    exits[0]();
    assert.equal(session.state().running, true);
    assert.match(session.state().audioError ?? "", /aplay/);
  } finally {
    console.warn = realWarn;
  }
});

test("audioError is cleared when the engine starts again", () => {
  const { AudioOut } = require("./audio-out") as typeof import("./audio-out");
  let calls = 0;
  const { session } = makeSession({
    openAudio: (onError) => {
      calls++;
      if (calls === 1) return new AudioOut(() => { throw new Error("ENOENT"); }, onError);
      return { start: () => {}, write: () => {}, stop: () => {} };
    },
  });
  session.start();
  assert.notEqual(session.state().audioError, null);
  session.stop();
  session.start();
  assert.equal(session.state().audioError, null);
});

function countingMusic() {
  const players: Array<{ msgs: unknown[]; gains: number[]; stopped: number }> = [];
  const openMusic = () => {
    const player = { msgs: [] as unknown[], gains: [] as number[], stopped: 0 };
    players.push(player);
    return {
      handle: (msg: unknown) => { player.msgs.push(msg); },
      setGain: (g: number) => { player.gains.push(g); },
      stop: () => { player.stopped++; },
    };
  };
  return { players, openMusic };
}

test("one music player per engine run: fd 4 lines go to it, and it stops on stop", async () => {
  const { players, openMusic } = countingMusic();
  const { session, fake } = makeSession({ openMusic });
  session.start();
  fake.control.write(Buffer.from("song /a.mid 1\npause\n"));
  await nextTick();
  assert.equal(players.length, 1);
  assert.deepEqual(players[0].msgs, [
    { kind: "song", path: "/a.mid", loop: true },
    { kind: "pause" },
  ]);
  session.stop();
  assert.equal(players[0].stopped, 1);
});

test("an engine that dies stops its music player", () => {
  const { players, openMusic } = countingMusic();
  const { session, fake } = makeSession({ openMusic });
  session.start();
  fake.crash();
  assert.equal(players[0].stopped, 1);
});

test("the music gain follows the volume, for the next song started", () => {
  const { players, openMusic } = countingMusic();
  const { session } = makeSession({ openMusic });
  session.start();
  session.setVolume(35);
  assert.deepEqual(players[0].gains, [VOLUME_DEFAULT / 100, 0.35]);
});
