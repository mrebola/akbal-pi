// The ONLY estimate keys that may ever be displayed. Ethics boundary: anything
// about criminality, threat, intent, personality, intelligence, mental state,
// politics, religion, sexual orientation or medical conditions is NOT here and
// MUST NOT be added — it is irrepresentable by design.
export const EST_ALLOWLIST = new Set([
  "ageRange", "genderApparent", "glasses", "mask", "beard", "hat",
  "expression", "occlusion", "gazeProb", "eyeClosedProb", "mouthOpenProb",
  "talkingProb", "nearbyObject",
]);

export function filterEstimates(raw) {
  const clean = {};
  for (const k of Object.keys(raw || {})) if (EST_ALLOWLIST.has(k)) clean[k] = raw[k];
  return clean;
}

// Phase A: no model loaded. Phase B swaps this for an ONNX Runtime Web / TF.js
// estimator with the same shape, run throttled and primary-only; its output is
// always passed through filterEstimates() before display.
export const nullEstimator = {
  async estimate(_subjects, _video) { return {}; },
};
