import { execFile } from "child_process";
import fs from "fs";
import path from "path";

// Config backups live on the Pi's microSD, under the app's data/ directory
// (git-ignored — they contain .env with API keys, wifi passwords, etc. and must
// never reach the public repo). They let anyone restore a working configuration
// from the web admin if something gets misconfigured.

// Repo root: dist/utils/backup.js -> ../.. = the app root that holds .env.
const ROOT = path.resolve(__dirname, "..", "..");
const ENV_FILE = ".env";
const BACKUP_DIR = path.join(ROOT, "data", "backups");

// What each backup captures. Only .env for now: it's the sole file that's hard
// to recreate (secrets + device config). Everything else is in git.
const BACKUP_CONTENTS = [ENV_FILE];

const NAME_RE = /^akbal-backup-[0-9A-Za-z._-]+\.tgz$/;

export interface BackupEntry {
  name: string;
  size: number;
  mtime: number; // epoch ms
}

const run = (cmd: string, args: string[], timeoutMs = 20000): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, _out, stderr) => {
      if (err) {
        reject(new Error(stderr?.toString().trim() || err.message));
        return;
      }
      resolve();
    });
  });

const ensureDir = (): void => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
};

const timestamp = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
};

/** Full path of a backup by name, validated to stay inside BACKUP_DIR. */
export const resolveBackupPath = (name: string): string => {
  if (!NAME_RE.test(name)) {
    throw new Error("nombre de respaldo inválido");
  }
  const full = path.join(BACKUP_DIR, name);
  if (path.dirname(full) !== BACKUP_DIR) {
    throw new Error("nombre de respaldo inválido");
  }
  return full;
};

export const listBackups = (): BackupEntry[] => {
  ensureDir();
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((n) => NAME_RE.test(n))
    .map((n) => {
      const st = fs.statSync(path.join(BACKUP_DIR, n));
      return { name: n, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
};

/** Create a new backup tarball; returns its entry. */
export const createBackup = async (): Promise<BackupEntry> => {
  ensureDir();
  const present = BACKUP_CONTENTS.filter((f) => fs.existsSync(path.join(ROOT, f)));
  if (present.length === 0) {
    throw new Error("no hay archivos de configuración para respaldar");
  }
  const name = `akbal-backup-${timestamp()}.tgz`;
  await run("tar", ["czf", path.join(BACKUP_DIR, name), "-C", ROOT, ...present]);
  const st = fs.statSync(path.join(BACKUP_DIR, name));
  return { name, size: st.size, mtime: st.mtimeMs };
};

/**
 * Restore a backup over the current config. Snapshots the current config first
 * (so a bad restore is itself recoverable), then extracts the tarball into the
 * app root. The service must be restarted for the restored .env to take effect.
 */
export const restoreBackup = async (name: string): Promise<{ safetyBackup: string }> => {
  const full = resolveBackupPath(name);
  if (!fs.existsSync(full)) {
    throw new Error("el respaldo no existe");
  }
  ensureDir();
  // Safety snapshot of what's there right now.
  let safetyBackup = "";
  const present = BACKUP_CONTENTS.filter((f) => fs.existsSync(path.join(ROOT, f)));
  if (present.length > 0) {
    safetyBackup = `akbal-backup-pre-restore-${timestamp()}.tgz`;
    await run("tar", ["czf", path.join(BACKUP_DIR, safetyBackup), "-C", ROOT, ...present]);
  }
  await run("tar", ["xzf", full, "-C", ROOT]);
  return { safetyBackup };
};

export const deleteBackup = (name: string): void => {
  const full = resolveBackupPath(name);
  if (fs.existsSync(full)) {
    fs.unlinkSync(full);
  }
};
