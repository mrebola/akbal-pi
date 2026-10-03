import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DriveDb } from "./drive-db";

test("trackPoints returns speed, heading and HDOP with the lat and lon of each fix", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-db-"));
  const db = new DriveDb(path.join(dir, "drive.db"));
  try {
    db.addTrackPoint("drive-1", 1100, 19.4, -99.1, 20, 90, 1.1);
    db.addTrackPoint("drive-1", 1200, 19.5, -99.2, null, null, 0.9);
    assert.deepEqual(db.trackPoints("drive-1"), [
      { ts: 1100, lat: 19.4, lon: -99.1, speed_kmh: 20, heading: 90, hdop: 1.1 },
      { ts: 1200, lat: 19.5, lon: -99.2, speed_kmh: null, heading: null, hdop: 0.9 },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
