import { test } from "node:test";
import assert from "node:assert/strict";
import { selectToolsForMessage } from "./route-tools";

const tools = [
  { name: "getNearbyAircraft", sectionId: "aircraft-radar" as const },
  { name: "getAircraftHistory", sectionId: "aircraft-radar" as const },
  { name: "getWifiRadarStatus", sectionId: "wifiradar" as const },
  { name: "getGnssStatus", sectionId: "gps" as const },
];
const names = (list: { name: string }[]) => list.map((t) => t.name);

test("an aircraft question sends only the aircraft tools", () => {
  assert.deepEqual(names(selectToolsForMessage("cuantos aviones ves ahora ?", tools)), [
    "getNearbyAircraft",
    "getAircraftHistory",
  ]);
});

test("a WiFi question sends only the WiFi tools", () => {
  assert.deepEqual(names(selectToolsForMessage("¿qué redes wifi hay cerca?", tools)), ["getWifiRadarStatus"]);
});

test("a question naming two subsystems sends both sets", () => {
  assert.deepEqual(names(selectToolsForMessage("aviones y gps, ¿qué ves?", tools)), [
    "getNearbyAircraft",
    "getAircraftHistory",
    "getGnssStatus",
  ]);
});

test("a question naming no subsystem keeps the full list", () => {
  assert.equal(selectToolsForMessage("hola, ¿cómo estás?", tools).length, tools.length);
});
