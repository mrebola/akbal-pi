import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameReader, FRAME_BYTES } from "./frame-reader";

const frame = (fill: number) => Buffer.alloc(FRAME_BYTES, fill);
const header = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

test("returns one complete frame", () => {
  const r = new FrameReader();
  const out = r.push(Buffer.concat([header(FRAME_BYTES), frame(7)]));
  assert.equal(out.length, 1);
  assert.equal(out[0].length, FRAME_BYTES);
  assert.equal(out[0][0], 7);
});

test("joins a frame split across chunks", () => {
  const r = new FrameReader();
  const data = Buffer.concat([header(FRAME_BYTES), frame(9)]);
  assert.equal(r.push(data.subarray(0, 1000)).length, 0);
  const out = r.push(data.subarray(1000));
  assert.equal(out.length, 1);
  assert.equal(out[0][FRAME_BYTES - 1], 9);
});

test("returns two frames sent in one chunk", () => {
  const r = new FrameReader();
  const data = Buffer.concat([header(FRAME_BYTES), frame(1), header(FRAME_BYTES), frame(2)]);
  assert.equal(r.push(data).length, 2);
});

test("drops a frame whose length is not the expected size and resynchronises", () => {
  const r = new FrameReader();
  const bad = Buffer.concat([header(12), Buffer.alloc(12, 1)]);
  const good = Buffer.concat([header(FRAME_BYTES), frame(5)]);
  const out = r.push(Buffer.concat([bad, good]));
  assert.equal(out.length, 1);
  assert.equal(out[0][0], 5);
});
