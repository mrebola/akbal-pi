export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

// Runs onIdle once, `ms` after the last touch(). The chat web touches it on
// every turn, so a conversation keeps the memory until it goes quiet.
export class IdleRelease {
  private handle: unknown = null;

  constructor(
    private readonly ms: number,
    private readonly onIdle: () => void,
    private readonly sched: Scheduler = realScheduler,
  ) {}

  touch(): void {
    this.cancel();
    this.handle = this.sched.set(() => {
      this.handle = null;
      this.onIdle();
    }, this.ms);
  }

  cancel(): void {
    if (this.handle !== null) this.sched.clear(this.handle);
    this.handle = null;
  }
}
