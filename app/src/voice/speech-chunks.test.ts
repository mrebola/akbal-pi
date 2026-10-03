import { test } from "node:test";
import assert from "node:assert/strict";
import { toSpeechChunks } from "./speech-chunks";

test("paragraphs become separate chunks, empty ones dropped", () => {
  assert.deepEqual(toSpeechChunks("Hola.\n\nAdiós.\n\n\n"), ["Hola.", "Adiós."]);
});

test("markdown symbols are removed so they are not read aloud", () => {
  assert.deepEqual(toSpeechChunks("**Hola** `akbal` # título\n- punto"), ["Hola akbal título punto"]);
});

test("a long paragraph is split at sentence ends, each chunk under the limit", () => {
  const sentence = "Esta es una oración de prueba. ";
  const chunks = toSpeechChunks(sentence.repeat(40), 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
});

test("text with nothing speakable gives no chunks", () => {
  assert.deepEqual(toSpeechChunks("  \n\n  "), []);
});
