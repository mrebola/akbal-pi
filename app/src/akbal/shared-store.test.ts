import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SharedSessions, isSafeSessionId } from "./shared-store";

const newDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "shared-"));
const drive = { id: "drive-7", startedAt: 1000, endedAt: 2000, distanceM: 1500, points: 2, networks: 1, handshakes: 0 };
const files = {
  "drive.json": Buffer.from(JSON.stringify(drive)),
  "track.json": Buffer.from("[]"),
  "networks.json": Buffer.from("[]"),
  "handshakes.json": Buffer.from("[]"),
};
const meta = { origin: "otra-pi", credentials: false };

test("a saved shared session is listed with its trip data and its origin", () => {
  const store = new SharedSessions(newDir());
  store.save("drive-7", files, meta);
  const [item] = store.list();
  assert.equal(item.id, "drive-7");
  assert.equal(item.origin, "otra-pi");
  assert.equal(item.distanceM, 1500);
  assert.equal(item.credentials, false);
});

test("saving the same id twice is refused and writes nothing new", () => {
  const store = new SharedSessions(newDir());
  store.save("drive-7", files, meta);
  assert.throws(() => store.save("drive-7", files, meta), /ya existe/);
});

test("a stored file can be read back, and an unknown one returns null", () => {
  const store = new SharedSessions(newDir());
  store.save("drive-7", files, meta);
  assert.equal(store.read("drive-7", "track.json")?.toString(), "[]");
  assert.equal(store.read("drive-7", "nope.json"), null);
});

test("removing a shared session deletes its folder", () => {
  const dir = newDir();
  const store = new SharedSessions(dir);
  store.save("drive-7", files, meta);
  assert.equal(store.remove("drive-7"), true);
  assert.equal(store.list().length, 0);
});

test("ids that could reach outside the folder are refused", () => {
  assert.equal(isSafeSessionId("drive-7"), true);
  assert.equal(isSafeSessionId("../etc"), false);
  assert.equal(isSafeSessionId("a/b"), false);
  assert.equal(isSafeSessionId(""), false);
});
