import { emptyWorldState } from "./worldstate.js";

const area = (b) => b.w * b.h;
const centerOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Pure multi-object tracker. Greedy nearest-centroid matching within a gate
// proportional to face size, so IDs stay stable frame to frame. No side
// effects: returns the next WorldState plus the events the caller publishes.
export function createTracker({ ttlMs = 600, matchFactor = 1.5 } = {}) {
  let counter = 0;
  const nextId = () => `SUBJ-${String(++counter).padStart(4, "0")}`;

  return {
    update(detections, prevState = emptyWorldState(), nowMs = 0, frame = prevState.frame) {
      const events = [];
      const prev = prevState.subjects || {};
      const prevList = Object.values(prev);
      const used = new Set();
      const subjects = {};

      // 1) Match each detection to the closest unused prev subject within gate.
      for (const d of detections) {
        const c = centerOf(d.bbox);
        const gate = Math.max(d.bbox.w, d.bbox.h) * matchFactor;
        let best = null, bestD = Infinity;
        for (const p of prevList) {
          if (used.has(p.id)) continue;
          const dd = dist(c, p.center);
          if (dd < gate && dd < bestD) { best = p; bestD = dd; }
        }
        if (best) {
          used.add(best.id);
          subjects[best.id] = {
            ...best, bbox: d.bbox, center: c, confidence: d.confidence,
            lastSeen: nowMs, visibleForMs: nowMs - best.firstSeen,
            landmarks: d.landmarks ?? null, matrix: d.matrix ?? null, lm: d.lm ?? null,
          };
        } else {
          const id = nextId();
          subjects[id] = {
            id, bbox: d.bbox, center: c, confidence: d.confidence,
            firstSeen: nowMs, lastSeen: nowMs, visibleForMs: 0, isPrimary: false,
            orientation: "FRONTAL", pose: { yaw: 0, pitch: 0, roll: 0 },
            eyeContact: "UNKNOWN", motion: "STATIC", landmarks: d.landmarks ?? null, matrix: d.matrix ?? null, lm: d.lm ?? null,
          };
          events.push({ type: "subject.created", payload: subjects[id] });
        }
      }

      // 2) Carry unmatched prev subjects until TTL, then drop + emit lost.
      for (const p of prevList) {
        if (used.has(p.id) || subjects[p.id]) continue;
        if (nowMs - p.lastSeen <= ttlMs) subjects[p.id] = p;
        else events.push({ type: "subject.lost", payload: p });
      }

      // 3) Primary = largest bbox among the currently visible (seen this frame).
      let primaryId = null, bestArea = -1;
      for (const s of Object.values(subjects)) {
        s.isPrimary = false;
        if (s.lastSeen === nowMs && area(s.bbox) > bestArea) { bestArea = area(s.bbox); primaryId = s.id; }
      }
      if (primaryId) subjects[primaryId].isPrimary = true;

      if (detections.length > 0) events.push({ type: "vision.faceDetected", payload: { count: detections.length } });

      return { state: { subjects, primaryId, frame, updatedAt: nowMs }, events };
    },
  };
}
