import { FrameReader } from "./frame-reader";
import { ControlTokens } from "./tokens";
import { ControllerLock } from "./control";
import { DoomKey, KEY_CODES } from "./keymap";
import type { Readable, Writable } from "node:stream";

export interface EngineProcess {
  stdout: Readable;
  stdin: Writable;
  kill(): void;
  onExit(cb: (code: number | null) => void): void;
}

export interface DoomState {
  running: boolean;
  controller: boolean;
  error: string | null;
}

export interface DoomSessionDeps {
  spawnEngine: () => EngineProcess;
  tokens: ControlTokens;
  lock: ControllerLock;
  binaryExists: () => boolean;
  wadExists: () => boolean;
}

const ENGINE_STOPPED = "El motor de DOOM se detuvo.";

// Single owner of the one engine process. Everyone else (screen, web) reads
// from here and sends keys through here.
export class DoomSession {
  private engine: EngineProcess | null = null;
  private reader = new FrameReader();
  private error: string | null = null;
  private frameListeners = new Set<(rgb565: Buffer) => void>();
  private stateListeners = new Set<(s: DoomState) => void>();
  // Keys the controller has pressed and not yet released. Sent "up" when the
  // control changes hands or the engine goes away, so nothing stays stuck.
  private pressed = new Set<DoomKey>();

  constructor(private deps: DoomSessionDeps) {}

  start(): { ok: boolean; error?: string; token?: string } {
    if (this.engine) return { ok: true, token: this.deps.tokens.current() ?? undefined };
    if (!this.deps.wadExists()) {
      return { ok: false, error: "Falta el WAD: corre scripts/fetch-doom-wad.sh" };
    }
    if (!this.deps.binaryExists()) {
      return { ok: false, error: "Falta el motor: corre scripts/fetch-doom-engine.sh" };
    }
    this.error = null;
    this.reader = new FrameReader();
    const engine = this.deps.spawnEngine();
    this.engine = engine;
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
    engine.onExit(lost);
    const token = this.deps.tokens.issue();
    this.emitState();
    return { ok: true, token };
  }

  stop(): void {
    const engine = this.engine;
    this.engine = null;
    this.releaseKeys(engine);
    this.deps.tokens.revokeAll();
    const holder = this.deps.lock.holder();
    if (holder !== null) this.deps.lock.release(holder);
    engine?.kill();
    this.emitState();
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
    };
  }

  onFrame(cb: (rgb565: Buffer) => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
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
    this.releaseKeys(engine);
    const holder = this.deps.lock.holder();
    if (holder !== null) this.deps.lock.release(holder);
    this.deps.tokens.revokeAll();
    this.error = message;
    engine.kill();
    this.emitState();
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
