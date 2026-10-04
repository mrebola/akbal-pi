import * as jpeg from "jpeg-js";
import { FRAME_BYTES, FRAME_W, FRAME_H } from "./frame-reader";

// Converts one RGB565 little-endian frame to RGBA, then to JPEG. Only called
// when a web client has video on, so a Pi with no viewers spends no CPU here.
export function encodeFrameJpeg(rgb565: Buffer, quality = 70): Buffer {
  if (rgb565.length !== FRAME_BYTES) {
    throw new Error(`cuadro con tamaño ${rgb565.length}, se esperaba ${FRAME_BYTES}`);
  }
  const rgba = Buffer.alloc(FRAME_W * FRAME_H * 4);
  for (let i = 0, o = 0; i < FRAME_BYTES; i += 2, o += 4) {
    const v = rgb565.readUInt16LE(i);
    rgba[o] = ((v >> 11) & 0x1f) * 255 / 31;
    rgba[o + 1] = ((v >> 5) & 0x3f) * 255 / 63;
    rgba[o + 2] = (v & 0x1f) * 255 / 31;
    rgba[o + 3] = 255;
  }
  return jpeg.encode({ width: FRAME_W, height: FRAME_H, data: rgba }, quality).data;
}
