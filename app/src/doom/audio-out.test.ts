import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { aplayArgs, parseControlLine, AudioOut } from "./audio-out";

test("aplay uses the shared default device, 11025 Hz mono 16-bit", () => {
  assert.deepEqual(aplayArgs(), ["-q", "-D", "default", "-t", "raw", "-f", "S16_LE", "-r", "11025", "-c", "1"]);
});

test("parses song, stop, pause and resume lines from the engine", () => {
  assert.deepEqual(parseControlLine("song /tmp/a.mid 1"), { kind: "song", path: "/tmp/a.mid", loop: true });
  assert.deepEqual(parseControlLine("stop"), { kind: "stop" });
  assert.deepEqual(parseControlLine("pause"), { kind: "pause" });
  assert.deepEqual(parseControlLine("resume"), { kind: "resume" });
});

test("song path may contain spaces; the loop flag is the last token", () => {
  assert.deepEqual(parseControlLine("song /data/doom music/3.mid 0"), {
    kind: "song",
    path: "/data/doom music/3.mid",
    loop: false,
  });
});

test("rejects unknown or broken control lines", () => {
  assert.equal(parseControlLine("hack"), null);
  assert.equal(parseControlLine("song"), null);
  assert.equal(parseControlLine("song /tmp/a.mid"), null, "missing loop flag");
  assert.equal(parseControlLine("song /tmp/a.mid 2"), null, "loop flag must be 0 or 1");
  assert.equal(parseControlLine("song a.mid 1"), null, "path must be absolute");
  assert.equal(parseControlLine("song /tmp/a.wav 1"), null, "path must be a .mid");
  assert.equal(parseControlLine(""), null);
});

function fakeAplay() {
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (d) => written.push(String(d)));
  let exitCb: () => void = () => {};
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let killed = false;
  const spawn = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { stdin, kill: () => { killed = true; }, onExit: (cb: () => void) => { exitCb = cb; } };
  };
  return { spawn, calls, written, wasKilled: () => killed, exit: () => exitCb() };
}

test("AudioOut drops PCM before start and after aplay exits, without throwing", () => {
  const fake = fakeAplay();
  const out = new AudioOut(fake.spawn);
  out.write(Buffer.from([1, 2]));
  assert.equal(fake.calls.length, 0, "write must not start aplay");
  out.start();
  assert.deepEqual(fake.calls[0], { cmd: "aplay", args: aplayArgs() });
  out.write(Buffer.from([3, 4]));
  fake.exit();
  out.write(Buffer.from([5, 6]));
  assert.equal(fake.written.length, 1, "nothing is written once aplay has exited");
});

test("AudioOut stop kills aplay and closes the output", () => {
  const fake = fakeAplay();
  const out = new AudioOut(fake.spawn);
  out.start();
  out.stop();
  assert.equal(fake.wasKilled(), true);
  out.write(Buffer.from([1]));
  assert.equal(fake.written.length, 0);
});

test("AudioOut survives a spawn that throws: start does not throw and writes are dropped", () => {
  const out = new AudioOut(() => { throw new Error("spawn aplay ENOENT"); });
  assert.doesNotThrow(() => out.start());
  assert.doesNotThrow(() => out.write(Buffer.from([1])));
});
