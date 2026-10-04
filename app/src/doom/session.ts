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

// Single owner of the one engine process. Everyone else (screen, web) reads
// from here and sends keys through here.
export class DoomSession {
  private engine: EngineProcess | null = null;
  private reader = new FrameReader();
  private error: string | null = null;
  private frameListeners = new Set<(rgb565: Buffer) => void>();
  private stateListeners = new Set<(s: DoomState) => void>();

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
    engine.onExit(() => {
      if (this.engine !== engine) return;
      this.engine = null;
      this.deps.lock.release(this.deps.lock.holder() ?? "");
      this.deps.tokens.revokeAll();
      this.error = "El motor de DOOM se detuvo.";
      this.emitState();
    });
    const token = this.deps.tokens.issue();
    this.emitState();
    return { ok: true, token };
  }

  stop(): void {
    const engine = this.engine;
    this.engine = null;
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
    this.deps.lock.release(clientId);
    if (before !== this.deps.lock.holder()) this.emitState();
  }

  key(clientId: string, key: DoomKey, down: boolean): boolean {
    if (!this.engine || !this.deps.lock.isHolder(clientId)) return false;
    this.engine.stdin.write(`${down ? "down" : "up"} ${KEY_CODES[key]}\n`);
    return true;
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

  private emitState(): void {
    const s = this.state();
    this.stateListeners.forEach((cb) => cb(s));
  }
}
