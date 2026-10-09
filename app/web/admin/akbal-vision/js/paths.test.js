import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// The page is served from a subdirectory at URL "/akbal-vision" (no trailing
// slash), so RELATIVE asset refs resolve against "/" and 404. Every asset ref
// that the browser resolves against the document must be absolute. These guard
// against the two Critical findings (blank page / vision never starts).

test("index.html referencia css y script con rutas absolutas /akbal-vision/", () => {
  const html = read("../index.html");
  assert.match(html, /href="\/akbal-vision\/akbal-vision\.css"/);
  assert.match(html, /src="\/akbal-vision\/js\/app\.js"/);
  assert.doesNotMatch(html, /href="akbal-vision\.css"/);
  assert.doesNotMatch(html, /src="js\/app\.js"/);
});

test("vision.js carga el WASM y el modelo de MediaPipe con rutas absolutas", () => {
  const js = read("./vision.js");
  // FilesetResolver (wasm loader) and modelAssetPath are fetched DOCUMENT-relative
  // by MediaPipe, so they must be absolute — not the module-relative "../".
  assert.match(js, /forVisionTasks\("\/akbal-vision\/vendor\/mediapipe"\)/);
  assert.match(js, /modelAssetPath:\s*"\/akbal-vision\/models\/face_landmarker\.task"/);
  assert.doesNotMatch(js, /forVisionTasks\("\.\.\/vendor/);
  assert.doesNotMatch(js, /modelAssetPath:\s*"\.\.\/models/);
});

void here;
