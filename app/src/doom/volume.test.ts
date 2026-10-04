import { test } from "node:test";
import assert from "node:assert/strict";
import { VOLUME_DEFAULT, clampVolume, readSettings, gainFor } from "./volume";

test("clampVolume snaps to multiples of 5 within 0..100", () => {
  assert.equal(clampVolume(62), 60);
  assert.equal(clampVolume(65), 65);
  assert.equal(clampVolume(101), 100);
  assert.equal(clampVolume(-3), 0);
});

test("clampVolume falls back to the default for non-numbers", () => {
  assert.equal(clampVolume("x"), VOLUME_DEFAULT);
  assert.equal(clampVolume(undefined), VOLUME_DEFAULT);
  assert.equal(clampVolume(NaN), VOLUME_DEFAULT);
});

test("readSettings returns the saved volume when the file is valid", () => {
  assert.deepEqual(readSettings('{"volume":40}'), { volume: 40, repaired: false });
});

test("readSettings repairs a broken file to the default", () => {
  assert.deepEqual(readSettings("no es json"), { volume: 60, repaired: true });
  assert.deepEqual(readSettings(null), { volume: 60, repaired: true });
  assert.deepEqual(readSettings('{"volume":"mucho"}'), { volume: 60, repaired: true });
});

test("gainFor maps the volume to a 0..1 factor", () => {
  assert.equal(gainFor(60), 0.6);
  assert.equal(gainFor(0), 0);
  assert.equal(gainFor(100), 1);
});
