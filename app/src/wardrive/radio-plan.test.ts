import { test } from "node:test";
import assert from "node:assert/strict";
import { activeRadiosOf, maxConcurrentAttackers, parseRadioMode, radioCountForMode } from "./radio-plan";

test("auto uses every connected monitor-capable radio", () => {
  assert.equal(radioCountForMode("auto", 1), 1);
  assert.equal(radioCountForMode("auto", 2), 2);
  assert.equal(radioCountForMode("auto", 3), 3);
  assert.equal(radioCountForMode("auto", 4), 4);
});

test("single always uses one radio", () => {
  assert.equal(radioCountForMode("single", 1), 1);
  assert.equal(radioCountForMode("single", 3), 1);
});

test("dual uses two radios when available, otherwise what is connected", () => {
  assert.equal(radioCountForMode("dual", 1), 1);
  assert.equal(radioCountForMode("dual", 2), 2);
  assert.equal(radioCountForMode("dual", 3), 2);
});

test("triple uses three radios when available, otherwise what is connected", () => {
  assert.equal(radioCountForMode("triple", 1), 1);
  assert.equal(radioCountForMode("triple", 2), 2);
  assert.equal(radioCountForMode("triple", 3), 3);
  assert.equal(radioCountForMode("triple", 4), 3);
});

test("parseRadioMode accepts the four modes and rejects anything else", () => {
  for (const mode of ["auto", "single", "dual", "triple"]) assert.equal(parseRadioMode(mode), mode);
  assert.equal(parseRadioMode("quad"), null);
  assert.equal(parseRadioMode(""), null);
  assert.equal(parseRadioMode(undefined), null);
});

test("activeRadiosOf lists the attack radio and the discovery radios with their roles", () => {
  assert.deepEqual(activeRadiosOf(["wlan1", "wlan3"], "wlan2"), [
    { iface: "wlan1", role: "discovery" },
    { iface: "wlan3", role: "discovery" },
    { iface: "wlan2", role: "attack" },
  ]);
});

test("maxConcurrentAttackers caps at radios minus one (one radio must keep discovering)", () => {
  assert.equal(maxConcurrentAttackers("auto", 1), 0);
  assert.equal(maxConcurrentAttackers("auto", 2), 1);
  assert.equal(maxConcurrentAttackers("auto", 3), 2);
  assert.equal(maxConcurrentAttackers("auto", 4), 2); // session radios cap at 3
  assert.equal(maxConcurrentAttackers("dual", 2), 1);
  assert.equal(maxConcurrentAttackers("dual", 3), 1);
  assert.equal(maxConcurrentAttackers("triple", 3), 2);
  assert.equal(maxConcurrentAttackers("triple", 4), 2);
});

test("maxConcurrentAttackers: single and single-radio setups have no parallel attackers", () => {
  assert.equal(maxConcurrentAttackers("single", 3), 0);
  assert.equal(maxConcurrentAttackers("dual", 1), 0);
  assert.equal(maxConcurrentAttackers("triple", 1), 0);
});

test("activeRadiosOf marks radios hosting a round as attacking", () => {
  assert.deepEqual(activeRadiosOf(["wlan1", "wlan3"], null, ["wlan3"]), [
    { iface: "wlan1", role: "discovery" },
    { iface: "wlan3", role: "attacking" },
  ]);
});

test("activeRadiosOf in single mode has only discovery radios", () => {
  assert.deepEqual(activeRadiosOf(["wlan1"], null), [{ iface: "wlan1", role: "discovery" }]);
});

test("activeRadiosOf is empty when no session is running", () => {
  assert.deepEqual(activeRadiosOf([], null), []);
});
