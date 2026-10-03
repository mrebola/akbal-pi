import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, isSafeEntryName, verifyManifest } from "./format";

const files = {
  "session.json": Buffer.from('{"id":"drive-1"}'),
  "track.json": Buffer.from("[]"),
};

test("the manifest lists every file with its sha256 and the format version", () => {
  const m = buildManifest(files, { credentials: false, origin: "akbal-pi" });
  assert.equal(m.formatVersion, 1);
  assert.equal(m.credentials, false);
  assert.equal(m.files["session.json"].sha256.length, 64);
});

test("a package that matches its manifest verifies", () => {
  const m = buildManifest(files, { credentials: false, origin: "akbal-pi" });
  assert.deepEqual(verifyManifest(m, files), { ok: true });
});

test("an altered file is rejected", () => {
  const m = buildManifest(files, { credentials: false, origin: "akbal-pi" });
  const tampered = { ...files, "track.json": Buffer.from("[1]") };
  assert.equal(verifyManifest(m, tampered).ok, false);
});

test("a missing or extra file is rejected", () => {
  const m = buildManifest(files, { credentials: false, origin: "akbal-pi" });
  assert.equal(verifyManifest(m, { "session.json": files["session.json"] }).ok, false);
  assert.equal(verifyManifest(m, { ...files, "extra.json": Buffer.from("x") }).ok, false);
});

test("entry names that leave the package are refused", () => {
  assert.equal(isSafeEntryName("../../etc/passwd"), false);
  assert.equal(isSafeEntryName("/etc/passwd"), false);
  assert.equal(isSafeEntryName("captures/..\\x"), false);
  assert.equal(isSafeEntryName("track.json"), true);
  assert.equal(isSafeEntryName("captures/net-1.cap"), true);
});
