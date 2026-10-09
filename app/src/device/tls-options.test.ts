import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveTlsOptions, urlScheme, detectTlsScheme, createAdminHttpServer } from "./tls-options";

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "av-tls-")); }
function withCert(d: string) {
  fs.writeFileSync(path.join(d, "key.pem"), "KEY");
  fs.writeFileSync(path.join(d, "cert.pem"), "CERT");
  return d;
}

test("resolveTlsOptions devuelve null si el directorio no tiene cert", () => {
  assert.equal(resolveTlsOptions(tmpDir()), null);
});

test("resolveTlsOptions devuelve {key,cert} si ambos existen y no están vacíos", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "key.pem"), "KEY");
  fs.writeFileSync(path.join(d, "cert.pem"), "CERT");
  const r = resolveTlsOptions(d);
  assert.ok(r);
  assert.equal(r.key.toString(), "KEY");
  assert.equal(r.cert.toString(), "CERT");
});

test("resolveTlsOptions devuelve null si falta uno o está vacío", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "key.pem"), "KEY"); // falta cert
  assert.equal(resolveTlsOptions(d), null);
  fs.writeFileSync(path.join(d, "cert.pem"), ""); // cert vacío
  assert.equal(resolveTlsOptions(d), null);
});

test("urlScheme", () => {
  assert.equal(urlScheme(true), "https");
  assert.equal(urlScheme(false), "http");
});

test("detectTlsScheme: https si el dir tiene cert, http si no", () => {
  assert.equal(detectTlsScheme(withCert(tmpDir())), "https");
  assert.equal(detectTlsScheme(tmpDir()), "http");
});

test("createAdminHttpServer: usa https con cert válido", () => {
  const fakeHttps = { createServer: () => ({ kind: "https" }) } as any;
  const fakeHttp = { createServer: () => ({ kind: "http" }) } as any;
  const r = createAdminHttpServer({ key: Buffer.from("K"), cert: Buffer.from("C") }, () => {}, { http: fakeHttp, https: fakeHttps });
  assert.equal(r.tls, true);
  assert.equal((r.server as any).kind, "https");
});

test("createAdminHttpServer: sin cert usa http", () => {
  const fakeHttp = { createServer: () => ({ kind: "http" }) } as any;
  const fakeHttps = { createServer: () => ({ kind: "https" }) } as any;
  const r = createAdminHttpServer(null, () => {}, { http: fakeHttp, https: fakeHttps });
  assert.equal(r.tls, false);
  assert.equal((r.server as any).kind, "http");
});

test("createAdminHttpServer: cert inválido (https lanza) cae a http sin propagar", () => {
  const fakeHttps = { createServer: () => { throw new Error("bad pem"); } } as any;
  const fakeHttp = { createServer: () => ({ kind: "http" }) } as any;
  let r: any;
  assert.doesNotThrow(() => {
    r = createAdminHttpServer({ key: Buffer.from("K"), cert: Buffer.from("C") }, () => {}, { http: fakeHttp, https: fakeHttps });
  });
  assert.equal(r.tls, false);
  assert.equal((r.server as any).kind, "http");
});
