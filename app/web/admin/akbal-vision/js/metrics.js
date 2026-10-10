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

const BLINK_OPEN = 60, BLINK_CLOSED = 20; // openness % hysteresis
const BLINKRATE_MIN_MS = 10000;

export function createMetricsHistory() { return new Map(); } // id -> {eyeOpen, blinks:[], firstSeen, seenPrev, episodes}

// Writes MEASURED metric fields onto each subject (from its lm + previous
// center) and advances per-id temporal state in `history` (blink FSM, blink
// timestamps, visible episodes). Pure w.r.t. inputs; `history` is the explicit
// accumulator the caller owns.
export function computeMetrics(subjects, prevSubjects = {}, frame = { w: 0, h: 0 }, history = createMetricsHistory(), nowMs = 0) {
  for (const s of Object.values(subjects)) {
    const lm = s.lm || null;
    s.eyeL = eyeOpenness(lm, IDX.LEFT);
    s.eyeR = eyeOpenness(lm, IDX.RIGHT);
    s.mouth = mouthOpen(lm);
    s.gaze = gaze(lm, s.pose);
    s.coverage = faceCoverage(s.bbox, frame);
    s.proximity = proximity(s.coverage);
    s.position = positionPct(s.bbox, frame);
    const prev = prevSubjects[s.id] || null;
    s.motionVec = motionVector(prev ? prev.center : null, s.center);
    const keys = [IDX.LEFT.top, IDX.LEFT.bottom, IDX.RIGHT.top, IDX.RIGHT.bottom, IDX.MOUTH.top, IDX.MOUTH.left, IDX.LEFT.iris, IDX.RIGHT.iris];
    s.landmarkQuality = lm ? Math.round((keys.filter((i) => has(lm, i)).length / keys.length) * 100) : 0;

    let h = history.get(s.id);
    if (!h) { h = { eyeOpen: true, blinks: [], firstSeen: nowMs, seenPrev: false }; history.set(s.id, h); }

    const open = [s.eyeL, s.eyeR].filter((v) => v != null);
    const avg = open.length ? open.reduce((a, b) => a + b, 0) / open.length : 100;
    let blink = false;
    if (h.eyeOpen && avg < BLINK_CLOSED) h.eyeOpen = false;
    else if (!h.eyeOpen && avg > BLINK_OPEN) { h.eyeOpen = true; h.blinks.push(nowMs); blink = true; }
    s.blink = blink;

    const windowMs = nowMs - h.firstSeen;
    h.blinks = h.blinks.filter((t) => nowMs - t <= 60000);
    s.blinkRate = windowMs >= BLINKRATE_MIN_MS ? Math.round((h.blinks.length / (windowMs / 60000)) * 10) / 10 : null;

    // Real signal: landmark presence × detection continuity (no fake score).
    s.trackQuality = Math.round(s.landmarkQuality * (h.seenPrev ? 1 : 0.8));
  }
  // Advance continuity + prune history for ids no longer tracked (bounds memory
  // on a 24/7 kiosk, since subject ids are never reused).
  for (const [id, h] of history) {
    if (subjects[id]) h.seenPrev = true;
    else history.delete(id);
  }
  return subjects;
}
