import { test } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { buildManifest } from "./format";
import { packPackage, readPackage, MAX_UNPACKED_BYTES } from "./package";

const files = {
  "session.json": Buffer.from('{"id":"drive-1"}'),
  "track.json": Buffer.from("[[19.4,-99.1]]"),
};

test("a package round-trips: what is packed comes back, verified", () => {
  const manifest = buildManifest(files, { credentials: false, origin: "akbal-pi" });
  const out = readPackage(packPackage(manifest, files));
  assert.equal(out.manifest.origin, "akbal-pi");
  assert.equal(out.files["track.json"].toString(), "[[19.4,-99.1]]");
});

test("a package with a path that leaves the folder is refused", () => {
  // adm-zip rewrites unsafe names when it writes, so the unsafe name is put
  // into the bytes afterwards (same length, so the headers stay valid).
  const zip = new AdmZip();
  const manifest = buildManifest({ "a.txt": Buffer.from("x") }, { credentials: false, origin: "x" });
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
  zip.addFile("a.txt", Buffer.from("x"));
  const bytes = zip.toBuffer();
  Buffer.from("../ab").copy(bytes, bytes.indexOf(Buffer.from("a.txt")));
  // The name appears twice (local header and central directory): patch both.
  Buffer.from("../ab").copy(bytes, bytes.indexOf(Buffer.from("a.txt")));
  assert.throws(() => readPackage(bytes), /ruta no permitida/);
});

test("a package that unpacks past the limit is refused before extraction", () => {
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from("{}"));
  zip.addFile("big.bin", Buffer.alloc(MAX_UNPACKED_BYTES + 1));
  assert.throws(() => readPackage(zip.toBuffer()), /demasiado grande/);
});

test("a package with a changed file is refused", () => {
  const manifest = buildManifest(files, { credentials: false, origin: "akbal-pi" });
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
  zip.addFile("session.json", files["session.json"]);
  zip.addFile("track.json", Buffer.from("[]"));
  assert.throws(() => readPackage(zip.toBuffer()), /fue alterado/);
});
