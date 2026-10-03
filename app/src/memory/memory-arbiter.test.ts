import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryArbiter } from "./memory-arbiter";

test("starts owned by the device", () => {
  assert.equal(new MemoryArbiter().owner(), "device");
});

test("a web request takes memory, unloads everything and loads the web model", () => {
  const arb = new MemoryArbiter();
  const d = arb.requestWeb();
  assert.equal(d.unloadAll, true);
  assert.equal(d.loadModel, "web");
  assert.equal(d.cancel, "device");
  assert.equal(arb.owner(), "web");
});

test("a web request while web already owns memory does not reload anything", () => {
  const arb = new MemoryArbiter();
  arb.requestWeb();
  const d = arb.requestWeb();
  assert.equal(d.unloadAll, false);
  assert.equal(d.loadModel, null);
  assert.equal(d.cancel, null);
});

test("a device long press takes memory back from web and cancels the web reply", () => {
  const arb = new MemoryArbiter();
  arb.requestWeb();
  const d = arb.preemptDevice();
  assert.equal(d.cancel, "web");
  assert.equal(d.unloadAll, true);
  assert.equal(d.loadModel, "device");
  assert.equal(arb.owner(), "device");
});

test("a device long press while the device already owns memory is a no-op", () => {
  const arb = new MemoryArbiter();
  const d = arb.preemptDevice();
  assert.equal(d.unloadAll, false);
  assert.equal(d.loadModel, null);
  assert.equal(d.cancel, null);
});

test("release by the non-owner is ignored", () => {
  const arb = new MemoryArbiter();
  arb.requestWeb();
  arb.release("device");
  assert.equal(arb.owner(), "web");
});

test("release by web hands memory back to the device without loading it", () => {
  const arb = new MemoryArbiter();
  arb.requestWeb();
  arb.release("web");
  assert.equal(arb.owner(), "device");
});
