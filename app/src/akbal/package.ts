import AdmZip from "adm-zip";
import { isSafeEntryName, Manifest, verifyManifest } from "./format";

// A package is refused when it would unpack past this size, checked from the
// ZIP headers before any file is extracted (guards against zip bombs).
export const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

export const packPackage = (manifest: Manifest, files: Record<string, Buffer>): Buffer => {
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));
  for (const [name, data] of Object.entries(files)) zip.addFile(name, data);
  return zip.toBuffer();
};

export const readPackage = (bytes: Buffer): { manifest: Manifest; files: Record<string, Buffer> } => {
  const zip = new AdmZip(bytes);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const total = entries.reduce((sum, e) => sum + e.header.size, 0);
  if (total > MAX_UNPACKED_BYTES) throw new Error("el paquete es demasiado grande al descomprimirse");
  for (const entry of entries) {
    if (!isSafeEntryName(entry.entryName)) throw new Error(`ruta no permitida: ${entry.entryName}`);
  }
  const manifestEntry = entries.find((e) => e.entryName === "manifest.json");
  if (!manifestEntry) throw new Error("el paquete no tiene manifest.json");
  const manifest = JSON.parse(manifestEntry.getData().toString("utf8")) as Manifest;
  const files: Record<string, Buffer> = {};
  for (const entry of entries) {
    if (entry.entryName !== "manifest.json") files[entry.entryName] = entry.getData();
  }
  const check = verifyManifest(manifest, files);
  if (!check.ok) throw new Error(check.reason);
  return { manifest, files };
};
