import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { getAudioDurationInSeconds } from "get-audio-duration";
import { getAlsaOutputDevice, releaseAudioPlayer, restoreAudioPlayer } from "./audio";

// A simple ordered-playlist music player ("jukebox") for a fixed local library
// (the Cypher OST by default). Unlike the voice-driven LocalMusicPlayer, this
// exposes explicit transport controls (play/pause/resume/stop/next/prev) for
// the web player and the on-device music mode. Audio goes out through whatever
// speaker is currently selected (HAT or Bluetooth) via getAlsaOutputDevice().

export interface JukeboxTrack {
  index: number;
  title: string;
  file: string;
}

export interface JukeboxStatus {
  available: boolean;
  playing: boolean;
  paused: boolean;
  index: number;
  title: string;
  total: number;
  positionMs: number;
  durationMs: number;
  loop: boolean;
}

const ROOT = path.resolve(__dirname, "..", "..");
const LIBRARY_DIR = process.env.MUSIC_JUKEBOX_DIR || path.join(ROOT, "data", "music", "cypher");

const stripExt = (name: string): string => name.replace(/\.[^.]+$/, "");

class Jukebox {
  private tracks: JukeboxTrack[] = [];
  private proc: ChildProcess | null = null;
  // Every mpg123 we've ever spawned that hasn't exited yet. Tracked so a stop
  // (or a new play) can kill ALL of them — a stale one that lost the generation
  // race still holds the ALSA device and would otherwise play on, overlapping.
  private procs = new Set<ChildProcess>();
  private generation = 0;
  private index = -1;
  private playing = false;
  private paused = false;
  private loop = true;
  private startedAt = 0;
  private accumulatedMs = 0;
  private durationMs = 0;
  private onChange: (() => void) | null = null;

  setOnChange(cb: (() => void) | null): void {
    this.onChange = cb;
  }
  private notify(): void {
    try {
      this.onChange?.();
    } catch {
      /* ignore */
    }
  }

  scan(): JukeboxTrack[] {
    try {
      const files = fs
        .readdirSync(LIBRARY_DIR)
        .filter((f) => /\.(mp3|wav|flac|ogg|m4a)$/i.test(f))
        .sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
      this.tracks = files.map((f, i) => ({
        index: i,
        title: stripExt(f),
        file: path.join(LIBRARY_DIR, f),
      }));
    } catch {
      this.tracks = [];
    }
    return this.tracks;
  }

  getTracks(): JukeboxTrack[] {
    if (this.tracks.length === 0) this.scan();
    return this.tracks;
  }

  private loadDuration(file: string): void {
    this.durationMs = 0;
    getAudioDurationInSeconds(file)
      .then((seconds) => {
        if (seconds && seconds > 0) this.durationMs = Math.round(seconds * 1000);
      })
      .catch(() => {
        /* duration best-effort */
      });
  }

