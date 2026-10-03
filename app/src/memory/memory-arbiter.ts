export type Owner = "device" | "web";

export interface Decision {
  // Generation to cancel before the change (the other owner's reply), if any.
  cancel: Owner | null;
  // Unload every resident model before loading the new owner's model.
  unloadAll: boolean;
  // Which owner's model to load now; null when nothing changes.
  loadModel: Owner | null;
}

const NOOP: Decision = { cancel: null, unloadAll: false, loadModel: null };

// Pure: decides who holds the one resident model. The Ollama effects live in
// model-memory.ts so this can be tested without a Pi.
export class MemoryArbiter {
  private current: Owner = "device";

  owner(): Owner {
    return this.current;
  }

  requestWeb(): Decision {
    if (this.current === "web") return NOOP;
    const cancel = this.current;
    this.current = "web";
    return { cancel, unloadAll: true, loadModel: "web" };
  }

  preemptDevice(): Decision {
    if (this.current === "device") return NOOP;
    const cancel = this.current;
    this.current = "device";
    return { cancel, unloadAll: true, loadModel: "device" };
  }

  // The web chat finished or went idle: memory goes back to the device, which
  // reloads its model on demand, not in the background.
  release(by: Owner): void {
    if (by !== this.current) return;
    this.current = "device";
  }
}
