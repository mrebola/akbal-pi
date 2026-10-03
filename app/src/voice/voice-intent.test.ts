import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsVoiceReply } from "./voice-intent";

test("asking for an answer by voice is detected", () => {
  assert.equal(wantsVoiceReply("contéstame por voz"), true);
  assert.equal(wantsVoiceReply("Dímelo en voz alta"), true);
  assert.equal(wantsVoiceReply("genera un saludo por voz"), true);
});

test("asking for audio or to be spoken to is detected, with or without accents", () => {
  assert.equal(wantsVoiceReply("contéstame con audio"), true);
  assert.equal(wantsVoiceReply("háblame de los aviones"), true);
  assert.equal(wantsVoiceReply("hablame de los aviones"), true);
});

test("ordinary questions are not voice requests", () => {
  assert.equal(wantsVoiceReply("¿cuántos aviones ves ahora?"), false);
  assert.equal(wantsVoiceReply("qué es un handshake"), false);
  assert.equal(wantsVoiceReply("/aviones"), false);
});
