// Pure MEASURED facial metrics from MediaPipe FaceLandmarker (normalized lm[]).
// Never throws; returns null / safe values when landmarks are missing.
export const IDX = {
  LEFT:  { top: 159, bottom: 145, outer: 33, inner: 133, iris: 468 },
  RIGHT: { top: 386, bottom: 374, outer: 263, inner: 362, iris: 473 },
  MOUTH: { top: 13, bottom: 14, left: 61, right: 291 },
};
const EAR_CLOSED = 0.1, EAR_OPEN = 0.3, MAR_OPEN = 0.35;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const dist = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0);
const has = (lm, i) => lm && lm[i] && (lm[i].x !== 0 || lm[i].y !== 0);

export function ear(lm, eye) {
  if (!has(lm, eye.top) || !has(lm, eye.bottom) || !has(lm, eye.outer) || !has(lm, eye.inner)) return null;
  const h = dist(lm[eye.outer], lm[eye.inner]);
  if (h === 0) return null;
  return dist(lm[eye.top], lm[eye.bottom]) / h;
}
export function eyeOpenness(lm, eye) {
  const e = ear(lm, eye);
  return e == null ? null : Math.round(clamp01((e - EAR_CLOSED) / (EAR_OPEN - EAR_CLOSED)) * 100);
}
export function mar(lm) {
  if (!has(lm, IDX.MOUTH.left) || !has(lm, IDX.MOUTH.right)) return null;
  const w = dist(lm[IDX.MOUTH.left], lm[IDX.MOUTH.right]);
  if (w === 0) return null;
  return dist(lm[IDX.MOUTH.top], lm[IDX.MOUTH.bottom]) / w;
}
export function mouthOpen(lm) {
  const m = mar(lm);
  return m == null ? null : { pct: Math.round(clamp01(m / 0.6) * 100), open: m > MAR_OPEN };
}
export function gaze(lm, pose) {
  const r = (eye) => (has(lm, eye.iris) && has(lm, eye.outer) && has(lm, eye.inner)
    ? (lm[eye.iris].x - lm[eye.outer].x) / ((lm[eye.inner].x - lm[eye.outer].x) || 1)
    : null);
  const l = r(IDX.LEFT), rr = r(IDX.RIGHT);
  if (l == null && rr == null) return "UNKNOWN";
  if (pose) {
    if (pose.yaw <= -15) return "LEFT";
    if (pose.yaw >= 15) return "RIGHT";
    if (pose.pitch >= 15) return "DOWN";
    if (pose.pitch <= -15) return "UP";
  }
  const avg = ((l ?? 0.5) + (rr ?? 0.5)) / 2; // ~0.5 centered
  if (avg < 0.35) return "LEFT";
  if (avg > 0.65) return "RIGHT";
  return "CAMERA";
}
export function faceCoverage(bbox, frame) {
  const fa = (frame?.w || 0) * (frame?.h || 0);
  if (fa === 0) return 0;
  return Math.round(((bbox.w * bbox.h) / fa) * 1000) / 10;
}
export function proximity(coveragePct) {
  if (coveragePct >= 30) return "NEAR";
  if (coveragePct >= 10) return "MEDIUM";
  return "FAR";
}
export function positionPct(bbox, frame) {
  const w = frame?.w || 1, h = frame?.h || 1;
  return { x: Math.round(((bbox.x + bbox.w / 2) / w) * 100), y: Math.round(((bbox.y + bbox.h / 2) / h) * 100) };
}
export function motionVector(prevCenter, curCenter) {
  if (!prevCenter) return null;
  const dx = curCenter.x - prevCenter.x, dy = curCenter.y - prevCenter.y;
  return { mag: Math.hypot(dx, dy), angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI };
}
