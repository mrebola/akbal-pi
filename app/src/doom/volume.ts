// Volume is a whole number 0..100 in steps of 5. The phone moves it in steps;
// the engine scales its PCM by the same factor, so Akbal's own voice volume is
// never touched.
export const VOLUME_DEFAULT = 60;
export const VOLUME_STEP = 5;

export function clampVolume(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return VOLUME_DEFAULT;
  const clamped = Math.min(100, Math.max(0, value));
  return Math.round(clamped / VOLUME_STEP) * VOLUME_STEP;
}

export function readSettings(raw: string | null): { volume: number; repaired: boolean } {
  if (raw === null) return { volume: VOLUME_DEFAULT, repaired: true };
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { volume: VOLUME_DEFAULT, repaired: true };
  }
  const v = parsed && typeof parsed === "object" ? parsed.volume : undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return { volume: VOLUME_DEFAULT, repaired: true };
  return { volume: clampVolume(v), repaired: false };
}

export function gainFor(volume: number): number {
  return clampVolume(volume) / 100;
}
