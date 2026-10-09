import { test } from "node:test";
import assert from "node:assert/strict";
import { createConfig, MODES } from "./config.js";

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test("defaults: mode HIGH, sin cámara, debug off", () => {
  const c = createConfig(fakeStorage());
  assert.equal(c.mode, "HIGH");
  assert.equal(c.cameraId, null);
  assert.equal(c.debug, false);
  assert.equal(c.current(), MODES.HIGH);
});

test("setMode inválido se ignora; válido persiste y se relee", () => {
  const s = fakeStorage();
  const c = createConfig(s);
  c.setMode("TURBO"); assert.equal(c.mode, "HIGH");
  c.setMode("LOW"); assert.equal(c.mode, "LOW");
  assert.equal(createConfig(s).mode, "LOW");
});

test("setCameraId y setDebug persisten", () => {
  const s = fakeStorage();
  const c = createConfig(s);
  c.setCameraId("cam-1"); c.setDebug(true);
  const c2 = createConfig(s);
  assert.equal(c2.cameraId, "cam-1");
  assert.equal(c2.debug, true);
});

test("sin storage (undefined) usa defaults y no lanza", () => {
  let c;
  assert.doesNotThrow(() => { c = createConfig(undefined); });
  assert.equal(c.mode, "HIGH");
  assert.doesNotThrow(() => c.setMode("LOW"));
  assert.equal(c.mode, "LOW");
});
