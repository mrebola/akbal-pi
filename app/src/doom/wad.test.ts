import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GAME, DOOM_GAMES, wadFileName } from "./wad";

test("the only game is the original DOOM, with its WAD file", () => {
  assert.deepEqual(DOOM_GAMES, ["doom1"]);
  assert.equal(DEFAULT_GAME, "doom1");
  assert.equal(wadFileName("doom1"), "Doom1.WAD");
});
