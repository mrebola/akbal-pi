// WIFIRADAR — fullscreen Three.js WiFi visualization. Renders exclusively in
// this browser tab; the Raspberry Pi backend (device/web-admin-server.ts +
// wifiradar/*) only ever sends small aggregated JSON snapshots over
// /wifiradar/ws, 2-4Hz, never raw packets. See docs/wifiradar.md.
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";

// ---- DOM refs ----
const canvas = document.getElementById("scene");
const bootOverlay = document.getElementById("boot-overlay");
const bootSub = document.getElementById("boot-sub");
const demoBadge = document.getElementById("demo-badge");
const searchInput = document.getElementById("search-input");
const livePauseBtn = document.getElementById("live-pause-btn");
const resetViewBtn = document.getElementById("reset-view-btn");
const dimToggleBtn = document.getElementById("dim-toggle-btn");
const qualitySelect = document.getElementById("quality-select");
const hudAps = document.getElementById("hud-aps");
const hudDevices = document.getElementById("hud-devices");
const hudChannel = document.getElementById("hud-channel");
const hudFpm = document.getElementById("hud-fpm");
const hudAlerts = document.getElementById("hud-alerts");
const hudSpectrum = document.getElementById("hud-spectrum");
const sidePanel = document.getElementById("side-panel");
const sidePanelClose = document.getElementById("side-panel-close");
const eventTicker = document.getElementById("event-ticker");
const wsStatusEl = document.getElementById("ws-status");
const sp = {
  ssid: document.getElementById("sp-ssid"),
  bssid: document.getElementById("sp-bssid"),
  vendor: document.getElementById("sp-vendor"),
  rssi: document.getElementById("sp-rssi"),
  channel: document.getElementById("sp-channel"),
  security: document.getElementById("sp-security"),
  first: document.getElementById("sp-first"),
  last: document.getElementById("sp-last"),
  frames: document.getElementById("sp-frames"),
  clients: document.getElementById("sp-clients"),
};

// ---- state ----
let paused = false;
let is3D = true;
let quality = "auto";
let effectiveQuality = "medium";
let selectedId = null;
let searchTerm = "";
let latestSnapshot = null;
const knownEventIds = new Set();
let firstSnapshotApplied = false;

const QUALITY_TIERS = {
  low: { dpr: 1, antialias: false, stars: 30, pulses: false, glow: false },
  medium: { dpr: Math.min(1.5, window.devicePixelRatio || 1), antialias: true, stars: 70, pulses: true, glow: true },
  high: { dpr: Math.min(2, window.devicePixelRatio || 1), antialias: true, stars: 100, pulses: true, glow: true },
};

function currentTier() {
  return QUALITY_TIERS[effectiveQuality];
}

// ---- renderer / scene / camera ----
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x04070a, 0.028);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
const DEFAULT_CAMERA_POS = new THREE.Vector3(0, 9, 16);
camera.position.copy(DEFAULT_CAMERA_POS);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: currentTier().antialias, alpha: false });
renderer.setPixelRatio(currentTier().dpr);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x04070a, 1);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 4;
controls.maxDistance = 60;
controls.target.set(0, 0, 0);

// ---- lighting (minimal — most materials are emissive/basic, no dynamic shadows) ----
scene.add(new THREE.AmbientLight(0x1a2a33, 1.2));
const coreLight = new THREE.PointLight(0x38e0ff, 6, 30, 2);
coreLight.position.set(0, 1, 0);
scene.add(coreLight);

// ---- AKBAL core ----
const coreGroup = new THREE.Group();
scene.add(coreGroup);

const coreGeom = new THREE.IcosahedronGeometry(1.1, 1);
const coreMat = new THREE.MeshStandardMaterial({
  color: 0x0b2733,
  emissive: 0x38e0ff,
  emissiveIntensity: 1.1,
  roughness: 0.35,
  metalness: 0.2,
  wireframe: false,
});
const coreMesh = new THREE.Mesh(coreGeom, coreMat);
coreGroup.add(coreMesh);

