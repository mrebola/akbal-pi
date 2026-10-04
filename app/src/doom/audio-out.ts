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

// Owns the aplay process. If aplay dies or cannot start, output stays closed
// and the game keeps running without sound.
export class AudioOut {
  private proc: AudioProcess | null = null;
  private closed = false;

  constructor(private spawnProcess: SpawnAudio) {}

  start(): void {
    if (this.proc || this.closed) return;
    const proc = this.spawnProcess("aplay", aplayArgs());
    this.proc = proc;
    // Without a listener a write to a dead aplay would crash the whole process.
    proc.stdin.on("error", () => this.close("[DOOM audio] aplay dejó de aceptar audio"));
    proc.onExit(() => this.close("[DOOM audio] aplay terminó"));
  }

  write(pcm: Buffer): void {
    const proc = this.proc;
    if (!proc || this.closed || !proc.stdin.writable) return;
    try {
      proc.stdin.write(pcm);
    } catch {
      this.close("[DOOM audio] no se pudo escribir a aplay");
    }
  }

  stop(): void {
    this.closed = true;
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }

  private close(reason: string): void {
    if (this.closed && !this.proc) return;
    console.warn(reason);
    this.stop();
  }
}
