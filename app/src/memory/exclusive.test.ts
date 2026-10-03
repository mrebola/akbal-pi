import { test } from "node:test";
import assert from "node:assert/strict";
import { exclusive } from "./exclusive";

test("exclusive runs jobs one at a time, in the order they were queued", async () => {
  const log: string[] = [];
  const slow = (name: string, ms: number) => async () => {
    log.push(`start:${name}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end:${name}`);
  };
  await Promise.all([exclusive(slow("web", 20)), exclusive(slow("device", 5))]);
  assert.deepEqual(log, ["start:web", "end:web", "start:device", "end:device"]);
});

test("a failing job does not block the next one", async () => {
  const out: string[] = [];
  await exclusive(async () => {
    throw new Error("boom");
  }).catch(() => out.push("caught"));
  await exclusive(async () => {
    out.push("next");
  });
  assert.deepEqual(out, ["caught", "next"]);
});
