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

export const MISSING_SOUNDFONT = "Falta el soundfont: corre scripts/fetch-doom-soundfont.sh";
export const MISSING_FLUIDSYNTH = "Falta fluidsynth: instálalo en la Pi";
export const MUSIC_STOPPED = "La música se detuvo";

// A looped song that ends faster than this is treated as broken. One quick
// relaunch is allowed; the next quick end stops the music until the next song.
const FAST_EXIT_MS = 2000;

interface Song {
  path: string;
  loop: boolean;
  proc: MusicProcess | null;
  paused: boolean;
  startedAt: number;
  fastExits: number;
}

function spawnMessage(err: Error): string {
  return (err as NodeJS.ErrnoException).code === "ENOENT"
    ? MISSING_FLUIDSYNTH
    : `fluidsynth no arrancó: ${err.message}`;
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
    // Told once per reason music is off or stops; the game keeps running.
    private onError?: (message: string) => void,
  ) {
    if (soundfont === null || !fs.existsSync(soundfont)) {
      this.ok = false;
      this.report(MISSING_SOUNDFONT);
    } else if (!hasFluidsynth()) {
      this.ok = false;
      this.report(MISSING_FLUIDSYNTH);
    } else {
      this.ok = true;
    }
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
        this.song = { path: msg.path, loop: msg.loop, proc: null, paused: false, startedAt: 0, fastExits: 0 };
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
      this.report(spawnMessage(err as Error));
      return;
    }
    s.proc = proc;
    s.startedAt = Date.now();
    proc.onExit((code, error) => {
      // A stale exit (song replaced or stopped) must not touch the current song.
      if (this.song !== s || s.proc !== proc) return;
      s.proc = null;
      if (error) {
        this.ok = false;
        this.report(spawnMessage(error));
        return;
      }
      if (s.paused) {
        s.paused = false;
        this.report("La música terminó mientras estaba en pausa; no se reinicia");
        return;
      }
      // Only a clean end loops. A crash is not retried, so it cannot spin.
      if (code !== 0) {
        this.report(`${MUSIC_STOPPED}: fluidsynth terminó con código ${code}`);
        return;
      }
      if (!s.loop) return;
      s.fastExits = Date.now() - s.startedAt < FAST_EXIT_MS ? s.fastExits + 1 : 0;
      if (s.fastExits > 1) {
        this.report(`${MUSIC_STOPPED}: la canción termina sin parar`);
        return;
      }
      this.launch(s);
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

  private report(message: string): void {
    this.onError?.(message);
    console.warn(`[DOOM music] ${message}`);
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
