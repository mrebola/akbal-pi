import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSessionFiles } from "./session-files";

const base = {
  drive: { id: "drive-1", startedAt: 1000, endedAt: 2000, distanceM: 1500, points: 2, networks: 1, handshakes: 1 },
  track: [{ ts: 1100, lat: 19.4, lon: -99.1, speedKmh: 20, heading: 90, hdop: 1.1 }],
  networks: [{ ssid: "akbal_lab", bssid: "A0:F3", security: "WPA2", channel: 11, bestRssi: -67, lat: 19.4, lon: -99.1, firstSeen: 1100 }],
  handshakes: [{ ssid: "akbal_lab", bssid: "A0:F3", method: "eapol", capturedAt: 1500, password: "secreto", capFile: "/x/a.cap", hashFile: "/x/a.hc22000" }],
  capFiles: { "captures/a.cap": Buffer.from("cap"), "captures/a.hc22000": Buffer.from("hash") },
};

test("the package always carries the trip, the track and the networks as readable JSON", () => {
  const files = buildSessionFiles({ ...base, includeCredentials: false });
  const drive = JSON.parse(files["drive.json"].toString());
  assert.equal(drive.id, "drive-1");
  assert.equal(JSON.parse(files["track.json"].toString()).length, 1);
  assert.equal(JSON.parse(files["networks.json"].toString())[0].ssid, "akbal_lab");
});

test("without credentials, no password and no capture file is in the package", () => {
  const files = buildSessionFiles({ ...base, includeCredentials: false });
  const handshakes = JSON.parse(files["handshakes.json"].toString());
  assert.equal(handshakes.length, 1);
  assert.equal(handshakes[0].password, undefined);
  assert.equal(files["captures/a.cap"], undefined);
});

test("with credentials, the password and the capture files are included", () => {
  const files = buildSessionFiles({ ...base, includeCredentials: true });
  assert.equal(JSON.parse(files["handshakes.json"].toString())[0].password, "secreto");
  assert.equal(files["captures/a.cap"].toString(), "cap");
});
