import { test } from "node:test";
import assert from "node:assert/strict";
import { WEB_CHAT_TOOL_RULE } from "./web-chat-rules";

test("the web chat rule sends live-data questions through a tool", () => {
  assert.match(WEB_CHAT_TOOL_RULE, /herramienta/);
  assert.match(WEB_CHAT_TOOL_RULE, /aviones/);
});

test("the web chat rule forbids invented numbers and names", () => {
  assert.match(WEB_CHAT_TOOL_RULE, /nunca inventes/i);
});
