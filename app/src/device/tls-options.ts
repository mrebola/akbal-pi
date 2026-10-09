import fs from "fs";
import path from "path";

export type TlsOptions = { key: Buffer; cert: Buffer };

// Reads a self-signed key/cert pair from certDir. Returns null if either file
// is missing, empty, or unreadable, so the server falls back to plain http
// (dev, or a device where the cert was never generated). Never throws.
export function resolveTlsOptions(certDir: string, fsMod: typeof fs = fs): TlsOptions | null {
  try {
    const key = fsMod.readFileSync(path.join(certDir, "key.pem"));
    const cert = fsMod.readFileSync(path.join(certDir, "cert.pem"));
    if (key.length > 0 && cert.length > 0) return { key, cert };
    return null;
  } catch {
    return null;
  }
}

export function urlScheme(hasTls: boolean): "https" | "http" {
  return hasTls ? "https" : "http";
}
