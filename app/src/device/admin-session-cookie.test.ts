import { test } from "node:test";
import assert from "node:assert/strict";
import { hasValidSessionCookie } from "./admin-session-cookie";

const SESSIONS = new Set(["a1b2c3d4e5f6"]);

test("a valid session cookie is accepted", () => {
  assert.equal(hasValidSessionCookie("akbal_session=a1b2c3d4e5f6", "akbal_session", SESSIONS), true);
  assert.equal(hasValidSessionCookie("x=1; akbal_session=a1b2c3d4e5f6; y=2", "akbal_session", SESSIONS), true);
});

test("a missing or unknown cookie is refused", () => {
  assert.equal(hasValidSessionCookie(undefined, "akbal_session", SESSIONS), false);
  assert.equal(hasValidSessionCookie("x=1", "akbal_session", SESSIONS), false);
  assert.equal(hasValidSessionCookie("akbal_session=0000", "akbal_session", SESSIONS), false);
});

test("a malformed percent-escape in the cookie is refused without throwing", () => {
  // decodeURIComponent("%E0") throws URIError; the upgrade of any LAN client must not.
  assert.doesNotThrow(() => hasValidSessionCookie("akbal_session=%E0", "akbal_session", SESSIONS));
  assert.equal(hasValidSessionCookie("akbal_session=%E0", "akbal_session", SESSIONS), false);
});