const coreWire = new THREE.Mesh(
  new THREE.IcosahedronGeometry(1.16, 1),
  new THREE.MeshBasicMaterial({ color: 0x38e0ff, wireframe: true, transparent: true, opacity: 0.35 }),
);
coreGroup.add(coreWire);

// Cheap fake-glow: a couple of larger, additive, near-transparent shells
// behind the core instead of a full bloom postprocessing pass (EffectComposer
// + UnrealBloomPass would mean a second offscreen render pass every frame —
// not worth it against the "moderate bloom" requirement on a Pi 5).
const glowGroup = new THREE.Group();
for (let i = 0; i < 2; i++) {
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(1.5 + i * 0.9, 16, 16),
    new THREE.MeshBasicMaterial({
      color: 0x38e0ff,
      transparent: true,
      opacity: 0.06 - i * 0.02,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glowGroup.add(glow);
}
coreGroup.add(glowGroup);

// Radar disc: concentric rings + a rotating sweep wedge on the XZ ground plane.
const radarGroup = new THREE.Group();
radarGroup.rotation.x = -Math.PI / 2;
scene.add(radarGroup);

const RADAR_MAX_RADIUS = 11;
for (const r of [3, 6, 9, RADAR_MAX_RADIUS]) {
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 65 }, (_, i) => {
        const a = (i / 64) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0);
      }),
    ),
    new THREE.LineBasicMaterial({ color: 0x1c4a55, transparent: true, opacity: 0.5 }),
  );
  radarGroup.add(ring);
}

const sweepMesh = new THREE.Mesh(
  new THREE.CircleGeometry(RADAR_MAX_RADIUS, 48, 0, 0.22),
  new THREE.MeshBasicMaterial({
    color: 0x38e0ff,
    transparent: true,
    opacity: 0.14,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
);
radarGroup.add(sweepMesh);

// ---- starfield background ----
let starPoints = null;
function buildStarfield(count) {
  if (starPoints) {
    scene.remove(starPoints);
    starPoints.geometry.dispose();
  }
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const radius = 40 + Math.random() * 60;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = Math.abs(radius * Math.sin(phi) * Math.sin(theta)) * 0.4;
    positions[i * 3 + 2] = radius * Math.cos(phi);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  starPoints = new THREE.Points(
    geom,
    new THREE.PointsMaterial({ color: 0x2b6dff, size: 0.35, transparent: true, opacity: 0.55, sizeAttenuation: true }),
  );
  scene.add(starPoints);
}
buildStarfield(currentTier().stars);

// ---- security -> color ----
function securityColor(security) {
  switch (security) {
    case "OPEN":
      return 0xffd166;
    case "WEP":
      return 0xff8a4d;
    case "WPA":
      return 0x38e0ff;
    case "WPA2/3":
      return 0x4dffa0;
    default:
      return 0x6f92a0;
  }
}

// ---- deterministic stable placement per node id ----
function hash01(str, salt) {
  let h = salt >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h ^ str.charCodeAt(i), 2654435761) >>> 0) + h;
  }
  return ((h >>> 0) % 100000) / 100000;
}

function apPosition(ap) {
  const theta = hash01(ap.id, 17) * Math.PI * 2;
  const phi = 0.35 + hash01(ap.id, 91) * (Math.PI - 0.7); // keep off the poles
  const rssi = Math.max(-95, Math.min(-30, ap.rssi));
  const t = (rssi + 95) / 65; // 0 = weak/far, 1 = strong/close
  const radius = 9.5 - t * 6.2; // 3.3 (close) .. 9.5 (far) — visual only, never a real distance
  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    Math.abs(radius * Math.sin(phi) * Math.sin(theta)) * 0.55 + 0.4,
    radius * Math.cos(phi),
  );
}

// ---- AP nodes (individual meshes — capped at 30, interactive, so
// InstancedMesh isn't worth the added complexity here; see device nodes
// below for where InstancedMesh actually pays off) ----
const MAX_APS = 30;
const apNodeGeom = new THREE.OctahedronGeometry(0.34, 0);
const apNodes = new Map(); // id -> { mesh, data, labelEl }
const labelsLayer = document.createElement("div");
labelsLayer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:12;";
document.body.appendChild(labelsLayer);

