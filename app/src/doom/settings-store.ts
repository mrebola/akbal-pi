import fs from "fs";
import path from "path";
import { VOLUME_DEFAULT, clampVolume, readSettings } from "./volume";

// The DOOM volume survives restarts. Stored in <dir>/settings.json; the caller
// passes app/data/doom/.
const FILE = "settings.json";

// A missing or broken file is repaired to the default right away, so the next
// boot reads a valid file. A failed write is not fatal: DOOM still starts.
export function loadVolume(dir: string): number {
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(path.join(dir, FILE), "utf8");
  } catch {
    raw = null;
  }
  const { volume, repaired } = readSettings(raw);
  if (repaired) {
    try {
      saveVolume(dir, VOLUME_DEFAULT);
    } catch (err) {
      console.warn(`[DOOM] no se pudo reparar ${FILE}: ${(err as Error).message}`);
    }
  }
  return volume;
}

// Written to a temp file and renamed, so a power cut mid-write cannot leave a
// half-written settings.json behind.
export function saveVolume(dir: string, volume: number): void {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, FILE);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ volume: clampVolume(volume) }) + "\n");
  fs.renameSync(tmp, target);
}
