import { test } from "node:test";
import assert from "node:assert/strict";
import { findAccessPoints } from "./ap-search";

const aps = Array.from({ length: 20 }, (_, i) => ({ ssid: `Red${i}`, bssid: `aa:${i}` }));
aps.push({ ssid: "akbal_lab", bssid: "a0:f3" });

test("without a name, the first fifteen access points are returned", () => {
  assert.equal(findAccessPoints(aps).length, 15);
});

test("a name finds a network beyond the first fifteen", () => {
  const out = findAccessPoints(aps, "akbal_lab");
  assert.deepEqual(out.map((a) => a.ssid), ["akbal_lab"]);
});

test("the name match ignores case and partial text", () => {
  assert.deepEqual(findAccessPoints(aps, "AKBAL").map((a) => a.ssid), ["akbal_lab"]);
});

test("a name that matches nothing returns an empty list", () => {
  assert.equal(findAccessPoints(aps, "no-existe").length, 0);
});