function makeApLabel() {
  const el = document.createElement("div");
  el.style.cssText =
    "position:absolute;transform:translate(-50%,-130%);font:11px 'Courier New',monospace;color:#d7f6ff;" +
    "background:rgba(6,14,18,0.7);border:1px solid rgba(56,224,255,0.25);border-radius:4px;padding:2px 6px;" +
    "white-space:nowrap;pointer-events:none;";
  labelsLayer.appendChild(el);
  return el;
}

function ensureApNode(ap) {
  let node = apNodes.get(ap.id);
  if (!node) {
    const mat = new THREE.MeshStandardMaterial({
      color: securityColor(ap.security),
      emissive: securityColor(ap.security),
      emissiveIntensity: 0.9,
      roughness: 0.4,
    });
    const mesh = new THREE.Mesh(apNodeGeom, mat);
    mesh.userData.apId = ap.id;
    scene.add(mesh);
    node = { mesh, data: ap, labelEl: makeApLabel(), targetPos: apPosition(ap) };
    apNodes.set(ap.id, node);
    mesh.position.copy(node.targetPos);
    spawnPulse(node.targetPos, 0x38e0ff); // NEW_AP-style entrance pulse
  }
  node.data = ap;
  node.targetPos = apPosition(ap);
  node.mesh.material.color.setHex(securityColor(ap.security));
  node.mesh.material.emissive.setHex(securityColor(ap.security));
  return node;
}

function pruneApNodes(currentIds) {
  for (const [id, node] of apNodes) {
    if (!currentIds.has(id)) {
      scene.remove(node.mesh);
      node.mesh.material.dispose();
      node.labelEl.remove();
      apNodes.delete(id);
    }
  }
}

// ---- device (client) nodes — InstancedMesh, orbiting their AP ----
const MAX_DEVICES = 50;
const deviceGeom = new THREE.SphereGeometry(0.09, 6, 6);
const deviceMat = new THREE.MeshBasicMaterial({ color: 0x4dffa0, transparent: true, opacity: 0.85 });
const deviceMesh = new THREE.InstancedMesh(deviceGeom, deviceMat, MAX_DEVICES);
deviceMesh.count = 0;
scene.add(deviceMesh);
let deviceOrbitState = []; // parallel array: { angle, radius, apId }

// ---- pulse / event effects — pooled, capped ----
const MAX_PULSES = 100;
const pulsePool = [];
for (let i = 0; i < MAX_PULSES; i++) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 0.5, 24),
    new THREE.MeshBasicMaterial({ color: 0x38e0ff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  );
  mesh.visible = false;
  scene.add(mesh);
  pulsePool.push({ mesh, life: 0, maxLife: 0 });
}
function spawnPulse(position, color) {
  if (!currentTier().pulses) return;
  const p = pulsePool.find((p) => p.life <= 0);
  if (!p) return;
  p.mesh.position.copy(position);
  p.mesh.lookAt(camera.position);
  p.mesh.material.color.setHex(color);
  p.mesh.scale.setScalar(0.3);
  p.life = 1;
  p.maxLife = 1;
  p.mesh.visible = true;
}
function updatePulses(dt) {
  for (const p of pulsePool) {
    if (p.life <= 0) continue;
    p.life -= dt * 0.9;
    if (p.life <= 0) {
      p.mesh.visible = false;
      continue;
    }
    const t = 1 - p.life;
    p.mesh.scale.setScalar(0.3 + t * 6);
    p.mesh.material.opacity = Math.max(0, p.life) * 0.8;
  }
}

const EVENT_PULSE_COLOR = { info: 0x38e0ff, warning: 0xffd166, alert: 0xff4d5e };

// ---- raycaster / selection ----
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDownPos = null;

