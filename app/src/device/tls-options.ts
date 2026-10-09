import fs from "fs";
import http from "http";
import https from "https";
import net from "net";
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

// A TLS ClientHello starts with the handshake record type 0x16. Any plaintext
// HTTP request starts with an ASCII method ("GET", "POST"…), so the first byte
// disambiguates TLS from HTTP on a shared port.
export function isTlsClientHello(firstByte: number | undefined): boolean {
  return firstByte === 0x16;
}

// Absolute https URL to redirect a plaintext request to, on the same host and
// the TLS port. Strips any port the client sent and pins the TLS port so a bare
// "host:8090" typed as http lands on https without the user typing the scheme.
export function redirectLocation(hostHeader: string | undefined, url: string, port: number): string {
  const host = hostHeader && hostHeader.trim() ? hostHeader.replace(/:\d+$/, "") : "localhost";
  return `https://${host}:${port}${url && url.length > 0 ? url : "/"}`;
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

// Builds the listener to bind to the admin port. With TLS, a front net server
// sniffs the first byte of each connection: a TLS ClientHello goes to the https
// server; a plaintext HTTP request gets a 301 to https (so typing "host:port"
// — which browsers attempt as http — lands on https without the scheme). The
// returned `app` is the real http/https server to attach 'upgrade' to and to
// close; `listener` is what you call .listen() on. Without TLS (or an invalid
// cert), listener === app === a plain http server, exactly as before.
export function createAdminListener(
  tls: TlsOptions | null,
  requestListener: http.RequestListener,
  port: number,
  deps: { http: typeof http; https: typeof https; net: typeof net } = { http, https, net },
): { listener: http.Server | net.Server; app: http.Server; tls: boolean } {
  const built = createAdminHttpServer(tls, requestListener, deps);
  if (!built.tls) return { listener: built.server, app: built.server, tls: false };

  const httpsServer = built.server as https.Server;
  const redirector = deps.http.createServer((req, res) => {
    res.writeHead(301, { Location: redirectLocation(req.headers.host, req.url || "/", port) });
    res.end();
  });
  const front = deps.net.createServer((socket) => {
    socket.on("error", () => socket.destroy());
    // Drop connections that open but never send the first byte (a slow-loris
    // would otherwise sit in once("data") forever — the plain http.Server had
    // its own timeouts). Cleared once the real server takes over the socket.
    socket.setTimeout(30_000, () => socket.destroy());
    socket.once("data", (buf: Buffer) => {
      socket.setTimeout(0);
      socket.pause();
      const target = isTlsClientHello(buf[0]) ? httpsServer : redirector;
      target.emit("connection", socket);
      socket.unshift(buf);
      process.nextTick(() => socket.resume());
    });
  });
  return { listener: front, app: httpsServer, tls: true };
}
