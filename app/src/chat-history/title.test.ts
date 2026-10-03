import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackTitle } from "./title";

test("uses the first six words, whitespace collapsed", () => {
  assert.equal(
    fallbackTitle("  cómo   funciona nmap  con   una  red grande y lenta  "),
    "cómo funciona nmap con una red",
  );
});

test("caps length at 60 characters even with long words", () => {
  const out = fallbackTitle("a".repeat(200));
  assert.equal(out.length, 60);
});

test("empty input falls back to a neutral label", () => {
  assert.equal(fallbackTitle("   "), "Chat nuevo");
});
