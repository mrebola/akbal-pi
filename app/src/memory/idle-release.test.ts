import { test } from "node:test";
import assert from "node:assert/strict";
import { IdleRelease } from "./idle-release";

// Fake scheduler: callbacks run only when the test advances them.
const fakeScheduler = () => {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    pending,
    sched: {
      set: (fn: () => void) => {
        const id = next++;
        pending.set(id, fn);
        return id;
      },
      clear: (h: unknown) => {
        pending.delete(h as number);
      },
    },
    fire: () => {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((f) => f());
    },
  };
};

test("fires onIdle once after the last touch", () => {
  const s = fakeScheduler();
  let released = 0;
  const idle = new IdleRelease(300_000, () => released++, s.sched);
  idle.touch();
  idle.touch();
  assert.equal(s.pending.size, 1);
  s.fire();
  assert.equal(released, 1);
});

test("cancel prevents the release", () => {
  const s = fakeScheduler();
  let released = 0;
  const idle = new IdleRelease(300_000, () => released++, s.sched);
  idle.touch();
  idle.cancel();
  s.fire();
  assert.equal(released, 0);
});
