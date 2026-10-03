import { test } from "node:test";
import assert from "node:assert/strict";
import { selectVoiceAdminTools } from "./voice-admin-tools";

const tool = (name: string) => ({ function: { name } });

test("voice keeps the read-only status tools", () => {
  const out = selectVoiceAdminTools([tool("getWifiRadarStatus"), tool("getGnssStatus")]);
  assert.deepEqual(out.map((t) => t.function.name), ["getWifiRadarStatus", "getGnssStatus"]);
});

test("voice never gets the active WiFi scan", () => {
  const out = selectVoiceAdminTools([tool("scanNearbyWifiNetworks"), tool("getWifiRadarStatus")]);
  assert.deepEqual(out.map((t) => t.function.name), ["getWifiRadarStatus"]);
});
