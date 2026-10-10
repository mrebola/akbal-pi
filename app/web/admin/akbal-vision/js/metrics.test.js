import { test } from "node:test";
import assert from "node:assert/strict";
import { IDX, ear, eyeOpenness, mar, mouthOpen, gaze, faceCoverage, proximity, positionPct, motionVector, createMetricsHistory, computeMetrics } from "./metrics.js";

// Build a 478-slot landmark array; set only the indices we test.
function lmWith(points) {
  const a = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
  for (const [i, p] of Object.entries(points)) a[i] = p;
  return a;
}

test("ear: ojo abierto ~0.3 (vertical/horizontal)", () => {
  const openL = lmWith({ [IDX.LEFT.top]: { x: 0.5, y: 0.40 }, [IDX.LEFT.bottom]: { x: 0.5, y: 0.46 }, [IDX.LEFT.outer]: { x: 0.40, y: 0.43 }, [IDX.LEFT.inner]: { x: 0.60, y: 0.43 } });
  assert.ok(Math.abs(ear(openL, IDX.LEFT) - 0.3) < 0.01);
  assert.ok(eyeOpenness(openL, IDX.LEFT) >= 95);
});

test("eyeOpenness: null si faltan los landmarks (todo en 0,0)", () => {
  assert.equal(ear(lmWith({}), IDX.LEFT), null);
});

test("mar/mouthOpen: boca abierta", () => {
  const open = lmWith({ [IDX.MOUTH.top]: { x: 0.5, y: 0.60 }, [IDX.MOUTH.bottom]: { x: 0.5, y: 0.72 }, [IDX.MOUTH.left]: { x: 0.42, y: 0.66 }, [IDX.MOUTH.right]: { x: 0.58, y: 0.66 } });
  assert.ok(mouthOpen(open).open === true);
});

test("faceCoverage/proximity/position: sin dividir por cero", () => {
  assert.equal(faceCoverage({ x: 0, y: 0, w: 0, h: 0 }, { w: 0, h: 0 }), 0);
  const cov = faceCoverage({ x: 0, y: 0, w: 640, h: 360 }, { w: 1280, h: 720 });
  assert.ok(Math.abs(cov - 25) < 0.1);
  assert.equal(proximity(5), "FAR");
  assert.equal(proximity(15), "MEDIUM");
  assert.equal(proximity(40), "NEAR");
  assert.deepEqual(positionPct({ x: 320, y: 180, w: 640, h: 360 }, { w: 1280, h: 720 }), { x: 50, y: 50 });
});

test("motionVector: null sin prev; magnitud/ángulo con prev", () => {
  assert.equal(motionVector(null, { x: 10, y: 10 }), null);
  const v = motionVector({ x: 0, y: 0 }, { x: 10, y: 0 });
  assert.ok(Math.abs(v.mag - 10) < 1e-6 && Math.abs(v.angleDeg - 0) < 1e-6);
});

test("gaze: frontal + iris centrado = CAMERA; UNKNOWN sin iris", () => {
  const centered = lmWith({ [IDX.LEFT.outer]: { x: 0.40, y: 0.43 }, [IDX.LEFT.inner]: { x: 0.60, y: 0.43 }, [IDX.LEFT.iris]: { x: 0.50, y: 0.43 }, [IDX.RIGHT.outer]: { x: 0.80, y: 0.43 }, [IDX.RIGHT.inner]: { x: 0.70, y: 0.43 }, [IDX.RIGHT.iris]: { x: 0.75, y: 0.43 } });
  assert.equal(gaze(centered, { yaw: 2, pitch: 1, roll: 0 }), "CAMERA");
  assert.equal(gaze(lmWith({}), { yaw: 0, pitch: 0, roll: 0 }), "UNKNOWN");
});

const lmOpen = lmWith({ [IDX.LEFT.top]: { x: 0.5, y: 0.40 }, [IDX.LEFT.bottom]: { x: 0.5, y: 0.46 }, [IDX.LEFT.outer]: { x: 0.4, y: 0.43 }, [IDX.LEFT.inner]: { x: 0.6, y: 0.43 }, [IDX.RIGHT.top]: { x: 0.5, y: 0.40 }, [IDX.RIGHT.bottom]: { x: 0.5, y: 0.46 }, [IDX.RIGHT.outer]: { x: 0.8, y: 0.43 }, [IDX.RIGHT.inner]: { x: 0.7, y: 0.43 } });
const lmClosed = lmWith({ [IDX.LEFT.top]: { x: 0.5, y: 0.425 }, [IDX.LEFT.bottom]: { x: 0.5, y: 0.435 }, [IDX.LEFT.outer]: { x: 0.4, y: 0.43 }, [IDX.LEFT.inner]: { x: 0.6, y: 0.43 }, [IDX.RIGHT.top]: { x: 0.5, y: 0.425 }, [IDX.RIGHT.bottom]: { x: 0.5, y: 0.435 }, [IDX.RIGHT.outer]: { x: 0.8, y: 0.43 }, [IDX.RIGHT.inner]: { x: 0.7, y: 0.43 } });
const S = (id, lm, center = { x: 100, y: 100 }) => ({ id, lm, center, bbox: { x: 60, y: 60, w: 80, h: 80 } });
const frame = { w: 1280, h: 720 };

test("blink: flanco abierto→cerrado→abierto cuenta 1 parpadeo", () => {
  const h = createMetricsHistory();
  let subs = { A: S("A", lmOpen) };
  computeMetrics(subs, {}, frame, h, 1000);
  assert.equal(subs.A.blink, false);
  subs = { A: S("A", lmClosed) };
  computeMetrics(subs, { A: S("A", lmOpen) }, frame, h, 1100);
  subs = { A: S("A", lmOpen) };
  const out = computeMetrics(subs, { A: S("A", lmClosed) }, frame, h, 1200);
  assert.equal(out.A.blink, true);
});

test("history se poda: un ID que ya no está deja de ocupar memoria (kiosk 24/7)", () => {
  const h = createMetricsHistory();
  computeMetrics({ A: S("A", lmOpen) }, {}, frame, h, 1000);
  assert.equal(h.size, 1);
  computeMetrics({}, { A: S("A", lmOpen) }, frame, h, 1100); // A ya no está
  assert.equal(h.size, 0);
});

test("blinkRate null hasta ~10s; coverage/quality presentes", () => {
  const h = createMetricsHistory();
  const out = computeMetrics({ A: S("A", lmOpen) }, {}, frame, h, 1000);
  assert.equal(out.A.blinkRate, null);
  assert.ok(out.A.coverage > 0 && out.A.trackQuality >= 0 && out.A.landmarkQuality >= 0);
});
