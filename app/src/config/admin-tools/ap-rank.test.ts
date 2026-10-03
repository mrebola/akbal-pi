import { test } from "node:test";
import assert from "node:assert/strict";
import { topByClients } from "./ap-rank";

const aps = [
  { ssid: "akbal_lab", clients: 0 },
  { ssid: "warp", clients: 14 },
  { ssid: "nexora", clients: 6 },
  { ssid: null, clients: 9 },
  { ssid: "sinDato", clients: null },
];

test("the top access points by clients come first, most clients first", () => {
  assert.deepEqual(topByClients(aps, 2).map((a) => a.ssid), ["warp", null]);
});

test("access points without a client count are never ranked", () => {
  assert.equal(topByClients(aps, 10).some((a) => a.ssid === "sinDato"), false);
});

test("a network with zero clients is not reported as a top network", () => {
  assert.equal(topByClients([{ ssid: "akbal_lab", clients: 0 }], 3).length, 0);
});
