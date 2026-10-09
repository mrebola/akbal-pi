import { test } from "node:test";
import assert from "node:assert/strict";
import { headPose, poseState, eyeContactState, motionState, SELECTED_LANDMARKS, annotate } from "./analysis.js";

// Column-major 4x4 from a 3x3 rotation R (r[row][col]); translation 0.
function mat(R) {
  const m = new Array(16).fill(0); m[15] = 1;
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = R[r][c];
  return m;
}
const deg = (d) => (d * Math.PI) / 180;
const Ry = (t) => [[Math.cos(t), 0, Math.sin(t)], [0, 1, 0], [-Math.sin(t), 0, Math.cos(t)]];
const Rx = (t) => [[1, 0, 0], [0, Math.cos(t), -Math.sin(t)], [0, Math.sin(t), Math.cos(t)]];
const Rz = (t) => [[Math.cos(t), -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0], [0, 0, 1]];

test("headPose: identidad -> 0,0,0; vacío -> 0,0,0", () => {
  const z = headPose(mat([[1, 0, 0], [0, 1, 0], [0, 0, 1]]));
  assert.ok(Math.abs(z.yaw) < 1e-6 && Math.abs(z.pitch) < 1e-6 && Math.abs(z.roll) < 1e-6);
  assert.deepEqual(headPose(null), { yaw: 0, pitch: 0, roll: 0 });
  assert.deepEqual(headPose([]), { yaw: 0, pitch: 0, roll: 0 });
});

test("headPose: recupera yaw/pitch/roll de rotaciones puras", () => {
  assert.ok(Math.abs(headPose(mat(Ry(deg(30)))).yaw - 30) < 0.5);
  assert.ok(Math.abs(headPose(mat(Rx(deg(20)))).pitch - 20) < 0.5);
  assert.ok(Math.abs(headPose(mat(Rz(deg(15)))).roll - 15) < 0.5);
});

test("poseState: frontal vs ejes dominantes", () => {
  assert.equal(poseState({ yaw: 3, pitch: -4, roll: 2 }), "FRONTAL");
  assert.equal(poseState({ yaw: 30, pitch: 0, roll: 0 }), "RIGHT");
  assert.equal(poseState({ yaw: -30, pitch: 0, roll: 0 }), "LEFT");
  assert.equal(poseState({ yaw: 0, pitch: 30, roll: 0 }), "DOWN");
  assert.equal(poseState({ yaw: 0, pitch: -30, roll: 0 }), "UP");
});

test("eyeContactState: frontal mira; desviado no; null = UNKNOWN", () => {
  assert.equal(eyeContactState({ yaw: 5, pitch: 5 }), "LOOKING");
  assert.equal(eyeContactState({ yaw: 25, pitch: 0 }), "NOT_LOOKING");
  assert.equal(eyeContactState(null), "UNKNOWN");
});

test("motionState: sin prev = STATIC; buckets por delta normalizado", () => {
  const diag = 1000;
  assert.equal(motionState(null, { x: 10, y: 10 }, diag), "STATIC");
  assert.equal(motionState({ x: 10, y: 10 }, { x: 11, y: 10 }, diag), "STATIC"); // 0.001
  assert.equal(motionState({ x: 0, y: 0 }, { x: 10, y: 0 }, diag), "LOW"); // 0.01
  assert.equal(motionState({ x: 0, y: 0 }, { x: 35, y: 0 }, diag), "MEDIUM"); // 0.035
  assert.equal(motionState({ x: 0, y: 0 }, { x: 80, y: 0 }, diag), "HIGH"); // 0.08
});

test("SELECTED_LANDMARKS es un set chico de índices", () => {
  assert.ok(Array.isArray(SELECTED_LANDMARKS) && SELECTED_LANDMARKS.length > 0 && SELECTED_LANDMARKS.length <= 16);
});

const subj = (id, extra = {}) => ({ id, center: { x: 100, y: 100 }, matrix: null, landmarks: null, ...extra });

test("annotate rellena los campos y motion usa el center previo", () => {
  const prev = { "SUBJ-0001": subj("SUBJ-0001", { center: { x: 0, y: 0 } }) };
  const cur = { "SUBJ-0001": subj("SUBJ-0001", { center: { x: 80, y: 0 } }) };
  const { subjects } = annotate(cur, prev, 1000);
  assert.equal(subjects["SUBJ-0001"].motion, "HIGH");
  assert.equal(subjects["SUBJ-0001"].orientation, "FRONTAL"); // matrix null → yaw/pitch 0
  assert.equal(subjects["SUBJ-0001"].eyeContact, "UNKNOWN"); // sin matriz → UNKNOWN
});

test("annotate emite subject.eyeContact solo al ENTRAR a LOOKING", () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; // column-major → frontal → LOOKING
  const looking = (id) => subj(id, { matrix: identity });
  let r = annotate({ "SUBJ-0001": looking("SUBJ-0001") }, {}, 1000);
  assert.ok(r.events.some((e) => e.type === "subject.eyeContact" && e.payload.id === "SUBJ-0001"));
  r = annotate({ "SUBJ-0001": looking("SUBJ-0001") }, r.subjects, 1000);
  assert.ok(!r.events.some((e) => e.type === "subject.eyeContact"));
});
