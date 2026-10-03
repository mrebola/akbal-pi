import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCapturePath } from "./capture-path";

test("a capture name stored without its folder is found in the session folder", () => {
  assert.equal(
    resolveCapturePath("0c6714c1a614.cap", "/home/akbal/wardrive-sessions/drive-1"),
    "/home/akbal/wardrive-sessions/drive-1/0c6714c1a614.cap",
  );
});

test("a capture path that is already absolute is kept as it is", () => {
  assert.equal(resolveCapturePath("/x/a.cap", "/home/akbal/wardrive-sessions/drive-1"), "/x/a.cap");
});
