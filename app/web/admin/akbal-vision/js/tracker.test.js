import { test } from "node:test";
import assert from "node:assert/strict";
import { createTracker } from "./tracker.js";
import { emptyWorldState } from "./worldstate.js";

const det = (x, y, w = 100, h = 100, confidence = 0.9) => ({ bbox: { x, y, w, h }, confidence });
const frame = { w: 1280, h: 720 };

test("detección nueva crea SUBJ-0001 y emite subject.created", () => {
  const tr = createTracker();
  const { state, events } = tr.update([det(100, 100)], emptyWorldState(), 1000, frame);
  const ids = Object.keys(state.subjects);
  assert.deepEqual(ids, ["SUBJ-0001"]);
  assert.equal(state.subjects["SUBJ-0001"].center.x, 150);
  assert.ok(events.some((e) => e.type === "subject.created" && e.payload.id === "SUBJ-0001"));
});

test("IDs son monotónicos entre llamadas", () => {
  const tr = createTracker();
  let s = tr.update([det(100, 100)], emptyWorldState(), 1000, frame).state;
  s = tr.update([det(900, 500)], s, 2000, frame).state; // el primero ya expiró por TTL
  assert.ok(s.subjects["SUBJ-0002"], "el segundo rostro recibe SUBJ-0002");
});

test("un rostro que se mueve poco conserva su ID", () => {
  const tr = createTracker();
  let r = tr.update([det(100, 100)], emptyWorldState(), 1000, frame);
  r = tr.update([det(115, 108)], r.state, 1100, frame);
  assert.deepEqual(Object.keys(r.state.subjects), ["SUBJ-0001"]);
  assert.equal(r.state.subjects["SUBJ-0001"].visibleForMs, 100);
  assert.ok(!r.events.some((e) => e.type === "subject.created"), "no re-crea");
});

test("dos rostros distintos mantienen IDs separados y estables", () => {
  const tr = createTracker();
  let r = tr.update([det(100, 100), det(900, 500)], emptyWorldState(), 1000, frame);
  const first = { ...r.state.subjects };
  r = tr.update([det(110, 105), det(905, 495)], r.state, 1100, frame);
  assert.deepEqual(Object.keys(r.state.subjects).sort(), ["SUBJ-0001", "SUBJ-0002"]);
  const near = Object.values(r.state.subjects).find((s) => s.center.x < 500);
  assert.equal(near.id, Object.values(first).find((s) => s.center.x < 500).id);
});
