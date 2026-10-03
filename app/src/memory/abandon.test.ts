import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryArbiter } from "./memory-arbiter";
import { abandonWebClaim } from "./model-memory";

test("abandoning a failed web claim gives memory back and unloads everything", async () => {
  const arb = new MemoryArbiter();
  arb.requestWeb();
  const calls: string[] = [];
  await abandonWebClaim(arb, {
    unloadAll: async () => {
      calls.push("unloadAll");
    },
    warm: async () => {
      calls.push("warm");
    },
  });
  assert.equal(arb.owner(), "device");
  assert.deepEqual(calls, ["unloadAll"]);
});
