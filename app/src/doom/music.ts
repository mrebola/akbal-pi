import fs from "fs";
import path from "path";
import { gainFor, VOLUME_DEFAULT } from "./volume";
import type { ControlMessage } from "./audio-out";

// fluidsynth plays one MIDI file through the same ALSA default device as the
// sound effects, so the Pi's speaker carries both. -ni: no shell, no MIDI input.
export function fluidsynthArgs(soundfont: string, midi: string, gain: number): string[] {
  return ["-ni", "-a", "alsa", "-o", "audio.alsa.device=default", "-g", String(gain), soundfont, midi];
}

export interface MusicProcess {
  signal(sig: NodeJS.Signals): void;
  // A non-null error means the process never started (for example, fluidsynth is not installed).
  onExit(cb: (code: number | null, error?: Error) => void): void;
}

export type SpawnMusic = (cmd: string, args: string[]) => MusicProcess;

export function fluidsynthOnPath(): boolean {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, "fluidsynth"), fs.constants.X_OK);
      return true;
    } catch {
      // Not in this directory; keep looking.
    }
  }
  return false;
}

interface Song {
  path: string;
  loop: boolean;
  proc: MusicProcess | null;
  paused: boolean;
}

// One player per engine run. Every process is spawned asynchronously and never
// waited on, so the game loop is never blocked by the music.
export class MusicPlayer {
  private song: Song | null = null;
  private gain = gainFor(VOLUME_DEFAULT);
  private ok: boolean;

  constructor(
    private spawn: SpawnMusic,
    private soundfont: string | null,
    hasFluidsynth: () => boolean = fluidsynthOnPath,
  ) {
    this.ok = soundfont !== null && fs.existsSync(soundfont) && hasFluidsynth();
  }

  available(): boolean {
    return this.ok;
  }

  // Applies to the next song started. A song already playing keeps its gain:
  // live changes are a later phase (see the DOOM audio spec, Riesgos).
  setGain(gain: number): void {
    if (!Number.isFinite(gain)) return;
    this.gain = Math.min(1, Math.max(0, gain));
  }

  handle(msg: ControlMessage): void {
    switch (msg.kind) {
      case "song":
        this.stopProcess();
        this.song = { path: msg.path, loop: msg.loop, proc: null, paused: false };
        this.launch(this.song);
        return;
      case "stop":
        this.stopProcess();
        this.song = null;
        return;
      case "pause": {
        const s = this.song;
        if (!s?.proc || s.paused) return;
        if (this.signal(s.proc, "SIGSTOP")) s.paused = true;
        return;
      }
      case "resume": {
        const s = this.song;
        if (!s?.proc || !s.paused) return;
        s.paused = false;
        this.signal(s.proc, "SIGCONT");
        return;
      }
    }
  }

  stop(): void {
    this.handle({ kind: "stop" });
  }

  private launch(s: Song): void {
    if (!this.ok || !this.soundfont) return;
    let proc: MusicProcess;
    try {
      proc = this.spawn("fluidsynth", fluidsynthArgs(this.soundfont, s.path, this.gain));
    } catch (err) {
      this.ok = false;
      console.warn(`[DOOM music] no se pudo lanzar fluidsynth: ${(err as Error).message}`);
      return;
    }
    s.proc = proc;
    proc.onExit((code, error) => {
      // A stale exit (song replaced or stopped) must not touch the current song.
      if (this.song !== s || s.proc !== proc) return;
      s.proc = null;
      if (error) {
        this.ok = false;
        console.warn(`[DOOM music] fluidsynth no arrancó: ${error.message}`);
        return;
      }
      if (s.paused) {
        s.paused = false;
        console.warn("[DOOM music] la música terminó mientras estaba en pausa; no se reinicia");
        return;
      }
      // Only a clean end loops. A crash is not retried, so it cannot spin.
      if (code !== 0) {
        console.warn(`[DOOM music] fluidsynth terminó con código ${code}; sin música`);
        return;
      }
      if (s.loop) this.launch(s);
    });
  }

  private stopProcess(): void {
    const s = this.song;
    if (!s?.proc) return;
    const proc = s.proc;
    s.proc = null;
    // A stopped process ignores SIGTERM until it continues, so wake it first.
    if (s.paused) this.signal(proc, "SIGCONT");
    s.paused = false;
    this.signal(proc, "SIGTERM");
  }

  // Returns false if the process is already gone; the exit handler covers that.
  private signal(proc: MusicProcess, sig: NodeJS.Signals): boolean {
    try {
      proc.signal(sig);
      return true;
    } catch {
      return false;
    }
  }
}
