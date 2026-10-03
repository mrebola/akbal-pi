import axios from "axios";
import { ollamaEndpoint, unloadModel } from "../cloud-api/local/ollama-llm";
import { Deps } from "./model-memory";

// The real Ollama effects. Only the owner's model stays resident; the other
// owner's model is loaded on demand the next time it is needed.
export const ollamaDeps: Deps = {
  unloadAll: () => unloadModel(),
  warm: (model, keepAlive) =>
    axios
      .post(`${ollamaEndpoint}/api/chat`, { model, messages: [], keep_alive: keepAlive })
      .then(() => undefined),
};
