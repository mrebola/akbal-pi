import { test } from "node:test";
import assert from "node:assert/strict";
import { clipFileName, isSafeClipName } from "./audio-names";

test("a clip name is built from a chat id, message index and chunk number", () => {
  assert.equal(
    clipFileName("9f890db6-464e-46d2-a2fc-e96e9d284b15", 3, 0),
    "9f890db6-464e-46d2-a2fc-e96e9d284b15-3-0.wav",
  );
});

test("only names built that way are served", () => {
  assert.equal(isSafeClipName("9f890db6-464e-46d2-a2fc-e96e9d284b15-3-0.wav"), true);
  assert.equal(isSafeClipName("../../etc/passwd"), false);
  assert.equal(isSafeClipName("notas.wav"), false);
  assert.equal(isSafeClipName("9f890db6-464e-46d2-a2fc-e96e9d284b15-3-0.wav/../x"), false);
});