canvas.addEventListener("pointerdown", (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener("pointerup", (e) => {
  if (!pointerDownPos) return;
  const dx = e.clientX - pointerDownPos.x;
  const dy = e.clientY - pointerDownPos.y;
  pointerDownPos = null;
  if (Math.hypot(dx, dy) > 6) return; // was a drag, not a click
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const meshes = [...apNodes.values()].map((n) => n.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  if (hits.length > 0) {
    selectNode(hits[0].object.userData.apId);
  } else {
    deselectNode();
  }
});

function selectNode(id) {
  selectedId = id;
  const node = apNodes.get(id);
  if (!node) {
    deselectNode();
    return;
  }
  const ap = node.data;
  sp.ssid.textContent = ap.ssid || "(oculta)";
  sp.bssid.textContent = ap.bssid;
  sp.vendor.textContent = ap.vendor;
  sp.rssi.textContent = `${ap.rssi} dBm`;
  sp.channel.textContent = String(ap.channel);
  sp.security.textContent = ap.security;
  sp.first.textContent = new Date(ap.firstSeen).toLocaleTimeString();
  sp.last.textContent = new Date(ap.lastSeen).toLocaleTimeString();
  sp.frames.textContent = String(ap.frames);
  sp.clients.textContent = String(ap.clients);
  sidePanel.classList.remove("hidden");
}
function deselectNode() {
  selectedId = null;
  sidePanel.classList.add("hidden");
}
sidePanelClose.addEventListener("click", deselectNode);

// ---- HUD / event ticker ----
function updateHud(snapshot) {
  hudAps.textContent = String(snapshot.accessPoints.length);
  hudDevices.textContent = String(snapshot.devices.length);
  hudChannel.textContent = snapshot.currentChannel ? String(snapshot.currentChannel) : "—";
  hudFpm.textContent = String(snapshot.framesPerMinute);
  const alertCount = snapshot.events.filter((e) => e.severity === "alert").length;
  hudAlerts.textContent = String(alertCount);
  demoBadge.classList.toggle("hidden", !snapshot.demo);

  hudSpectrum.innerHTML = "";
  const maxFrames = Math.max(1, ...snapshot.channelActivity.map((c) => c.frames));
  for (let ch = 1; ch <= 13; ch++) {
    const entry = snapshot.channelActivity.find((c) => c.channel === ch);
    const bar = document.createElement("div");
    bar.className = "hud-spectrum-bar";
    const pct = entry ? Math.max(6, (entry.frames / maxFrames) * 100) : 2;
    bar.style.height = `${pct}%`;
    bar.title = `ch ${ch}: ${entry ? entry.frames : 0}`;
    hudSpectrum.appendChild(bar);
  }
}

function pushEventToTicker(evt) {
  const el = document.createElement("div");
  el.className = `event-item sev-${evt.severity}`;
  const time = new Date(evt.timestamp).toLocaleTimeString();
  el.textContent = `[${time}] ${evt.type} — ${evt.description}`;
  eventTicker.prepend(el);
  while (eventTicker.children.length > 12) {
    eventTicker.removeChild(eventTicker.lastChild);
  }
}

// ---- snapshot application ----
function applySnapshot(snapshot) {
  latestSnapshot = snapshot;
  updateHud(snapshot);

  const currentIds = new Set(snapshot.accessPoints.slice(0, MAX_APS).map((ap) => ap.id));
  for (const ap of snapshot.accessPoints.slice(0, MAX_APS)) {
    ensureApNode(ap);
  }
  pruneApNodes(currentIds);

  // Devices: pick up to MAX_DEVICES, distributed as small orbiting
  // instances around their associated AP node (or the core if unassigned).
  const devices = snapshot.devices.slice(0, MAX_DEVICES);
  deviceMesh.count = devices.length;
  deviceOrbitState = devices.map((d, i) => {
    const prior = deviceOrbitState[i];
    const apNode = d.associatedBssid
      ? [...apNodes.values()].find((n) => n.data.bssid === d.associatedBssid)
      : null;
    return {
      angle: prior ? prior.angle : Math.random() * Math.PI * 2,
      radius: 0.7 + hash01(d.id, 43) * 0.5,
      anchor: apNode ? apNode.targetPos : new THREE.Vector3(0, 0.4, 0),
    };
  });

  // New events (only the ones we haven't already shown) drive both the
  // ticker and a visual pulse on their source node.
  for (const evt of snapshot.events) {
    if (knownEventIds.has(evt.id)) continue;
    knownEventIds.add(evt.id);
    if (!firstSnapshotApplied) continue; // skip replaying backlog on first load
    pushEventToTicker(evt);
    const node = [...apNodes.values()].find((n) => n.data.bssid === evt.source);
    const pos = node ? node.targetPos : new THREE.Vector3(0, 0.4, 0);
    spawnPulse(pos, EVENT_PULSE_COLOR[evt.severity] || 0x38e0ff);
  }
  if (knownEventIds.size > 400) {
    // Don't let this set grow forever over a long-lived tab — keep only
    // recent ids (the backend itself already caps events at 200).
    const ids = [...knownEventIds];
    knownEventIds.clear();
    for (const id of ids.slice(-200)) knownEventIds.add(id);
  }

  applySearchFilter();
  if (selectedId) selectNode(selectedId); // refresh side panel with fresh data
  firstSnapshotApplied = true;
  bootOverlay.classList.add("hidden");
}

function applySearchFilter() {
  const term = searchTerm.trim().toLowerCase();
  for (const node of apNodes.values()) {
    const match = !term || node.data.ssid.toLowerCase().includes(term) || node.data.bssid.toLowerCase().includes(term);
    node.mesh.material.opacity = 1;
    node.mesh.material.transparent = !match;
    node.mesh.material.opacity = match ? 1 : 0.15;
    node.labelEl.style.opacity = match ? "1" : "0.15";
  }
}
searchInput.addEventListener("input", (e) => {
  searchTerm = e.target.value;
  applySearchFilter();
});

// ---- toolbar controls ----
livePauseBtn.addEventListener("click", () => {
  paused = !paused;
  livePauseBtn.textContent = paused ? "PAUSED" : "LIVE";
  livePauseBtn.classList.toggle("active", !paused);
  livePauseBtn.classList.toggle("paused", paused);
});

resetViewBtn.addEventListener("click", () => {
  camera.position.copy(DEFAULT_CAMERA_POS);
  controls.target.set(0, 0, 0);
  controls.update();
});

dimToggleBtn.addEventListener("click", () => {
  is3D = !is3D;
  dimToggleBtn.textContent = is3D ? "3D" : "2D";
  if (is3D) {
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
    camera.position.copy(DEFAULT_CAMERA_POS);
  } else {
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = 0;
    camera.position.set(0, 22, 0.001);
  }
  controls.target.set(0, 0, 0);
  controls.update();
});

qualitySelect.addEventListener("change", (e) => {
  quality = e.target.value;
  applyQuality(quality === "auto" ? effectiveQuality : quality);
});

function applyQuality(tier) {
  effectiveQuality = tier;
  const t = currentTier();
  renderer.setPixelRatio(t.dpr);
  buildStarfield(t.stars);
}
applyQuality("medium");

// ---- AUTO quality: watch FPS, step down/up with cooldown ----
let fpsHistory = [];
let lastQualityChangeAt = 0;
const TIERS_ORDER = ["low", "medium", "high"];
function autoAdaptQuality(fps) {
  if (quality !== "auto") return;
  fpsHistory.push(fps);
  if (fpsHistory.length > 90) fpsHistory.shift();
  if (fpsHistory.length < 60) return;
  const avg = fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length;
  const now = performance.now();
  if (now - lastQualityChangeAt < 4000) return;
  const idx = TIERS_ORDER.indexOf(effectiveQuality);
  if (avg < 30 && idx > 0) {
    applyQuality(TIERS_ORDER[idx - 1]);
    lastQualityChangeAt = now;
    fpsHistory = [];
  } else if (avg > 55 && idx < TIERS_ORDER.length - 1) {
    applyQuality(TIERS_ORDER[idx + 1]);
    lastQualityChangeAt = now;
    fpsHistory = [];
  }
}

// ---- resize ----
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- pause render loop when tab hidden ----
let rafHandle = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = null;
  } else if (!rafHandle) {
    lastFrameTime = performance.now();
    rafHandle = requestAnimationFrame(animate);
  }
});

