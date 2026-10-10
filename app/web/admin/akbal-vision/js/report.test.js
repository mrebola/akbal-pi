import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, LEGEND } from "./report.js";

const subj = {
  id: "SUBJ-0001", confidence: 0.982, visibleForMs: 77000, appearances: 2,
  pose: { yaw: -12.4, pitch: 4.8, roll: -2.1 }, gaze: "CAMERA", eyeL: 82, eyeR: 79,
  blink: false, mouth: { pct: 10, open: false }, motion: "LOW", coverage: 18.7, proximity: "MEDIUM",
  position: { x: 50, y: 42 }, trackQuality: 94, landmarkQuality: 97, estimates: {},
};

test("buildReport: measured con valores reales; estimated placeholder si vacío", () => {
  const r = buildReport(subj);
  // DETECTION/APPEARANCES se quitaron: no son medibles de verdad (no hay score
  // por rostro en FaceLandmarker; apariciones requeriría identidad, prohibida).
  assert.ok(!r.measured.find((x) => /DETECTION/i.test(x.label)));
  assert.ok(!r.measured.find((x) => /APPEARANCES/i.test(x.label)));
  assert.ok(r.measured.find((x) => /COVERAGE/i.test(x.label) && x.value.includes("18.7")));
  assert.equal(r.estimated.length, 1);
  assert.match(r.estimated[0].value, /MODEL NOT LOADED/);
});

test("buildReport: BLINK conserva el rate (sin bug de precedencia)", () => {
  const r = buildReport({ ...subj, blink: false, blinkRate: 14 });
  const blink = r.measured.find((x) => /BLINK/i.test(x.label));
  assert.match(blink.value, /NO/);
  assert.match(blink.value, /14\/min/);
});

test("buildReport: MOTION muestra dirección cuando hay vector", () => {
  const r = buildReport({ ...subj, motion: "MEDIUM", motionVec: { mag: 20, angleDeg: 0 } });
  const m = r.measured.find((x) => /MOTION/i.test(x.label));
  assert.match(m.value, /MEDIUM/);
  assert.ok(/[→←↑↓↗↘↖↙]/.test(m.value));
});

test("buildReport: estimated con confidence cuando hay estimates", () => {
  const r = buildReport({ ...subj, estimates: { ageRange: { value: "25–34", confidence: 0.72 }, genderApparent: { value: "MALE", confidence: 0.81 } } });
  const age = r.estimated.find((x) => /AGE/i.test(x.label));
  assert.equal(age.value, "25–34");
  assert.ok(Math.abs(age.confidence - 0.72) < 1e-9);
});

test("LEGEND explica MEASURED y EST.", () => {
  assert.match(LEGEND, /MEASURED/);
  assert.match(LEGEND, /EST\./);
});
