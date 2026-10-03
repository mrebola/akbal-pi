import { test } from "node:test";
import assert from "node:assert/strict";
import { toAccessPointRows } from "./ap-rows";

test("access points keep only the fields the formatter needs, and filter by name", () => {
  const rows = toAccessPointRows(
    [
      { ssid: "akbal_lab", channel: 11, rssi: -67, security: "WPA2/WPA3", clients: 0, bssid: "A0:F3" },
      { ssid: "Otra", channel: 6, rssi: -80, security: "WPA2", clients: 2, bssid: "B1" },
    ],
    "akbal",
  );
  assert.deepEqual(rows, [{ ssid: "akbal_lab", channel: 11, rssi: -67, security: "WPA2/WPA3", clients: 0 }]);
});

test("without a name, the first fifteen access points are returned", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ ssid: `R${i}`, channel: 1, rssi: -50, security: "WPA2", clients: 0, bssid: `x${i}` }));
  assert.equal(toAccessPointRows(many, "").length, 15);
});

test("a name beyond the first fifteen is still found", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ ssid: `R${i}`, channel: 1, rssi: -50, security: "WPA2", clients: 0, bssid: `x${i}` }));
  many.push({ ssid: "akbal_lab", channel: 11, rssi: -67, security: "WPA2/WPA3", clients: 0, bssid: "a0" });
  assert.equal(toAccessPointRows(many, "akbal_lab").length, 1);
});
