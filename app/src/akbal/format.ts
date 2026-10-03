import { createHash } from "crypto";

// The .akbal package format, version 1. A package is a ZIP whose entries are
// listed in manifest.json with a sha256 each. Import refuses anything that does
// not match, so a damaged or edited package never reaches the chat's data.
export const FORMAT_VERSION = 1;

export interface Manifest {
  formatVersion: number;
  createdAt: string;
  origin: string;
  credentials: boolean;
  files: Record<string, { sha256: string; bytes: number }>;
}

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

export const buildManifest = (
  files: Record<string, Buffer>,
  opts: { credentials: boolean; origin: string },
): Manifest => ({
  formatVersion: FORMAT_VERSION,
  createdAt: new Date().toISOString(),
  origin: opts.origin,
  credentials: opts.credentials,
  files: Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name, { sha256: sha256(data), bytes: data.length }]),
  ),
});

// Every listed file must be present with the same hash, and nothing else may be
// in the package. The manifest itself is not listed among its own files.
export const verifyManifest = (
  manifest: Manifest,
  files: Record<string, Buffer>,
): { ok: true } | { ok: false; reason: string } => {
  if (manifest.formatVersion !== FORMAT_VERSION) return { ok: false, reason: "versión de formato no soportada" };
  const listed = Object.keys(manifest.files);
  for (const name of listed) {
    const data = files[name];
    if (!data) return { ok: false, reason: `falta ${name}` };
    if (sha256(data) !== manifest.files[name].sha256) return { ok: false, reason: `${name} fue alterado` };
  }
  const extra = Object.keys(files).find((name) => !listed.includes(name));
  if (extra) return { ok: false, reason: `archivo no declarado: ${extra}` };
  return { ok: true };
};

// Names inside a package must stay inside it: relative, no parent steps, no
// backslashes. Anything else is refused before a single byte is written.
export const isSafeEntryName = (name: string): boolean => {
  if (!name || name.startsWith("/") || name.includes("\\")) return false;
  return name.split("/").every((part) => part !== ".." && part !== "" && part !== ".");
};
