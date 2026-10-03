import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlTokens } from "./tokens";

test("issues a 32-hex-char token and accepts it", () => {
  const t = new ControlTokens();
  const token = t.issue();
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.equal(t.isValid(token), true);
});

test("rejects missing, empty and invented tokens", () => {
  const t = new ControlTokens();
  t.issue();
  assert.equal(t.isValid(undefined), false);
  assert.equal(t.isValid(null), false);
  assert.equal(t.isValid(""), false);
  assert.equal(t.isValid("0".repeat(32)), false);
});

test("a new issue replaces the old token", () => {
  const t = new ControlTokens();
  const first = t.issue();
  const second = t.issue();
  assert.notEqual(first, second);
  assert.equal(t.isValid(first), false);
  assert.equal(t.isValid(second), true);
});

test("current returns the live token and null after revokeAll", () => {
  const t = new ControlTokens();
  assert.equal(t.current(), null);
  const token = t.issue();
  assert.equal(t.current(), token);
  t.revokeAll();
  assert.equal(t.current(), null);
});

test("revokeAll invalidates the current token", () => {
  const t = new ControlTokens();
  const token = t.issue();
  t.revokeAll();
  assert.equal(t.isValid(token), false);
});
