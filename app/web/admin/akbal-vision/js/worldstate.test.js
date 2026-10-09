import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyWorldState, createWorldStore } from "./worldstate.js";

test("emptyWorldState tiene la forma esperada", () => {
  const s = emptyWorldState();
  assert.deepEqual(s, { subjects: {}, primaryId: null, frame: { w: 0, h: 0 }, updatedAt: 0 });
});

test("store arranca vacío y snapshot refleja el último set", () => {
  const store = createWorldStore();
  assert.deepEqual(store.snapshot(), emptyWorldState());
  const next = { subjects: { "SUBJ-0001": { id: "SUBJ-0001" } }, primaryId: "SUBJ-0001", frame: { w: 1280, h: 720 }, updatedAt: 5 };
  store.set(next);
  assert.equal(store.snapshot(), next);
});
