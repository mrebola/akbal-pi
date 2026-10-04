import type { Writable } from "node:stream";

// The engine's sound effects are 11025 Hz mono S16_LE raw PCM on fd 3. aplay
// plays them on the shared default device, the same one Akbal's voice uses.
export function aplayArgs(): string[] {
  return ["-q", "-D", "default", "-t", "raw", "-f", "S16_LE", "-r", "11025", "-c", "1"];
}

export type ControlMessage =
  | { kind: "song"; path: string; loop: boolean }
  | { kind: "stop" | "pause" | "resume" };

// Lines on fd 4 from the engine. The path may contain spaces, so it runs from
// after "song " up to the last space; the loop flag is the last token.
export function parseControlLine(line: string): ControlMessage | null {
  if (line === "stop" || line === "pause" || line === "resume") return { kind: line };
  if (!line.startsWith("song ")) return null;
  const rest = line.slice("song ".length);
  const sp = rest.lastIndexOf(" ");
  if (sp <= 0) return null;
  const path = rest.slice(0, sp);
  const flag = rest.slice(sp + 1);
  if (flag !== "0" && flag !== "1") return null;
  if (!path.startsWith("/") || !path.endsWith(".mid")) return null;
  return { kind: "song", path, loop: flag === "1" };
}

export interface AudioProcess {
  stdin: Writable;
  kill(): void;
  onExit(cb: () => void): void;
}

export type SpawnAudio = (cmd: string, args: string[]) => AudioProcess;

// About 3 s of S16 at 11025 Hz. Live audio drops a chunk rather than letting
// the queue to aplay grow without bound in memory.
export const MAX_PENDING_BYTES = 64 * 1024;

// Owns the aplay process. If aplay dies or cannot start, output stays closed
// and the game keeps running without sound.
export class AudioOut {
  private proc: AudioProcess | null = null;
  private closed = false;
  private droppedChunks = 0;

  constructor(
    private spawnProcess: SpawnAudio,
    // Told once when output dies on its own; not told about a deliberate stop.
    private onError?: (message: string) => void,
  ) {}

  get dropped(): number {
    return this.droppedChunks;
  }

  start(): void {
    if (this.proc || this.closed) return;
    let proc: AudioProcess;
    try {
      proc = this.spawnProcess("aplay", aplayArgs());
    } catch {
      this.close("no se pudo lanzar aplay; el juego sigue sin sonido");
      return;
    }
    this.proc = proc;
    // Without a listener a write to a dead aplay would crash the whole process.
    proc.stdin.on("error", () => this.close("aplay dejó de aceptar audio; el juego sigue sin sonido"));
    proc.onExit(() => this.close("aplay terminó; el juego sigue sin sonido"));
  }

  write(pcm: Buffer): void {
    const proc = this.proc;
    if (!proc || this.closed || !proc.stdin.writable) return;
    if (proc.stdin.writableLength > MAX_PENDING_BYTES) {
      if (this.droppedChunks++ === 0) {
        console.warn("[DOOM audio] aplay va atrasado; se descartan fragmentos de audio");
      }
      return;
    }
    try {
      proc.stdin.write(pcm);
    } catch {
      this.close("no se pudo escribir a aplay; el juego sigue sin sonido");
    }
  }

  stop(): void {
    this.closed = true;
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }

  private close(message: string): void {
    if (this.closed && !this.proc) return;
    console.warn(`[DOOM audio] ${message}`);
    this.onError?.(message);
    this.stop();
  }
}
