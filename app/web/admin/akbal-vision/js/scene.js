import * as THREE from "../../vendor/three.module.min.js";

// Transparent WebGL overlay with an orthographic camera in CSS-pixel space:
// (0,0) top-left, +x right, +y down — so face pixel coords map to HUD geometry
// with a trivial transform. The scene sits above the <video> layer.
export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1000, 1000); // bounds set in resize()

  function resize(cssW, cssH) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(cssW, cssH, false);
    camera.left = 0; camera.right = cssW; camera.top = 0; camera.bottom = cssH;
    camera.updateProjectionMatrix();
  }
  function render() { renderer.render(scene, camera); }
  function toScene(px, py) { return { x: px, y: py }; } // identity in this ortho setup

  return { scene, camera, renderer, resize, render, toScene };
}
