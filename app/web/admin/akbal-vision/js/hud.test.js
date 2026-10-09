import { test } from "node:test";
import assert from "node:assert/strict";
import { createHud } from "./hud.js";

// Minimal THREE stub that records geometry/material disposals, so we can assert
// the HUD frees GPU resources when a subject disappears (kiosk runs 24/7).
function fakeThree(counters) {
  class BufferGeometry { setFromPoints() { return this; } dispose() { counters.geo++; } }
  class LineBasicMaterial { dispose() { counters.mat++; } }
  class LineSegments { constructor(geo, mat) { this.geometry = geo; this.material = mat; } }
  class Group {
    constructor() { this.children = []; this.userData = {}; }
    add(c) { this.children.push(c); }
    traverse(fn) { fn(this); for (const c of this.children) fn(c); }
  }
  class Vector3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }
  return { BufferGeometry, LineBasicMaterial, LineSegments, Group, Vector3 };
}

test("el HUD libera (dispose) geometrías y materiales al perder un sujeto", () => {
  const counters = { geo: 0, mat: 0 };
  const THREE = fakeThree(counters);
  const scene = { add() {}, remove() {} };
  const hud = createHud({ scene, render() {} }, THREE);
  const metrics = { cssW: 1280, cssH: 720, videoW: 1280, videoH: 720, mirror: true };
  const subj = {
    id: "SUBJ-0001", bbox: { x: 100, y: 100, w: 80, h: 80 }, isPrimary: true,
    landmarks: [{ x: 120, y: 120 }, { x: 150, y: 140 }],
  };
  hud.update({ subjects: { "SUBJ-0001": subj }, primaryId: "SUBJ-0001" }, metrics);
  assert.equal(counters.geo, 0, "nada se libera mientras el sujeto está presente");
  hud.update({ subjects: {}, primaryId: null }, metrics); // el sujeto desaparece
  assert.ok(counters.geo >= 2, "las 2 geometrías del group se liberan");
  assert.ok(counters.mat >= 2, "los 2 materiales del group se liberan");
});
