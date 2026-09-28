// Wardrive status screen (docs/wardrive.md): a fullscreen Three.js backdrop
// showing what the attack engine is doing right now — a wireframe radar
// dome with a scanning sweep while a round is on the wire, pulsing red for
// attacks, flashing gold when a handshake lands. Driven by wardrive.js's
// poll loop through window.__akbalWardriveStatus.update(st); renders only
// while the overlay is visible (zero GPU cost when hidden).
"use strict";

import * as THREE from "three";

const container = document.getElementById("wd-status-screen");
const canvas = document.getElementById("wd-status-canvas");
const currentEl = document.getElementById("wd-status-current");
const feedEl = document.getElementById("wd-status-feed");
if (!container || !canvas) {
  window.__akbalWardriveStatus = { update: () => {} };
} else {
  init();
}

function init() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  camera.position.set(0, 3.2, 9);
  camera.lookAt(0, 0.4, 0);

  // Radar dome: wireframe hemisphere + rotating sweep disc + target ring
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(3, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x34d351, wireframe: true, transparent: true, opacity: 0.14 }),
  );
  scene.add(dome);

  const grid = new THREE.PolarGridHelper(3.2, 8, 4, 32, 0x1c3a2c, 0x14251f);
  grid.position.y = 0.01;
  scene.add(grid);

  const sweep = new THREE.Mesh(
    new THREE.RingGeometry(0.05, 3.1, 32, 1, 0, Math.PI / 5),
    new THREE.MeshBasicMaterial({ color: 0x34d351, transparent: true, opacity: 0.28, side: THREE.DoubleSide }),
  );
  sweep.rotation.x = -Math.PI / 2;
  sweep.position.y = 0.02;
  scene.add(sweep);

  // The target under attack: a red wireframe "AP" tetrahedron orbiting on
  // the dome edge; flashes gold on capture.
  const target = new THREE.Mesh(
    new THREE.TetrahedronGeometry(0.35),
    new THREE.MeshBasicMaterial({ color: 0xff4444, wireframe: true }),
  );
  target.position.set(2.4, 0.6, 0);
  scene.add(target);

  // Booty flags: one gold tetrahedron per captured handshake, orbiting
  const flagsGroup = new THREE.Group();
  scene.add(flagsGroup);

  // Ring of idle dots = other networks waiting in queue
  const queueGroup = new THREE.Group();
  scene.add(queueGroup);

  let visible = false;
  let running = false;
  let targetColor = 0xff4444;
  let capturedFlash = 0;

  function resize() {
    if (!container.clientWidth) return;
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", () => {
    if (visible) syncSize();
  });

  function syncSize() {
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    camera.aspect = container.clientWidth / container.clientHeight || 1;
    camera.updateProjectionMatrix();
  }

  const clock = new THREE.Clock();
  function tick() {
    if (!visible) {
      running = false;
      return;
    }
    requestAnimationFrame(tick);
    const t = clock.getElapsedTime();
    sweep.rotation.z = -t * 1.4;
    target.position.set(Math.cos(t * 0.7) * 2.4, 0.5 + Math.sin(t * 2) * 0.15, Math.sin(t * 0.7) * 2.4);
    target.rotation.y = t;
    // Pulse red while attacking; flash gold briefly on capture
    const mat = target.material;
    if (capturedFlash > 0) {
      capturedFlash -= 0.02;
      mat.color.setHex(capturedFlash > 0.5 ? 0xffd166 : 0x34d351);
    } else if (running) {
      mat.color.setHex(0xff4444);
    } else {
      mat.color.setHex(0x445566);
    }
    flagsGroup.rotation.y = t * 0.35;
    queueGroup.rotation.y = -t * 0.2;
    renderer.render(scene, camera);
  }

  function start() {
    if (running) return;
    running = true;
    visible = true;
    syncSize();
    tick();
  }

  function stop() {
    visible = false;
  }

  // ---- Status data ----
  let lastFeedTs = 0;
  function update(st) {
    running = Boolean(st?.running);
    const cur = st?.currentAttack || (st?.running ? "Escaneando redes..." : "En espera");
    if (currentEl && currentEl.textContent !== cur) currentEl.textContent = cur;
    const captured = (st?.activity || []).find((a) => a.kind === "captured");
    currentEl?.classList.toggle("captured", Boolean(captured));
    if (feedEl) {
      // Rebuild only when the newest entry changes (cheap diff).
      const newest = (st?.activity || [])[0]?.ts || 0;
      if (feedEl._akbalNewest !== newest) {
        feedEl._akbalNewest = newest;
        feedEl.innerHTML = (st?.activity || [])
          .slice(0, 8)
          .map(
            (a) =>
              `<div class="wd-status-line ${escapeHtml(a.kind)}">${escapeHtml(a.text)}<span style="opacity:.45; margin-left:10px;">${new Date(a.ts).toLocaleTimeString("es-MX")}</span></div>`,
          )
          .join("") || '<div class="wd-status-line">En espera — sin actividad</div>';
      }
    }
    // Booty flags: one gold tetra per captured SSID this session
    if (flagsGroup.children.length !== (st?.stats?.newHandshakes ?? 0)) {
      flagsGroup.clear();
      const n = st?.stats?.newHandshakes ?? 0;
      for (let i = 0; i < Math.min(n, 12); i++) {
        const f = new THREE.Mesh(
          new THREE.TetrahedronGeometry(0.22),
          new THREE.MeshBasicMaterial({ color: 0xffd166, wireframe: true }),
        );
        const a = (i / Math.max(1, Math.min(n, 12))) * Math.PI * 2;
        f.position.set(Math.cos(a) * 1.7, 0.35, Math.sin(a) * 1.7);
        flagsGroup.add(f);
      }
      if (n > 0) capturedFlash = 1;
    }
    // Queue dots = APs in scheduled state
    const qn = Math.min((st?.recent || []).filter((a) => a.status === "attack-scheduled").length, 10);
    if (queueGroup.children.length !== qn) {
      queueGroup.clear();
      for (let i = 0; i < qn; i++) {
        const d = new THREE.Mesh(
          new THREE.SphereGeometry(0.06, 6, 6),
          new THREE.MeshBasicMaterial({ color: 0x7ab7ff, transparent: true, opacity: 0.5 }),
        );
        const a = (i / Math.max(1, qn)) * Math.PI * 2;
        d.position.set(Math.cos(a) * 2.9, 0.12, Math.sin(a) * 2.9);
        queueGroup.add(d);
      }
    }
    if (captured && container.classList.contains("hidden")) return;
  }

  // Visibility: only render when the overlay is open.
  const observer = new MutationObserver(() => {
    const isHidden = container.classList.contains("hidden");
    if (isHidden) {
      stop();
    } else {
      start();
    }
  });
  observer.observe(container, { attributes: true, attributeFilter: ["class"] });
  if (!container.classList.contains("hidden")) start();

  window.__akbalWardriveStatus = { update };
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}