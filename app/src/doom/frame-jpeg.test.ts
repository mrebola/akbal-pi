import { test } from "node:test";
import assert from "node:assert/strict";
import * as jpeg from "jpeg-js";
import { encodeFrameJpeg } from "./frame-jpeg";
import { FRAME_BYTES, FRAME_W, FRAME_H } from "./frame-reader";

test("encodes a 280x175 frame to a JPEG of the same size", () => {
  const out = encodeFrameJpeg(Buffer.alloc(FRAME_BYTES, 0));
  assert.equal(out[0], 0xff);
  assert.equal(out[1], 0xd8);
  const decoded = jpeg.decode(out, { useTArray: true });
  assert.equal(decoded.width, FRAME_W);
  assert.equal(decoded.height, FRAME_H);
});

test("a pure red RGB565 pixel decodes near red", () => {
  const buf = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i += 2) buf.writeUInt16LE(0xF800, i);
  const decoded = jpeg.decode(encodeFrameJpeg(buf, 90), { useTArray: true });
  assert.ok(decoded.data[0] > 240, "red channel");
  assert.ok(decoded.data[1] < 16, "green channel");
});

test("rejects a buffer of the wrong size", () => {
  assert.throws(() => encodeFrameJpeg(Buffer.alloc(10)), /tamaño/);
});