// ---- animation loop ----
let lastFrameTime = performance.now();
const tmpVec = new THREE.Vector3();
const dummy = new THREE.Object3D();

function updateLabels() {
  for (const node of apNodes.values()) {
    tmpVec.copy(node.mesh.position).project(camera);
    if (tmpVec.z > 1) {
      node.labelEl.style.display = "none";
      continue;
    }
    node.labelEl.style.display = "block";
    const x = (tmpVec.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-tmpVec.y * 0.5 + 0.5) * window.innerHeight;
    node.labelEl.style.left = `${x}px`;
    node.labelEl.style.top = `${y}px`;
    node.labelEl.textContent = `${node.data.ssid || "(oculta)"} · ${node.data.rssi}dBm · ch${node.data.channel}`;
  }
}

function animate(now) {
  rafHandle = requestAnimationFrame(animate);
  const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  const fps = dt > 0 ? 1 / dt : 60;
  autoAdaptQuality(fps);

  coreGroup.rotation.y += dt * 0.15;
  coreWire.rotation.y -= dt * 0.25;
  const pulseScale = 1 + Math.sin(now * 0.0018) * 0.04;
  coreMesh.scale.setScalar(pulseScale);
  radarGroup.children[radarGroup.children.length - 1].rotation.z += dt * 1.1; // sweep

  for (const node of apNodes.values()) {
    node.mesh.position.lerp(node.targetPos, Math.min(1, dt * 3));
    node.mesh.rotation.y += dt * 0.6;
    const isSelected = node.data.id === selectedId;
    node.mesh.scale.setScalar(isSelected ? 1.5 : 1);
  }

  for (let i = 0; i < deviceOrbitState.length; i++) {
    const st = deviceOrbitState[i];
    st.angle += dt * 0.8;
    dummy.position.set(
      st.anchor.x + Math.cos(st.angle) * st.radius,
      st.anchor.y + Math.sin(st.angle * 1.3) * 0.15,
      st.anchor.z + Math.sin(st.angle) * st.radius,
    );
    dummy.updateMatrix();
    deviceMesh.setMatrixAt(i, dummy.matrix);
  }
  if (deviceOrbitState.length > 0) deviceMesh.instanceMatrix.needsUpdate = true;

  updatePulses(dt);
  updateLabels();
  controls.update();
  renderer.render(scene, camera);
}
rafHandle = requestAnimationFrame(animate);

