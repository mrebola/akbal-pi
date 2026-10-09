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

test("un rostro ausente se mantiene dentro del TTL y se pierde después", () => {
  const tr = createTracker({ ttlMs: 600 });
  let r = tr.update([det(100, 100)], emptyWorldState(), 1000, frame);
  r = tr.update([], r.state, 1300, frame); // 300ms sin verlo: sigue vivo
  assert.ok(r.state.subjects["SUBJ-0001"], "dentro del TTL sigue");
  assert.ok(!r.events.some((e) => e.type === "subject.lost"));
  r = tr.update([], r.state, 2000, frame); // 700ms sin verlo: perdido
  assert.deepEqual(Object.keys(r.state.subjects), []);
  assert.ok(r.events.some((e) => e.type === "subject.lost" && e.payload.id === "SUBJ-0001"));
});

test("cuadro vacío deja estado sin sujetos y sin primary", () => {
  const tr = createTracker();
  tr.update([det(100, 100)], emptyWorldState(), 1000, frame);
  const r = tr.update([], { subjects: {}, primaryId: null, frame, updatedAt: 0 }, 1000, frame);
  assert.deepEqual(r.state.subjects, {});
  assert.equal(r.state.primaryId, null);
});

test("el bbox de mayor área es el Primary Target", () => {
  const tr = createTracker();
  const r = tr.update([det(100, 100, 80, 80), det(800, 400, 200, 200)], emptyWorldState(), 1000, frame);
  assert.equal(r.state.primaryId, r.state.subjects["SUBJ-0002"].id);
  assert.equal(r.state.subjects["SUBJ-0002"].isPrimary, true);
  assert.equal(r.state.subjects["SUBJ-0001"].isPrimary, false);
});
