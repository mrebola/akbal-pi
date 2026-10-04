// The engine writes [uint32 LE length][RGB565 bytes] per frame. Anything whose
// length is not FRAME_BYTES is treated as corruption: skip the header and
// look for the next one.
export const FRAME_W = 280;
export const FRAME_H = 175;
export const FRAME_BYTES = FRAME_W * FRAME_H * 2;

export class FrameReader {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const frames: Buffer[] = [];
    while (this.pending.length >= 4) {
      const n = this.pending.readUInt32LE(0);
      if (n !== FRAME_BYTES) {
        this.pending = this.pending.subarray(1);
        continue;
      }
      if (this.pending.length < 4 + n) break;
      frames.push(Buffer.from(this.pending.subarray(4, 4 + n)));
      this.pending = this.pending.subarray(4 + n);
    }
    return frames;
  }
}
