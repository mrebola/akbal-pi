import { test } from "node:test";
import assert from "node:assert/strict";
import { clipFileName, clipsOfChat, isSafeClipName } from "./audio-names";

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

test("clipsOfChat picks only the clip files that belong to that chat", () => {
  const mine = "9f890db6-464e-46d2-a2fc-e96e9d284b15";
  const other = "4234721f-5fdc-4985-9ed5-a2b8454a84ea";
  const names = [`${mine}-2-0.wav`, `${mine}-2-1.wav`, `${other}-1-0.wav`, "notas.txt"];
  assert.deepEqual(clipsOfChat(names, mine), [`${mine}-2-0.wav`, `${mine}-2-1.wav`]);
});
