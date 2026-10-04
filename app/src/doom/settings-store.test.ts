import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVolume, saveVolume } from "./settings-store";
import { VOLUME_DEFAULT } from "./volume";

function freshDir(): string {
  return join(mkdtempSync(join(tmpdir(), "doom-settings-")), "doom");
}

test("saveVolume writes a clamped value that loadVolume reads back", () => {
  const dir = freshDir();
  saveVolume(dir, 37);
  assert.equal(loadVolume(dir), 35);
  assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).volume, 35);
});

test("a missing file loads the default and writes a valid file", () => {
  const dir = freshDir();
  assert.equal(loadVolume(dir), VOLUME_DEFAULT);
  assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).volume, VOLUME_DEFAULT);
});

test("a broken file loads the default and is repaired on disk", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), "no es json");
  assert.equal(loadVolume(dir), VOLUME_DEFAULT);
  assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).volume, VOLUME_DEFAULT);
});
