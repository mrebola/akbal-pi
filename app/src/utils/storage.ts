import os from "os";
import fs from "fs";
import path from "path";
import { listUsbVolumes, findVolume, listFiles, resolveFilePath, UsbFileEntry } from "./usb";

// A single file-manager layer over several "storage roots": the Pi's internal
// filesystem plus any mounted USB volume. The same browse/upload/download/
// delete operations work on all of them; each root maps to a base directory and
// every user-supplied path is confined to it (see resolveFilePath in usb.ts).

export interface StorageRoot {
  key: string; // "internal" | "usb:<volumeName>"
  label: string;
}

// Where the "internal" root starts. The Pi user's home lives on the microSD and
// holds everything of interest (recordings, wardrive sessions, music, backups)
// without exposing the whole OS tree. Overridable via STORAGE_INTERNAL_ROOT.
const INTERNAL_BASE = process.env.STORAGE_INTERNAL_ROOT || os.homedir();

export const getStorageRoots = async (): Promise<StorageRoot[]> => {
  const roots: StorageRoot[] = [{ key: "internal", label: "Memoria interna" }];
  try {
    for (const v of await listUsbVolumes()) {
      if (v.mounted && v.mountPath) {
        roots.push({ key: `usb:${v.name}`, label: `USB · ${v.label || v.name}` });
      }
    }
  } catch {
    /* USB listing is best-effort */
  }
  return roots;
};

const baseForRoot = async (root: string): Promise<string | null> => {
  if (root === "internal") return INTERNAL_BASE;
  if (root.startsWith("usb:")) {
    const vol = await findVolume(root.slice(4));
    return vol && vol.mounted ? vol.mountPath : null;
  }
  return null;
};

export const storageList = async (
  root: string,
  rel: string,
): Promise<{ ok: boolean; base?: string; entries?: UsbFileEntry[]; error?: string }> => {
  const base = await baseForRoot(root);
  if (!base) return { ok: false, error: "raíz de almacenamiento no disponible" };
  const res = await listFiles(base, rel);
  return { ...res, base };
};

export const storageResolveFile = async (root: string, rel: string): Promise<string | null> => {
  const base = await baseForRoot(root);
  if (!base) return null;
  return resolveFilePath(base, rel);
};

const isSegmentSafe = (name: string): boolean =>
  Boolean(name) && !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..";

export const storageDelete = async (
  root: string,
  rel: string,
): Promise<{ ok: boolean; error?: string }> => {
  const base = await baseForRoot(root);
  if (!base) return { ok: false, error: "raíz no disponible" };
  const full = resolveFilePath(base, rel);
  if (!full) return { ok: false, error: "ruta inválida" };
  if (full === path.resolve(base)) return { ok: false, error: "no se puede borrar la raíz" };
  try {
    const st = await fs.promises.lstat(full);
    if (st.isDirectory()) {
      await fs.promises.rm(full, { recursive: true, force: true });
    } else {
      await fs.promises.unlink(full);
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
};

export const storageMkdir = async (
  root: string,
  rel: string,
  name: string,
): Promise<{ ok: boolean; error?: string }> => {
  if (!isSegmentSafe(name)) return { ok: false, error: "nombre de carpeta inválido" };
  const base = await baseForRoot(root);
  if (!base) return { ok: false, error: "raíz no disponible" };
  const full = resolveFilePath(base, path.join(rel || "", name));
  if (!full) return { ok: false, error: "ruta inválida" };
  try {
    await fs.promises.mkdir(full, { recursive: true });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
};

// Safe absolute path to write an uploaded file to (or null if invalid).
export const storageUploadTarget = async (
  root: string,
  rel: string,
  filename: string,
): Promise<string | null> => {
  if (!isSegmentSafe(filename)) return null;
  const base = await baseForRoot(root);
  if (!base) return null;
  return resolveFilePath(base, path.join(rel || "", filename));
};
