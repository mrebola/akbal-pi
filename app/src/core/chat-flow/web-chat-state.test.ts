import { test } from "node:test";
import assert from "node:assert/strict";
import { isWebChatModeOn, onWebChatModeChange, setWebChatMode } from "./web-chat-state";

test("starts off and reports the value it was set to", () => {
  assert.equal(isWebChatModeOn(), false);
  setWebChatMode(true);
  assert.equal(isWebChatModeOn(), true);
  setWebChatMode(false);
  assert.equal(isWebChatModeOn(), false);
});

test("listeners fire only when the value changes", () => {
  setWebChatMode(false);
  const seen: boolean[] = [];
  const off = onWebChatModeChange((on) => seen.push(on));
  setWebChatMode(true);
  setWebChatMode(true);
  setWebChatMode(false);
  off();
  setWebChatMode(true);
  assert.deepEqual(seen, [true, false]);
  setWebChatMode(false);
});

test("a failing listener does not stop the others", () => {
  setWebChatMode(false);
  const seen: boolean[] = [];
  const offBad = onWebChatModeChange(() => {
    throw new Error("boom");
  });
  const offGood = onWebChatModeChange((on) => seen.push(on));
  setWebChatMode(true);
  setWebChatMode(false);
  offBad();
  offGood();
  assert.deepEqual(seen, [true, false]);
});
