import fs from "fs";
import http from "http";
import https from "https";
import path from "path";

export type TlsOptions = { key: Buffer; cert: Buffer };

// The default cert directory (app/data/tls), resolvable from anywhere so both
// the server and the DOOM-URL caller agree without passing it around.
export function defaultTlsDir(): string {
  return process.env.WEB_ADMIN_TLS_DIR || path.resolve(__dirname, "..", "..", "data", "tls");
}

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

// "https" if a cert exists in the given dir (default: app/data/tls), else
// "http". Used by callers that build self-referential URLs (e.g. the DOOM QR
// shown on the device screen) but don't hold the server's tlsEnabled flag.
export function detectTlsScheme(tlsDir: string = defaultTlsDir()): "https" | "http" {
  return urlScheme(!!resolveTlsOptions(tlsDir));
}

// Builds the admin HTTP(S) server. With a cert, tries https and — if the cert
// content is present but invalid (truncated/corrupt), so https.createServer
// THROWS — falls back to http instead of crashing the whole process (start()
// runs at module load with no try/catch upstream). Deps are injectable for
// tests.
export function createAdminHttpServer(
  tls: TlsOptions | null,
  requestListener: http.RequestListener,
  deps: { http: typeof http; https: typeof https } = { http, https },
): { server: http.Server; tls: boolean } {
  if (tls) {
    try {
      return { server: deps.https.createServer(tls, requestListener), tls: true };
    } catch {
      /* invalid cert — fall through to http */
    }
  }
  return { server: deps.http.createServer(requestListener), tls: false };
}
