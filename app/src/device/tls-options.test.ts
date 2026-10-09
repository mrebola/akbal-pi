import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveTlsOptions, urlScheme } from "./tls-options";

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "av-tls-")); }

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
