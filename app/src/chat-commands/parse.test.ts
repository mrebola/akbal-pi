import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessage } from "./parse";

test("plain text goes to the LLM", () => {
  assert.deepEqual(parseMessage("hola, ¿cómo estás?"), { kind: "text" });
});

test("/help is its own kind", () => {
  assert.deepEqual(parseMessage("/help"), { kind: "help" });
});

test("/ask keeps the rest of the message for the LLM", () => {
  assert.deepEqual(parseMessage("/ask ¿qué es un handshake?"), { kind: "ask", text: "¿qué es un handshake?" });
});

test("a command name is lowercased and its argument is trimmed", () => {
  assert.deepEqual(parseMessage("  /WiFi   akbal_lab  "), { kind: "command", name: "wifi", args: "akbal_lab" });
});

test("a command without argument has empty args", () => {
  assert.deepEqual(parseMessage("/aviones"), { kind: "command", name: "aviones", args: "" });
});

test("a lone slash is a command with no name", () => {
  assert.deepEqual(parseMessage("/"), { kind: "command", name: "", args: "" });
});
