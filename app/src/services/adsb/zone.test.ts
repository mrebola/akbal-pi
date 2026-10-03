import { test } from "node:test";
import assert from "node:assert/strict";
import { distanceToOwnKm, isInZone, sightingRadiusKm, SIGHTING_WINDOW_MS } from "./zone";

const home = { lat: 19.4326, lon: -99.1332 };

test("an aircraft within the radius is in the zone", () => {
  // about 1 km north of home
  assert.equal(isInZone(19.4416, -99.1332, home, 10), true);
});

test("an aircraft beyond the radius is outside the zone", () => {
  // about 111 km north of home
  assert.equal(isInZone(20.4326, -99.1332, home, 10), false);
});

test("without a known own position nothing is in the zone", () => {
  assert.equal(isInZone(19.4416, -99.1332, null, 10), false);
});

test("the radius defaults to 10 km and rejects bad values", () => {
  const saved = process.env.ADSB_SIGHTING_RADIUS_KM;
  try {
    delete process.env.ADSB_SIGHTING_RADIUS_KM;
    assert.equal(sightingRadiusKm(), 10);
    process.env.ADSB_SIGHTING_RADIUS_KM = "not-a-number";
    assert.equal(sightingRadiusKm(), 10);
    process.env.ADSB_SIGHTING_RADIUS_KM = "5";
    assert.equal(sightingRadiusKm(), 5);
  } finally {
    if (saved === undefined) delete process.env.ADSB_SIGHTING_RADIUS_KM;
    else process.env.ADSB_SIGHTING_RADIUS_KM = saved;
  }
});

test("the sighting window is 24 hours", () => {
  assert.equal(SIGHTING_WINDOW_MS, 24 * 60 * 60 * 1000);
});

test("distance to Akbal is null without a known own position, and in km otherwise", () => {
  assert.equal(distanceToOwnKm(19.4416, -99.1332, null), null);
  const d = distanceToOwnKm(19.4416, -99.1332, home);
  assert.ok(d !== null && d > 0.9 && d < 1.1, `about 1 km, got ${d}`);
});
