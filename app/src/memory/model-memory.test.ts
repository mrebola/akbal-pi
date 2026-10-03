import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDecision, releaseToDevice } from "./model-memory";

const fake = () => {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      unloadAll: async () => {
        calls.push("unloadAll");
      },
      warm: async (model: string, keepAlive: number) => {
        calls.push(`warm:${model}:${keepAlive}`);
      },
    },
  };
};

test("web decision unloads first, then warms only the web model with keep_alive -1", async () => {
  const f = fake();
  await applyDecision({ cancel: "device", unloadAll: true, loadModel: "web" }, { device: "voz", web: "chat" }, f.deps);
  assert.deepEqual(f.calls, ["unloadAll", "warm:chat:-1"]);
});

test("device decision unloads first, then warms the voice model with keep_alive -1", async () => {
  const f = fake();
  await applyDecision({ cancel: "web", unloadAll: true, loadModel: "device" }, { device: "voz", web: "chat" }, f.deps);
  assert.deepEqual(f.calls, ["unloadAll", "warm:voz:-1"]);
});

test("a no-op decision touches nothing", async () => {
  const f = fake();
  await applyDecision({ cancel: null, unloadAll: false, loadModel: null }, { device: "voz", web: "chat" }, f.deps);
  assert.deepEqual(f.calls, []);
});

test("releaseToDevice unloads everything and loads nothing", async () => {
  const f = fake();
  await releaseToDevice(f.deps);
  assert.deepEqual(f.calls, ["unloadAll"]);
});
