import type { ChildProcess } from "node:child_process";

// A child that ignores SIGTERM (or is stopped) would otherwise outlive the
// game: the engine, aplay and fluidsynth get SIGKILL after this grace period.
export const KILL_GRACE_MS = 2000;

// The timer is unref'd and cleared on exit, so it never keeps Akbal alive.
export function scheduleKillIfAlive(child: ChildProcess, graceMs = KILL_GRACE_MS): void {
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, graceMs);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}

export function terminateChild(child: ChildProcess, graceMs = KILL_GRACE_MS): void {
  child.kill("SIGTERM");
  scheduleKillIfAlive(child, graceMs);
}
