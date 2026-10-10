import { test } from "node:test";
import assert from "node:assert/strict";
import { EST_ALLOWLIST, filterEstimates, nullEstimator } from "./estimator.js";

test("allowlist excluye categorías prohibidas", () => {
  for (const banned of ["criminality", "threat", "danger", "intent", "personality", "politics", "religion", "sexualOrientation", "medical", "iq", "mentalState"]) {
    assert.ok(!EST_ALLOWLIST.has(banned), `${banned} jamás permitido`);
  }
  assert.ok(EST_ALLOWLIST.has("ageRange") && EST_ALLOWLIST.has("genderApparent"));
});

test("filterEstimates descarta claves fuera de la allowlist", () => {
  const clean = filterEstimates({ ageRange: { value: "25–34", confidence: 0.7 }, threat: { value: "HIGH", confidence: 0.9 } });
  assert.ok(clean.ageRange);
  assert.ok(!("threat" in clean));
});

test("nullEstimator devuelve vacío", async () => {
  assert.deepEqual(await nullEstimator.estimate({ A: {} }, null), {});
});