// ---- WebSocket client ----
let ws = null;
let reconnectDelay = 1000;
function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/wifiradar/ws`);
  ws.addEventListener("open", () => {
    reconnectDelay = 1000;
    wsStatusEl.textContent = "";
  });
  ws.addEventListener("message", (evt) => {
    if (paused) return;
    try {
      const snapshot = JSON.parse(evt.data);
      applySnapshot(snapshot);
    } catch (err) {
      console.warn("[wifiradar] bad snapshot", err);
    }
  });
  ws.addEventListener("close", () => {
    wsStatusEl.textContent = "reconectando...";
    setTimeout(connectWs, reconnectDelay);
    reconnectDelay = Math.min(10000, reconnectDelay * 1.6);
  });
  ws.addEventListener("error", () => ws.close());
}

// Initial snapshot over plain fetch for instant first paint — the socket
// takes over a moment later, same data shape either way.
bootSub.textContent = "conectando con AKBAL...";
fetch("/api/wifiradar/snapshot")
  .then((res) => {
    if (res.status === 401) {
      window.location.href = "/login";
      return null;
    }
    return res.json();
  })
  .then((snapshot) => {
    if (snapshot) applySnapshot(snapshot);
    connectWs();
  })
  .catch((err) => {
    bootSub.textContent = `error: ${err.message}`;
    connectWs();
  });
