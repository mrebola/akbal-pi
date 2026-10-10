export const LEGEND = "MEASURED = direct visual measurement · EST. = probabilistic visual estimate";

// Allowlist of estimate keys we are willing to display (ethics: nothing about
// criminality/threat/intent/personality/intelligence/mental state/politics/
// religion/sexual orientation/medical is here — those are irrepresentable).
const EST_LABELS = {
  ageRange: "AGE RANGE", genderApparent: "GENDER APPEAR.", glasses: "GLASSES", mask: "MASK",
  beard: "BEARD", hat: "HAT", expression: "EXPRESSION", occlusion: "OCCLUSION",
};

const fmtMs = (ms) => {
  const s = Math.floor(ms / 1000), p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
const n1 = (v) => (v == null ? "—" : (Math.round(v * 10) / 10).toString());
// 8-way arrow from a screen-space angle (0°=right, 90°=down).
const ARROWS = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];
const arrow = (deg) => ARROWS[(Math.round(((deg % 360) + 360) % 360 / 45)) % 8];

export function buildReport(s) {
  const motionDir = s.motionVec && s.motionVec.mag > 2 ? ` ${arrow(s.motionVec.angleDeg)}` : "";
  const measured = [
    { label: "STATUS", value: "TRACKING" },
    { label: "VISIBLE", value: fmtMs(s.visibleForMs || 0) },
    { label: "HEAD POSE", value: `Y${n1(s.pose?.yaw)} P${n1(s.pose?.pitch)} R${n1(s.pose?.roll)}` },
    { label: "GAZE", value: s.gaze || "UNKNOWN" },
    { label: "EYES", value: `L ${s.eyeL == null ? "—" : s.eyeL + "%"}  R ${s.eyeR == null ? "—" : s.eyeR + "%"}` },
    { label: "BLINK", value: `${s.blink ? "YES" : "NO"}${s.blinkRate != null ? `  (${s.blinkRate}/min)` : ""}` },
    { label: "MOUTH", value: s.mouth == null ? "—" : s.mouth.open ? `OPEN ${s.mouth.pct}%` : "CLOSED" },
    { label: "MOTION", value: `${s.motion || "STATIC"}${motionDir}` },
    { label: "POSITION", value: s.position ? `${s.position.x},${s.position.y}` : "—" },
    { label: "FACE COVERAGE", value: `${s.coverage ?? 0}%  ${s.proximity || ""}`.trim() },
    { label: "TRACK QUALITY", value: `${s.trackQuality ?? 0}%` },
    { label: "LANDMARK QUALITY", value: `${s.landmarkQuality ?? 0}%` },
  ];
  const est = s.estimates || {};
  const estimated = Object.keys(EST_LABELS)
    .filter((k) => est[k])
    .map((k) => ({ label: EST_LABELS[k], value: String(est[k].value), confidence: est[k].confidence }));
  if (estimated.length === 0) estimated.push({ label: "—", value: "MODEL NOT LOADED" });
  return { measured, estimated };
}
