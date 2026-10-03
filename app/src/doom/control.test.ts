import { test } from "node:test";
import assert from "node:assert/strict";
import { ControllerLock } from "./control";

test("first claim wins, second is refused until the holder releases", () => {
  const lock = new ControllerLock();
  assert.equal(lock.claim("a"), true);
  assert.equal(lock.claim("b"), false);
  assert.equal(lock.holder(), "a");
  lock.release("a");
  assert.equal(lock.claim("b"), true);
  assert.equal(lock.isHolder("b"), true);
});

test("only the holder can release", () => {
  const lock = new ControllerLock();
  lock.claim("a");
  lock.release("b");
  assert.equal(lock.holder(), "a");
});

test("claiming again as the holder is idempotent", () => {
  const lock = new ControllerLock();
  lock.claim("a");
  assert.equal(lock.claim("a"), true);
});

test("dropping the holder's connection frees the control at once", () => {
  const lock = new ControllerLock();
  lock.claim("a");
  lock.release("a");
  assert.equal(lock.holder(), null);
});
