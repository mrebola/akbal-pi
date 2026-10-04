import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fluidsynthArgs, MusicPlayer, type MusicProcess } from "./music";

test("fluidsynth plays one MIDI file through the shared ALSA default, with gain", () => {
  assert.deepEqual(fluidsynthArgs("/s.sf2", "/m.mid", 0.6), [
    "-ni", "-a", "alsa", "-o", "audio.alsa.device=default", "-g", "0.6", "/s.sf2", "/m.mid",
  ]);
});

test("without a soundfont the player stays silent and reports unavailable", () => {
  let spawned = 0;
  const player = new MusicPlayer(() => { spawned++; return null as any; }, null);
  player.handle({ kind: "song", path: "/m.mid", loop: true });
  assert.equal(spawned, 0);
  assert.equal(player.available(), false);
});

// A fake spawn that records every launch, the signals sent to it, and lets the
// test end a process on demand.
function fakeSpawn(failWith?: Error) {
  const launches: Array<{ cmd: string; args: string[]; signals: string[]; exit: (code?: number | null, err?: Error) => void }> = [];
  const spawn = (cmd: string, args: string[]): MusicProcess => {
    if (failWith) throw failWith;
    let exitCb: (code: number | null, err?: Error) => void = () => {};
    const launch = {
      cmd,
      args,
      signals: [] as string[],
      exit: (code: number | null = 0, err?: Error) => exitCb(code, err),
    };
    launches.push(launch);
    return {
      signal: (sig: NodeJS.Signals) => { launch.signals.push(sig); },
      onExit: (cb) => { exitCb = cb; },
    };
  };
  return { spawn, launches };
}

function soundfont(): string {
  const path = join(mkdtempSync(join(tmpdir(), "doom-sf-")), "test.sf2");
  writeFileSync(path, "");
  return path;
}

test("song launches fluidsynth with the gain set before it; a new song replaces the old one", () => {
  const fake = fakeSpawn();
  const player = new MusicPlayer(fake.spawn, soundfont(), () => true);
  player.setGain(0.3);
  player.handle({ kind: "song", path: "/a.mid", loop: false });
  assert.equal(player.available(), true);
  assert.equal(fake.launches[0].cmd, "fluidsynth");
  assert.equal(fake.launches[0].args[fake.launches[0].args.indexOf("-g") + 1], "0.3");

  player.handle({ kind: "song", path: "/b.mid", loop: false });
  assert.equal(fake.launches.length, 2);
  assert.deepEqual(fake.launches[0].signals, ["SIGTERM"], "old song is terminated");
  assert.equal(fake.launches[1].args.at(-1), "/b.mid");
});

test("a crash does not relaunch the song, even when it loops", () => {
  const fake = fakeSpawn();
  const player = new MusicPlayer(fake.spawn, soundfont(), () => true);
  player.handle({ kind: "song", path: "/loop.mid", loop: true });
  fake.launches[0].exit(1);
  assert.equal(fake.launches.length, 1);
});

test("a looped song relaunches when it exits; a one-shot song does not", () => {
  const fake = fakeSpawn();
  const player = new MusicPlayer(fake.spawn, soundfont(), () => true);
  player.handle({ kind: "song", path: "/loop.mid", loop: true });
  fake.launches[0].exit(0);
  assert.equal(fake.launches.length, 2);
  assert.equal(fake.launches[1].args.at(-1), "/loop.mid");

  player.handle({ kind: "song", path: "/once.mid", loop: false });
  fake.launches[2].exit(0);
  assert.equal(fake.launches.length, 3, "no relaunch after a one-shot song ends");
});

test("stop kills the process and cancels the loop", () => {
  const fake = fakeSpawn();
  const player = new MusicPlayer(fake.spawn, soundfont(), () => true);
  player.handle({ kind: "song", path: "/loop.mid", loop: true });
  player.handle({ kind: "stop" });
  assert.deepEqual(fake.launches[0].signals, ["SIGTERM"]);
  fake.launches[0].exit(null);
  assert.equal(fake.launches.length, 1, "stopped song is not relaunched");
});

test("a stale exit from a replaced song does not touch the current one", () => {
  const fake = fakeSpawn();
  const player = new MusicPlayer(fake.spawn, soundfont(), () => true);
  player.handle({ kind: "song", path: "/a.mid", loop: true });
  player.handle({ kind: "song", path: "/b.mid", loop: false });
  fake.launches[0].exit(null);
  assert.equal(fake.launches.length, 2);
  assert.deepEqual(fake.launches[1].signals, []);
});

test("a paused song is woken before it is terminated", () => {
  const fake = fakeSpawn();
  const player = new MusicPlayer(fake.spawn, soundfont(), () => true);
  player.handle({ kind: "song", path: "/a.mid", loop: false });
  player.handle({ kind: "pause" });
  player.handle({ kind: "song", path: "/b.mid", loop: false });
  assert.deepEqual(fake.launches[0].signals, ["SIGSTOP", "SIGCONT", "SIGTERM"]);
});

test("pause and resume send SIGSTOP and SIGCONT to the running process", () => {
  const fake = fakeSpawn();
  const player = new MusicPlayer(fake.spawn, soundfont(), () => true);
  player.handle({ kind: "song", path: "/a.mid", loop: true });
  player.handle({ kind: "pause" });
  player.handle({ kind: "resume" });
  assert.deepEqual(fake.launches[0].signals, ["SIGSTOP", "SIGCONT"]);
});

test("if the process dies while paused, resume does not restart the song", () => {
  const fake = fakeSpawn();
  const player = new MusicPlayer(fake.spawn, soundfont(), () => true);
  player.handle({ kind: "song", path: "/a.mid", loop: true });
  player.handle({ kind: "pause" });
  fake.launches[0].exit(null);
  player.handle({ kind: "resume" });
  assert.equal(fake.launches.length, 1);
  assert.deepEqual(fake.launches[0].signals, ["SIGSTOP"], "no SIGCONT to a dead process");
});

test("a fluidsynth that cannot start marks music unavailable and does not retry", () => {
  const fake = fakeSpawn();
  const player = new MusicPlayer(fake.spawn, soundfont(), () => true);
  player.handle({ kind: "song", path: "/a.mid", loop: true });
  fake.launches[0].exit(null, new Error("spawn fluidsynth ENOENT"));
  assert.equal(fake.launches.length, 1);
  assert.equal(player.available(), false);
});

test("a spawn that throws leaves the game running with music off", () => {
  const fake = fakeSpawn(new Error("EACCES"));
  const player = new MusicPlayer(fake.spawn, soundfont(), () => true);
  assert.doesNotThrow(() => player.handle({ kind: "song", path: "/a.mid", loop: true }));
  assert.equal(player.available(), false);
});
