import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackTitle, titleFromModelOutput } from "./title";

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

test("a model title that just repeats the question is rejected", () => {
  assert.equal(titleFromModelOutput("¿Qué estado tiene el radar de WiFi?", "¿Qué estado tiene el radar de WiFi?"), null);
  assert.equal(titleFromModelOutput("  qué estado tiene el radar de wifi  ", "¿Qué estado tiene el radar de WiFi?"), null);
});

test("a real short title is kept", () => {
  assert.equal(titleFromModelOutput("Estado del radar WiFi", "¿Qué estado tiene el radar de WiFi?"), "Estado del radar WiFi");
});
