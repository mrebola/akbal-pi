import * as fs from "fs";
import * as path from "path";

// Imported .akbal sessions, kept apart from this Pi's own captures. Each one is a
// folder of already-verified files, named by the session id. Nothing is written
// unless the caller has verified the package first (see package.ts).
const SAFE_ID = /^[A-Za-z0-9._-]{1,80}$/;

export const isSafeSessionId = (id: string): boolean => SAFE_ID.test(id) && !id.includes("..");

export interface SharedSummary {
  id: string;
  origin: string;
  credentials: boolean;
  startedAt: number;
  endedAt: number | null;
  distanceM: number;
  points: number;
}

export class SharedSessions {
  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  private dirOf(id: string): string {
    return path.join(this.root, id);
  }

  save(id: string, files: Record<string, Buffer>, meta: { origin: string; credentials: boolean }): void {
    if (!isSafeSessionId(id)) throw new Error("id de sesión no válido");
    const dir = this.dirOf(id);
    if (fs.existsSync(dir)) throw new Error(`la sesión ${id} ya existe`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
    for (const [name, data] of Object.entries(files)) {
      const target = path.join(dir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  }

  list(): SharedSummary[] {
    if (!fs.existsSync(this.root)) return [];
    const out: SharedSummary[] = [];
    for (const id of fs.readdirSync(this.root)) {
      if (!isSafeSessionId(id)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.dirOf(id), "meta.json"), "utf8"));
        const drive = JSON.parse(fs.readFileSync(path.join(this.dirOf(id), "drive.json"), "utf8"));
        out.push({
          id,
          origin: meta.origin,
          credentials: meta.credentials,
          startedAt: drive.startedAt,
          endedAt: drive.endedAt,
          distanceM: drive.distanceM,
          points: drive.points,
        });
      } catch {
        // A damaged folder is skipped, not fatal to the list.
      }
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  read(id: string, name: string): Buffer | null {
    if (!isSafeSessionId(id)) return null;
    const file = path.join(this.dirOf(id), name);
    if (!file.startsWith(this.dirOf(id) + path.sep) || !fs.existsSync(file)) return null;
    return fs.readFileSync(file);
  }

  remove(id: string): boolean {
    if (!isSafeSessionId(id) || !fs.existsSync(this.dirOf(id))) return false;
    fs.rmSync(this.dirOf(id), { recursive: true, force: true });
    return true;
  }
}
