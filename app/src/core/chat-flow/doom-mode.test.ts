import { test } from "node:test";
import assert from "node:assert/strict";
import { doomScreenUrl, shouldLeaveDoom, doomBlockedReason, withControlToken } from "./doom-mode";

test("uses the Tailscale host when Tailscale is up", () => {
  assert.equal(
    doomScreenUrl({ tailscaleHost: "tailnet-host.example.ts.net", apActive: false, lanIp: "203.0.113.5", port: 8090 }),
    "http://tailnet-host.example.ts.net:8090/doom",
  );
});

test("falls back to the WiFi direct address when the access point is active", () => {
  assert.equal(
    doomScreenUrl({ tailscaleHost: null, apActive: true, lanIp: "203.0.113.5", port: 8090 }),
    "http://10.42.0.1:8090/doom",
  );
});

test("falls back to the LAN address otherwise", () => {
  assert.equal(
    doomScreenUrl({ tailscaleHost: null, apActive: false, lanIp: "203.0.113.5", port: 8090 }),
    "http://203.0.113.5:8090/doom",
  );
});

test("leaving DOOM for any other flow is a DOOM exit", () => {
  assert.equal(shouldLeaveDoom("doom", "sleep"), true);
  assert.equal(shouldLeaveDoom("doom", "web_chat"), true);
  assert.equal(shouldLeaveDoom("doom", "external_answer"), true);
  assert.equal(shouldLeaveDoom("doom", "approval"), true);
});

test("staying in DOOM and entering it from elsewhere is not an exit", () => {
  assert.equal(shouldLeaveDoom("doom", "doom"), false);
  assert.equal(shouldLeaveDoom("sleep", "doom"), false);
  assert.equal(shouldLeaveDoom("sleep", "web_chat"), false);
});

test("refuses to start when the Whisplay daemon owns the screen", () => {
  assert.equal(doomBlockedReason(true), "DOOM requiere la pantalla directa; el daemon está activo");
  assert.equal(doomBlockedReason(false), null);
});

test("withControlToken adds t=<token> to the screen URL", () => {
  assert.equal(withControlToken("http://h:8090/doom", "abc"), "http://h:8090/doom?t=abc");
  assert.equal(withControlToken("http://h:8090/doom?lang=es", "abc"), "http://h:8090/doom?lang=es&t=abc");
});
