import { test } from "node:test";
import assert from "node:assert/strict";
import { bootView } from "./ui.js";

const steps = (cam, vis) => [
  { label: "CAMERA", ok: cam }, { label: "VISION", ok: vis },
  { label: "TRACKER", ok: true }, { label: "RENDERER", ok: true },
];

test("todo OK: overlay se oculta y muestra SYSTEM READY", () => {
  const v = bootView(steps(true, true), true);
  assert.equal(v.hidden, true);
  assert.match(v.text, /SYSTEM READY/);
});

test("arrancando (no done): overlay visible, pasos pendientes con … y sin FAIL", () => {
  const v = bootView(steps(false, false), false);
  assert.equal(v.hidden, false);
  assert.match(v.text, /CAMERA.*…/);
  assert.doesNotMatch(v.text, /FAIL/);
});

test("fallo terminal (done con un paso en false): overlay visible, FAIL y SYSTEM ERROR legible", () => {
  const v = bootView(steps(false, true), true);
  assert.equal(v.hidden, false, "no debe quedar colgado en spinner ni ocultarse a video en blanco");
  assert.match(v.text, /CAMERA.*FAIL/);
  assert.match(v.text, /SYSTEM ERROR/);
});
