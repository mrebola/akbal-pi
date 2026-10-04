import { FrameReader } from "./frame-reader";
import { ControlTokens } from "./tokens";
import { ControllerLock } from "./control";
import { DoomKey, KEY_CODES } from "./keymap";
import { VOLUME_DEFAULT, clampVolume, gainFor } from "./volume";
import { DEFAULT_GAME, DoomGame, wadFileName } from "./wad";
import { loadVolume, saveVolume } from "./settings-store";
import { parseControlLine, type ControlMessage } from "./audio-out";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

// Control lines are a few hundred bytes at most; a longer run without a newline
// means the stream is garbage, so it is dropped instead of growing forever.
const MAX_CONTROL_PENDING = 8192;

export interface EngineProcess {
  stdout: Readable;
  stdin: Writable;
  // fd 3: sound effects as PCM. fd 4: music and sound control lines.
  audio: Readable;
  control: Readable;
  kill(): void;
  onExit(cb: (code: number | null) => void): void;
}

// Who is playing: the Pi's screen or the web admin. Null while no game runs.
export type DoomOwner = "pi" | "web" | null;

export interface DoomState {
  running: boolean;
  controller: boolean;
  error: string | null;
  // Set when the sound is off; the game itself keeps running.
  audioError: string | null;
  // Set when the music is off or stopped; the game itself keeps running.
  musicError: string | null;
  owner: DoomOwner;
  // The game that runs now; null while none does.
  game: DoomGame | null;
  // True after a deliberate stop (web's Salir or the Pi's hold). A crash is an
  // error instead, and a fresh start clears it.
  closed: boolean;
}

export interface DoomSessionDeps {
  spawnEngine: (game: DoomGame) => EngineProcess;
  tokens: ControlTokens;
  lock: ControllerLock;
  binaryExists: () => boolean;
  wadExists: (game: DoomGame) => boolean;
  // Optional: without it the game runs silent (tests, or no audio device).
  // onError reports a sink that failed on its own, shown in the state.
  openAudio?: (onError: (message: string) => void) => AudioSink;
  // Optional, like openAudio: one music player per engine run, fed by fd 4.
  // onError reports why the player cannot run, or that it stopped.
  openMusic?: (onError: (message: string) => void) => MusicSink;
  // Optional: where settings.json lives. Without it the volume is not kept
  // between engine runs.
  settingsDir?: string;
}

const ENGINE_STOPPED = "El motor de DOOM se detuvo.";

// What the session needs from the music player (MusicPlayer in production).
export interface MusicSink {
  handle(msg: ControlMessage): void;
  setGain(gain: number): void;
  stop(): void;
}

// What the session needs from the sound output (AudioOut in production). One
// sink lives per engine run: it is opened on start and stopped on stop or loss.
export interface AudioSink {
  start(): void;
  write(pcm: Buffer): void;
  stop(): void;
}

// Single owner of the one engine process. Everyone else (screen, web) reads
// from here and sends keys through here.
export class DoomSession {
  private engine: EngineProcess | null = null;
  private reader = new FrameReader();
  private error: string | null = null;
  private audioError: string | null = null;
  private musicError: string | null = null;
  private gameValue: DoomGame | null = null;
  private closedValue = false;
  private ownerValue: DoomOwner = null;
  private volumeValue = VOLUME_DEFAULT;
  private frameListeners = new Set<(rgb565: Buffer) => void>();
  private audio: AudioSink | null = null;
  private music: MusicSink | null = null;
  private audioListeners = new Set<(pcm: Buffer) => void>();
  // Set while Akbal speaks: the engine keeps generating PCM, which is dropped.
  private audioPaused = false;
  private controlListeners = new Set<(msg: ControlMessage) => void>();
  private stateListeners = new Set<(s: DoomState) => void>();
  // Keys the controller has pressed and not yet released. Sent "up" when the
  // control changes hands or the engine goes away, so nothing stays stuck.
  private pressed = new Set<DoomKey>();

  constructor(private deps: DoomSessionDeps) {}

