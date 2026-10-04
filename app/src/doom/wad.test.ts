import { test } from "node:test";
import assert from "node:assert/strict";
import { wadFileName, pickDefaultGame } from "./wad";

test("each game maps to its WAD file", () => {
  assert.equal(wadFileName("doom1"), "Doom1.WAD");
  assert.equal(wadFileName("freedoom1"), "freedoom1.wad");
});

test("the default game is doom1 when its WAD exists, freedoom1 otherwise", () => {
  assert.equal(pickDefaultGame(() => true), "doom1");
  assert.equal(pickDefaultGame((g) => g === "freedoom1"), "freedoom1");
  assert.equal(pickDefaultGame(() => false), "freedoom1");
});
