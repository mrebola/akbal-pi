import { Decision, MemoryArbiter, Owner } from "./memory-arbiter";
import { exclusive } from "./exclusive";

// The Ollama effects are injected, so this module stays pure and testable
// without a Pi. The real implementation lives in ollama-deps.ts.
export interface Deps {
  unloadAll(): Promise<void>;
  warm(model: string, keepAlive: number): Promise<void>;
}

export const applyDecision = (
  d: Decision,
  models: { device: string; web: string | null },
  deps: Deps,
): Promise<void> =>
  exclusive(async () => {
    if (d.unloadAll) await deps.unloadAll();
    if (d.loadModel) {
      const target: Owner = d.loadModel;
      const model = target === "web" ? models.web : models.device;
      if (model) await deps.warm(model, -1);
    }
  });

// Hands memory back to the device: nothing stays resident, so the voice model
// loads alone the next time the device needs it.
export const releaseToDevice = (deps: Deps): Promise<void> => exclusive(() => deps.unloadAll());

// A web claim whose model load failed: the arbiter must not stay on "web"
// (the device would then wait for a hold for no reason) and nothing may stay
// half-loaded. Release, then unload everything.
export const abandonWebClaim = async (arbiter: MemoryArbiter, deps: Deps): Promise<void> => {
  arbiter.release("web");
  await releaseToDevice(deps);
};
