import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, trimToWindow } from "./context";

test("estimateTokens is about 4 characters per token, rounded up", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("trimToWindow keeps the newest turns that fit and preserves order", () => {
  const msgs = [
    { role: "user" as const, content: "a".repeat(40) },      // 10 tokens
    { role: "assistant" as const, content: "b".repeat(40) },  // 10 tokens
    { role: "user" as const, content: "c".repeat(40) },      // 10 tokens
  ];
  const out = trimToWindow(msgs, 25);
  assert.deepEqual(out.map((m) => m.content[0]), ["b", "c"]);
});

test("system messages are always kept and do not count against the turn budget", () => {
  const msgs = [
    { role: "system" as const, content: "s".repeat(400) },   // 100 tokens, still kept
    { role: "user" as const, content: "a".repeat(40) },
    { role: "assistant" as const, content: "b".repeat(40) },
  ];
  const out = trimToWindow(msgs, 10);
  assert.equal(out[0].role, "system");
  assert.equal(out.length, 2);
  assert.equal(out[1].content[0], "b");
});

test("the newest user message is kept even when it alone exceeds the budget", () => {
  const msgs = [
    { role: "user" as const, content: "a".repeat(40) },
    { role: "user" as const, content: "z".repeat(4000) },    // 1000 tokens
  ];
  const out = trimToWindow(msgs, 50);
  assert.equal(out.length, 1);
  assert.equal(out[0].content[0], "z");
});
