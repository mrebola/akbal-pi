import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommandRegistry, findCommand, READ_ONLY_ALIASES } from "./registry-core";

const fns = [
  { name: "getNearbyAircraft", description: "lista aviones" },
  { name: "getWifiRadarStatus", description: "radar wifi" },
  { name: "scanNearbyWifiNetworks", description: "escanea" },
  { name: "getGnssStatus", description: "gps" },
];

test("aliases come from the explicit map", () => {
  const reg = buildCommandRegistry(fns, { getNearbyAircraft: "aviones", getWifiRadarStatus: "wifi", getGnssStatus: "gps" });
  assert.equal(findCommand(reg, "aviones")?.toolName, "getNearbyAircraft");
});

test("a function without an alias gets a derived kebab-case name", () => {
  const reg = buildCommandRegistry([{ name: "getGnssStatus", description: "gps" }], {});
  assert.equal(findCommand(reg, "gnss-status")?.toolName, "getGnssStatus");
});

test("action functions are never registered as commands", () => {
  const reg = buildCommandRegistry(fns, {});
  assert.equal(reg.some((c) => c.toolName === "scanNearbyWifiNetworks"), false);
});

test("two functions with the same alias fail loudly", () => {
  assert.throws(
    () => buildCommandRegistry(fns, { getNearbyAircraft: "x", getWifiRadarStatus: "x" }),
    /alias "x" ya está en uso/,
  );
});

test("lookup is case-insensitive and returns null for unknown names", () => {
  const reg = buildCommandRegistry(fns, { getGnssStatus: "gps" });
  assert.equal(findCommand(reg, "GPS")?.toolName, "getGnssStatus");
  assert.equal(findCommand(reg, "nada"), null);
});

test("the shipped alias map covers the read-only functions", () => {
  assert.equal(READ_ONLY_ALIASES.getNearbyAircraft, "aviones");
  assert.equal(READ_ONLY_ALIASES.getWifiRadarStatus, "wifi");
  assert.equal(READ_ONLY_ALIASES.getGnssStatus, "gps");
  assert.equal(READ_ONLY_ALIASES.getWardriveDriveStatus, "wardrive");
  assert.equal(READ_ONLY_ALIASES.getWifiAuditStatus, "auditoria");
  assert.equal(READ_ONLY_ALIASES.listCapturedHandshakes, "handshakes");
  assert.equal(READ_ONLY_ALIASES.getWifiConnectionStatus, "conexion-wifi");
  assert.equal(READ_ONLY_ALIASES.getNearestAircraft, "avion-cercano");
  assert.equal(READ_ONLY_ALIASES.getAircraftDetails, "avion");
  assert.equal(READ_ONLY_ALIASES.getAircraftHistory, "historial-avion");
});