  start(game?: DoomGame): { ok: boolean; error?: string; token?: string } {
    if (this.engine) return { ok: true, token: this.deps.tokens.current() ?? undefined };
    const chosen = game ?? DEFAULT_GAME;
    if (!this.deps.wadExists(chosen)) {
      return { ok: false, error: `Falta el WAD ${wadFileName(chosen)}: copia el archivo a data/doom` };
    }
    if (!this.deps.binaryExists()) {
      return { ok: false, error: "Falta el motor: corre scripts/fetch-doom-engine.sh" };
    }
    this.error = null;
    this.audioError = null;
    this.musicError = null;
    this.gameValue = chosen;
    this.closedValue = false;
    if (this.deps.settingsDir) this.volumeValue = loadVolume(this.deps.settingsDir);
    this.reader = new FrameReader();
    const engine = this.deps.spawnEngine(chosen);
    this.engine = engine;
    this.audio = this.deps.openAudio?.((message) => {
      if (this.engine !== engine) return;
      this.audioError = message;
      this.emitState();
    }) ?? null;
    this.audio?.start();
    this.music = this.deps.openMusic?.((message) => {
      if (this.engine !== engine) return;
      this.musicError = message;
      this.emitState();
    }) ?? null;
    this.music?.setGain(gainFor(this.volumeValue));
    // A player opened during Akbal's reply must not play the first song.
    if (this.audioPaused) this.music?.handle({ kind: "pause" });
    engine.stdout.on("data", (chunk: Buffer) => {
      for (const frame of this.reader.push(chunk)) {
        this.frameListeners.forEach((cb) => cb(frame));
      }
    });
    // A write to a dead engine emits 'error'; without a listener Node would
    // exit the whole process, so every stream error takes the same path as exit.
    const lost = () => this.engineLost(engine, ENGINE_STOPPED);
    engine.stdin.on("error", lost);
    engine.stdout.on("error", lost);
    engine.audio.on("error", lost);
    engine.control.on("error", lost);
    // Flowing mode drains fd 4 as soon as data arrives: the engine's writes
    // block on the game thread, so a stalled reader would freeze the game.
    // Guarded by engine identity: a chunk from a stopped engine must not reach
    // the sink or listeners of the next one.
    engine.audio.on("data", (chunk: Buffer) => {
      if (this.engine !== engine) return;
      this.deliverAudio(chunk);
    });
    const decoder = new StringDecoder("utf8");
    let pending = "";
    engine.control.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk);
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        const msg = parseControlLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        if (msg && this.engine === engine) {
          this.music?.handle(msg);
          // A song that starts during the reply waits for resumeAudio.
          if (msg.kind === "song" && this.audioPaused) this.music?.handle({ kind: "pause" });
          this.controlListeners.forEach((cb) => cb(msg));
        }
        nl = pending.indexOf("\n");
      }
      if (pending.length > MAX_CONTROL_PENDING) pending = "";
    });
    engine.onExit(lost);
    this.send(engine, `volume ${this.volumeValue}`);
    const token = this.deps.tokens.issue();
    this.emitState();
    return { ok: true, token };
  }

  stop(): void {
    const engine = this.engine;
    if (engine) this.closedValue = true;
    this.engine = null;
    this.ownerValue = null;
    this.releaseKeys(engine);
    this.deps.tokens.revokeAll();
    const holder = this.deps.lock.holder();
    if (holder !== null) this.deps.lock.release(holder);
    this.stopAudio();
    this.stopMusic();
    engine?.kill();
    this.emitState();
  }

  // The token for the control QR: the live one, or a fresh one if the game
  // runs without it. The owner does not change.
  controlToken(): string | null {
    if (!this.engine) return null;
    return this.deps.tokens.current() ?? this.deps.tokens.issue();
  }

  owner(): DoomOwner {
    return this.ownerValue;
  }

  volume(): number {
    return this.volumeValue;
  }

  // The engine scales its own sound effects; music gain is applied in Node.
  setVolume(value: number): void {
    this.volumeValue = clampVolume(value);
    this.persistVolume();
    if (this.engine) this.send(this.engine, `volume ${this.volumeValue}`);
    this.music?.setGain(gainFor(this.volumeValue));
    this.emitState();
  }

  // Switching owner ends the old owner's input: held keys go up, its lock and
  // token are dropped, and a fresh token is issued for the new owner.
  claimOwner(who: "pi" | "web"): { ok: boolean; token?: string; error?: string } {
    if (!this.engine) return { ok: false, error: "No hay juego corriendo" };
    if (this.ownerValue === who) return { ok: true, token: this.deps.tokens.current() ?? undefined };
    this.releaseKeys(this.engine);
    this.deps.tokens.revokeAll();
    const holder = this.deps.lock.holder();
    if (holder !== null) this.deps.lock.release(holder);
    this.ownerValue = who;
    const token = this.deps.tokens.issue();
    this.emitState();
    return { ok: true, token };
  }

  claim(clientId: string, token: string): boolean {
    if (!this.engine || !this.deps.tokens.isValid(token)) return false;
    return this.deps.lock.claim(clientId);
  }

  release(clientId: string): void {
    const before = this.deps.lock.holder();
    if (before === clientId) this.releaseKeys(this.engine);
    this.deps.lock.release(clientId);
    if (before !== this.deps.lock.holder()) this.emitState();
  }

  key(clientId: string, key: DoomKey, down: boolean): boolean {
    if (!this.engine || !this.deps.lock.isHolder(clientId)) return false;
    if (down) this.pressed.add(key);
    else this.pressed.delete(key);
    this.send(this.engine, `${down ? "down" : "up"} ${KEY_CODES[key]}`);
    return true;
  }

  // Lets the socket tell a bad or expired token apart from a busy controller.
  tokenValid(token: string): boolean {
    return this.engine !== null && this.deps.tokens.isValid(token);
  }

  // Per client: the state tells each socket whether it is the one playing.
  isController(clientId: string): boolean {
    return this.deps.lock.isHolder(clientId);
  }

  state(): DoomState {
    return {
      running: this.engine !== null,
      controller: this.deps.lock.holder() !== null,
      error: this.error,
      audioError: this.audioError,
      musicError: this.musicError,
      owner: this.ownerValue,
      game: this.engine ? this.gameValue : null,
      closed: this.closedValue,
    };
  }

  onFrame(cb: (rgb565: Buffer) => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  onAudio(cb: (pcm: Buffer) => void): () => void {
    this.audioListeners.add(cb);
    return () => this.audioListeners.delete(cb);
  }

  // Idempotent. While paused the PCM is dropped and the music player is
  // paused (SIGSTOP), so the game stays quiet during Akbal's voice reply.
  pauseAudio(): void {
    if (this.audioPaused) return;
    this.audioPaused = true;
    this.music?.handle({ kind: "pause" });
  }

  // Idempotent. Undoes pauseAudio: PCM flows again and the music resumes.
  resumeAudio(): void {
    if (!this.audioPaused) return;
    this.audioPaused = false;
    this.music?.handle({ kind: "resume" });
  }

  // Test-only: pushes PCM through the same gate as the engine's fd 3 reader,
  // without a pipe. Production code must not call it.
  feedAudioForTest(pcm: Buffer): void {
    this.deliverAudio(pcm);
  }

  onControl(cb: (msg: ControlMessage) => void): () => void {
    this.controlListeners.add(cb);
    return () => this.controlListeners.delete(cb);
  }

  onState(cb: (s: DoomState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  // Idempotent: the first call wins, later stream errors or exits for the
  // same engine are ignored.
  private engineLost(engine: EngineProcess, message: string): void {
    if (this.engine !== engine) return;
    this.engine = null;
    this.ownerValue = null;
    this.releaseKeys(engine);
    const holder = this.deps.lock.holder();
    if (holder !== null) this.deps.lock.release(holder);
    this.deps.tokens.revokeAll();
    this.error = message;
    this.stopAudio();
    this.stopMusic();
    engine.kill();
    this.emitState();
  }

  // The one place PCM leaves the session: to the AudioOut and to the listeners.
  private deliverAudio(pcm: Buffer): void {
    if (this.audioPaused) return;
    this.audio?.write(pcm);
    this.audioListeners.forEach((cb) => cb(pcm));
  }

  private stopAudio(): void {
    const sink = this.audio;
    this.audio = null;
    sink?.stop();
  }

  // A failed write must not stop the game; the volume still applies this run.
  private persistVolume(): void {
    const dir = this.deps.settingsDir;
    if (!dir) return;
    try {
      saveVolume(dir, this.volumeValue);
    } catch (err) {
      console.warn(`[DOOM] no se pudo guardar el volumen: ${(err as Error).message}`);
    }
  }

  private stopMusic(): void {
    const player = this.music;
    this.music = null;
    player?.stop();
  }

  private releaseKeys(engine: EngineProcess | null): void {
    if (engine) {
      for (const key of this.pressed) this.send(engine, `up ${KEY_CODES[key]}`);
    }
    this.pressed.clear();
  }

  // Never throws. A stdin that is closed or refuses the write means the engine
  // is gone, so the session ends the same way as on exit.
  private send(engine: EngineProcess, line: string): void {
    if (engine.stdin.writable) {
      try {
        engine.stdin.write(`${line}\n`);
        return;
      } catch {
        // Fall through to engineLost.
      }
    }
    this.engineLost(engine, ENGINE_STOPPED);
  }

  private emitState(): void {
    const s = this.state();
    this.stateListeners.forEach((cb) => cb(s));
  }
}