  // Kill every tracked mpg123 and bump the generation so any in-flight play()
  // (awaiting between here and spawn) aborts instead of spawning a duplicate.
  private killAll(): number {
    this.generation++;
    for (const p of this.procs) {
      try {
        p.kill("SIGCONT"); // a paused (SIGSTOP'd) process must be resumed to die
        p.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    this.procs.clear();
    this.proc = null;
    return this.generation;
  }

  async play(index: number, seekMs = 0): Promise<JukeboxStatus> {
    const tracks = this.getTracks();
    if (tracks.length === 0) return this.status();
    const i = ((index % tracks.length) + tracks.length) % tracks.length;
    const track = tracks[i];

    const gen = this.killAll();
    // Free the persistent TTS player so ALSA is available for music.
    try {
      await releaseAudioPlayer();
    } catch {
      /* ignore */
    }
    // If another play/stop/next happened while we awaited, abandon this one so
    // we never end up with two players running at once.
    if (gen !== this.generation) return this.status();

    this.index = i;
    this.playing = true;
    this.paused = false;
    this.accumulatedMs = Math.max(0, seekMs);
    this.startedAt = Date.now();
    this.loadDuration(track.file);

    const device = getAlsaOutputDevice();
    // mpg123 seeks by frames; ~38.28 MPEG1-L3 frames per second (1152
    // samples @ 44.1 kHz). Good enough for a music-player scrubber.
    const args = ["-q", "-o", "alsa", "-a", device];
    if (seekMs > 0) {
      const frames = Math.round((seekMs / 1000) * (44100 / 1152));
      args.push("-k", String(frames));
    }
    args.push(track.file);
    const proc = spawn("mpg123", args);
    this.proc = proc;
    this.procs.add(proc);
    proc.on("error", () => {
      this.procs.delete(proc);
      if (gen !== this.generation) return;
      this.proc = null;
    });
    proc.on("exit", () => {
      this.procs.delete(proc);
      if (gen !== this.generation) return; // superseded by another command
      this.proc = null;
      if (!this.playing || this.paused) return;
      // Natural end of track -> advance.
      const isLast = this.index >= this.tracks.length - 1;
      if (isLast && !this.loop) {
        this.playing = false;
        this.index = -1;
        this.notify();
        return;
      }
      void this.play(this.index + 1);
    });
    this.notify();
    return this.status();
  }

  async playPause(): Promise<JukeboxStatus> {
    if (!this.playing) return this.play(this.index >= 0 ? this.index : 0);
    if (this.paused) return this.resume();
    return this.pause();
  }

  pause(): JukeboxStatus {
    if (this.playing && !this.paused && this.proc) {
      try {
        this.proc.kill("SIGSTOP");
        this.accumulatedMs += Date.now() - this.startedAt;
        this.paused = true;
      } catch {
        /* ignore */
      }
    }
    this.notify();
    return this.status();
  }

  resume(): JukeboxStatus {
    if (this.playing && this.paused && this.proc) {
      try {
        this.proc.kill("SIGCONT");
        this.startedAt = Date.now();
        this.paused = false;
      } catch {
        /* ignore */
      }
    }
    this.notify();
    return this.status();
  }

  async seek(ms: number): Promise<JukeboxStatus> {
    if (this.index < 0 || !this.playing) return this.status();
    const clamped = this.durationMs > 0 ? Math.max(0, Math.min(ms, this.durationMs - 1000)) : Math.max(0, ms);
    return this.play(this.index, clamped);
  }

  async next(): Promise<JukeboxStatus> {
    const base = this.index >= 0 ? this.index : -1;
    return this.play(base + 1);
  }

  async prev(): Promise<JukeboxStatus> {
    // If more than ~3s into the track, "prev" restarts it (typical player UX).
    if (this.playing && this.positionMs() > 3000) return this.play(this.index);
    const base = this.index >= 0 ? this.index : 0;
    return this.play(base - 1);
  }

  stop(): JukeboxStatus {
    this.killAll();
    this.playing = false;
    this.paused = false;
    this.index = -1;
    this.accumulatedMs = 0;
    this.durationMs = 0;
    try {
      restoreAudioPlayer();
    } catch {
      /* ignore */
    }
    this.notify();
    return this.status();
  }

  setLoop(on: boolean): JukeboxStatus {
    this.loop = on;
    return this.status();
  }

  private positionMs(): number {
    if (!this.playing) return 0;
    if (this.paused) return this.accumulatedMs;
    return this.accumulatedMs + (Date.now() - this.startedAt);
  }

  isActive(): boolean {
    return this.playing;
  }

  status(): JukeboxStatus {
    const tracks = this.getTracks();
    const track = this.index >= 0 ? tracks[this.index] : undefined;
    return {
      available: tracks.length > 0,
      playing: this.playing,
      paused: this.paused,
      index: this.index,
      title: track ? track.title : "",
      total: tracks.length,
      positionMs: this.positionMs(),
      durationMs: this.durationMs,
      loop: this.loop,
    };
  }
}

export const jukebox = new Jukebox();
