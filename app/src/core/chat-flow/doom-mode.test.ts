import { test } from "node:test";
import assert from "node:assert/strict";
import { doomScreenUrl } from "./doom-mode";

test("uses the Tailscale host when Tailscale is up", () => {
  assert.equal(
    doomScreenUrl({ tailscaleHost: "akbal-pi.ejemplo.ts.net", apActive: false, lanIp: "192.168.1.5", port: 8090 }),
    "http://akbal-pi.ejemplo.ts.net:8090/doom",
  );
});

test("falls back to the WiFi direct address when the access point is active", () => {
  assert.equal(
    doomScreenUrl({ tailscaleHost: null, apActive: true, lanIp: "192.168.1.5", port: 8090 }),
    "http://10.42.0.1:8090/doom",
  );
});

test("falls back to the LAN address otherwise", () => {
  assert.equal(
    doomScreenUrl({ tailscaleHost: null, apActive: false, lanIp: "192.168.1.5", port: 8090 }),
    "http://192.168.1.5:8090/doom",
  );
});
