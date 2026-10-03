import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHelp } from "./help";

test("help lists every command with its description, one line each", () => {
  const out = buildHelp([
    { alias: "aviones", toolName: "getNearbyAircraft", description: "lista aviones" },
    { alias: "gps", toolName: "getGnssStatus", description: "estado del GPS" },
  ]);
  assert.match(out, /\/aviones · lista aviones/);
  assert.match(out, /\/gps · estado del GPS/);
});

test("help includes the built-in /estado and the /ask line", () => {
  const out = buildHelp([]);
  assert.match(out, /\/estado · /);
  assert.match(out, /\/ask <pregunta>/);
});
