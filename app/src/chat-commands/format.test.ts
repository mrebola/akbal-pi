import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAircraft, formatWifi, formatGnss, formatGeneric } from "./format";

test("aircraft: a count line and one line per aircraft, with its last-seen time", () => {
  const out = formatAircraft([
    { icao: "AMX217", callsign: "AMX217", registration: null, timestamp: Date.UTC(2026, 9, 3, 17, 1, 7), altitude: 9450, speed: 244 },
  ]);
  assert.match(out, /^✈ 1 avión/);
  assert.match(out, /AMX217 · visto /);
  assert.match(out, /9450 ft · 244 kt/);
});

test("aircraft: an empty zone says so, it never shows zero as data", () => {
  assert.equal(formatAircraft([]), "Sin aviones en la zona en las últimas 24 h.");
});

test("wifi: a found network shows channel, signal, security and clients", () => {
  const out = formatWifi([{ ssid: "akbal_lab", channel: 11, rssi: -67, security: "WPA2/WPA3", clients: 0 }], "akbal_lab");
  assert.equal(out, "akbal_lab · canal 11 · -67 dBm · WPA2/WPA3 · 0 clientes");
});

test("wifi: a name that is not found says so and never invents a network", () => {
  assert.equal(formatWifi([], "fantasma"), 'No se encontró ninguna red llamada "fantasma".');
});

test("gps: no fix is said plainly, and missing data is not shown as coordinates", () => {
  assert.equal(formatGnss({ hasFix: false, satellitesUsed: null, hdop: null }), "GPS sin fix.");
  assert.equal(formatGnss(null), "GPS sin datos.");
});

test("generic: a tool's own text is passed through unchanged", () => {
  assert.equal(formatGeneric("3 access point(s)."), "3 access point(s).");
});
