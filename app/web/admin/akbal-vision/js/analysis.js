// Pure analysis helpers for Akbal Vision (Hito 2). No DOM/browser.

// Minimal, readable FaceMesh landmark set (eyes, nose tip, mouth, jaw/chin).
export const SELECTED_LANDMARKS = [33, 133, 362, 263, 1, 61, 291, 13, 14, 152, 234, 454];

const DEG = 180 / Math.PI;

// MediaPipe facialTransformationMatrix: 16 numbers, column-major 4x4. The 3x3
// rotation submatrix → Tait-Bryan yaw(Y)/pitch(X)/roll(Z) in degrees. Verified
// against pure Ry/Rx/Rz in the tests. Missing/short matrix → zeros.
export function headPose(matrix16) {
  if (!matrix16 || matrix16.length < 16) return { yaw: 0, pitch: 0, roll: 0 };
  const r = (row, col) => matrix16[col * 4 + row];
  const yaw = Math.atan2(r(0, 2), r(2, 2)) * DEG;
  const pitch = Math.atan2(-r(1, 2), Math.hypot(r(1, 0), r(1, 1))) * DEG;
  const roll = Math.atan2(r(1, 0), r(1, 1)) * DEG;
  return { yaw, pitch, roll };
}

const FRONTAL_DEG = 15;

export function poseState({ yaw, pitch }) {
  if (Math.abs(yaw) < FRONTAL_DEG && Math.abs(pitch) < FRONTAL_DEG) return "FRONTAL";
  if (Math.abs(yaw) >= Math.abs(pitch)) return yaw > 0 ? "RIGHT" : "LEFT";
  return pitch > 0 ? "DOWN" : "UP";
}

const LOOK_DEG = 12;

export function eyeContactState(pose) {
  if (!pose) return "UNKNOWN";
  return Math.abs(pose.yaw) < LOOK_DEG && Math.abs(pose.pitch) < LOOK_DEG ? "LOOKING" : "NOT_LOOKING";
}

// Per-frame bbox-center displacement, normalized by the frame diagonal so it's
// resolution-independent. No previous position (new subject) → STATIC.
export function motionState(prevCenter, curCenter, frameDiag) {
  if (!prevCenter || !frameDiag) return "STATIC";
  const d = Math.hypot(curCenter.x - prevCenter.x, curCenter.y - prevCenter.y) / frameDiag;
  if (d < 0.005) return "STATIC";
  if (d < 0.02) return "LOW";
  if (d < 0.05) return "MEDIUM";
  return "HIGH";
}

// Fills pose/orientation/eyeContact/motion on each subject (from its matrix +
// its previous center) and emits subject.eyeContact only on the transition
// INTO "LOOKING" (not every frame). Pure: returns the same subjects object
// mutated in place plus the events for the caller to publish.
export function annotate(subjects, prevSubjects = {}, frameDiag = 0) {
  const events = [];
  for (const s of Object.values(subjects)) {
    const prev = prevSubjects[s.id] || null;
    const pose = s.matrix ? headPose(s.matrix) : null;
    s.pose = pose || { yaw: 0, pitch: 0, roll: 0 };
    s.orientation = poseState(s.pose);
    s.eyeContact = eyeContactState(pose);
    s.motion = motionState(prev ? prev.center : null, s.center, frameDiag);
    if (s.eyeContact === "LOOKING" && (!prev || prev.eyeContact !== "LOOKING")) {
      events.push({ type: "subject.eyeContact", payload: s });
    }
  }
  return { subjects, events };
}
