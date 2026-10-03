import { applyDecision } from "./model-memory";
import { memoryArbiter, cancelHooks } from "./shared";
import { cancelActiveVoiceGeneration, getCurrentModel } from "../cloud-api/local/ollama-llm";

// Voice is the other owner the web chat can cancel, and the device side of the
// same contract. Wired once, when the chat flow loads.
cancelHooks.cancelDeviceReply = cancelActiveVoiceGeneration;

// Called only after a 3 s hold (see states.ts). Takes the one resident model
// back from the web chat and loads the voice model.
export const takeMemoryForDevice = async (): Promise<void> => {
  const decision = memoryArbiter.preemptDevice();
  if (decision.cancel === "web") cancelHooks.cancelWebReply();
  await applyDecision(decision, { device: getCurrentModel(), web: null });
};
