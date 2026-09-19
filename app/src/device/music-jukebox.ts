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

  private killProc(): void {
    this.generation++;
    if (this.proc) {
      try {
        // Make sure a paused (SIGSTOP'd) process can actually die.
        this.proc.kill("SIGCONT");
        this.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }

  async play(index: number): Promise<JukeboxStatus> {
    const tracks = this.getTracks();
    if (tracks.length === 0) return this.status();
    const i = ((index % tracks.length) + tracks.length) % tracks.length;
    const track = tracks[i];

    this.killProc();
    // Free the persistent TTS player so ALSA is available for music.
    try {
      await releaseAudioPlayer();
    } catch {
      /* ignore */
    }

    const gen = this.generation;
    this.index = i;
    this.playing = true;
    this.paused = false;
    this.accumulatedMs = 0;
    this.startedAt = Date.now();
    this.loadDuration(track.file);

    const device = getAlsaOutputDevice();
    const proc = spawn("mpg123", ["-q", "-o", "alsa", "-a", device, track.file]);
    this.proc = proc;
    proc.on("error", () => {
      if (gen !== this.generation) return;
      this.proc = null;
    });
    proc.on("exit", () => {
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
    this.killProc();
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
