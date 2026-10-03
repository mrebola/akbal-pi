import { MemoryArbiter } from "./memory-arbiter";
import { IdleRelease } from "./idle-release";
import { releaseToDevice } from "./model-memory";

// One arbiter for the whole process: the web chat and the device voice must
// see the same owner.
export const memoryArbiter = new MemoryArbiter();

// Five quiet minutes before the web chat gives the memory back. Long enough
// that a conversation does not reload its model every message.
export const WEB_IDLE_MS = 5 * 60 * 1000;

export const webIdle = new IdleRelease(WEB_IDLE_MS, () => {
  memoryArbiter.release("web");
  releaseToDevice().catch((err) => console.error("[Memory] release failed:", err?.message || err));
});

// Set by the device flow: they cancel an in-flight generation of the other owner.
export const cancelHooks = {
  cancelDeviceReply: (): void => {},
  cancelWebReply: (): void => {},
};
