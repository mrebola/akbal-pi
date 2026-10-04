import { test } from "node:test";
import assert from "node:assert/strict";
import { doomScreenUrl, shouldLeaveDoom, doomBlockedReason, withControlToken, doomQrText, screenFaceFor, decideOnEngineStopped, decideMirrorEntry, shouldStopOnLeave } from "./doom-mode";

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

test("the QR fallback text never shows the control token", () => {
  assert.equal(doomQrText(true, "http://h:8090/doom"), "Escanea el QR para controlar DOOM");
  const text = doomQrText(false, "http://h:8090/doom");
  assert.equal(text, "Abre http://h:8090/doom para controlar DOOM");
  assert.ok(!text.includes("t="), "the token must stay in the QR only");
});

test("screen shows the mirror when the web owns the game", () => {
  assert.equal(screenFaceFor("web", true), "mirror");
  assert.equal(screenFaceFor("web", false), "mirror");
});

test("screen shows the game or the QR depending on the Pi controller", () => {
  assert.equal(screenFaceFor("pi", true), "game");
  assert.equal(screenFaceFor("pi", false), "qr");
  assert.equal(screenFaceFor(null, false), "qr");
});

test("a clean engine stop returns the Pi to the menu only while the flow is still DOOM", () => {
  assert.equal(decideOnEngineStopped("doom", false, null), "return-to-sleep");
  assert.equal(decideOnEngineStopped("doom", true, null), "none");
  assert.equal(decideOnEngineStopped("sleep", false, null), "none");
  assert.equal(decideOnEngineStopped("web_chat", false, null), "none");
});

test("a crash keeps the error card on screen instead of returning to the menu", () => {
  assert.equal(decideOnEngineStopped("doom", false, "el motor se cayó"), "none");
});

test("the Pi enters the mirror only from sleep, with the web owning a running game", () => {
  assert.equal(decideMirrorEntry("sleep", "web", true), "enter-mirror");
  assert.equal(decideMirrorEntry("answer", "web", true), "none");
  assert.equal(decideMirrorEntry("approval", "web", true), "none");
  assert.equal(decideMirrorEntry("doom", "web", true), "none");
  assert.equal(decideMirrorEntry("web_chat", "web", true), "none");
  assert.equal(decideMirrorEntry("sleep", "web", false), "none");
  assert.equal(decideMirrorEntry("sleep", "pi", true), "none");
  assert.equal(decideMirrorEntry("sleep", null, true), "none");
});

test("a leave from the web chat, a reply or an approval keeps the game when the web owns it", () => {
  assert.equal(shouldStopOnLeave("web", false), false);
  assert.equal(shouldStopOnLeave("web", true), true, "the Pi's hold always ends the game");
  assert.equal(shouldStopOnLeave("pi", false), true);
  assert.equal(shouldStopOnLeave(null, false), true);
});
