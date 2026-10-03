import axios from "axios";
import { ollamaEndpoint, unloadModel } from "../cloud-api/local/ollama-llm";
import { Decision, Owner } from "./memory-arbiter";

export interface Deps {
  unloadAll(): Promise<void>;
  warm(model: string, keepAlive: number): Promise<void>;
}

// Real Ollama effects. Only the owner's model stays resident; the other
// owner's model is loaded on demand the next time it is needed.
export const ollamaDeps: Deps = {
  unloadAll: () => unloadModel(),
  warm: (model, keepAlive) =>
    axios
      .post(`${ollamaEndpoint}/api/chat`, { model, messages: [], keep_alive: keepAlive })
      .then(() => undefined),
};

export const applyDecision = async (
  d: Decision,
  models: { device: string; web: string | null },
  deps: Deps = ollamaDeps,
): Promise<void> => {
  if (d.unloadAll) await deps.unloadAll();
  if (d.loadModel) {
    const target: Owner = d.loadModel;
    const model = target === "web" ? models.web : models.device;
    if (model) await deps.warm(model, -1);
  }
};
