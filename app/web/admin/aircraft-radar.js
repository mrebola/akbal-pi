// AIRCRAFT RADAR — HackRF One + dump1090 ADS-B (docs/aircraft-radar.md).
// The backend (device/web-admin-server.ts + services/adsb/*) only ever
// sends small aggregated JSON snapshots over /aircraft-radar/ws, same
// shape/cadence as WIFIRADAR's own /wifiradar/ws (see wifiradar.js).
import * as THREE from "three";

// ---- shared topbar wiring (same markup/classes as the rest of the admin
// UI — see wifiradar.js/gps.js, duplicated per page since these are
// build-step-free static pages) ----
const statusPill = document.getElementById("status-pill");
const batteryIndicator = document.getElementById("battery-indicator");
const batteryIcon = document.getElementById("battery-icon");
const batteryPct = document.getElementById("battery-pct");
const statCpu = document.getElementById("stat-cpu");
const statRam = document.getElementById("stat-ram");
const statDisk = document.getElementById("stat-disk");
const logoutBtn = document.getElementById("logout-btn");

logoutBtn.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/login";
});

function setTxt(id, t) {
  const el = document.getElementById(id);
  if (el) el.textContent = t;
}

function updateBatteryIndicator(battery) {
  if (!battery || !battery.connected || battery.level == null) {
    batteryPct.textContent = "N/A";
    batteryIcon.textContent = "🔋";
    batteryIndicator.classList.remove("low", "charging");
    return;
  }
  batteryPct.textContent = `${battery.level}%`;
  batteryIcon.textContent = battery.charging ? "⚡" : "🔋";
  batteryIndicator.classList.toggle("low", battery.level <= 15 && !battery.charging);
  batteryIndicator.classList.toggle("charging", Boolean(battery.charging));
}

function updateSystemStats(system) {
  if (!system) return;
  statCpu.textContent = `${system.cpuPercent}%`;
  statRam.textContent = `${system.ram.percent}%`;
  statDisk.textContent = `${system.disk.percent}%`;
  statCpu.classList.toggle("warn", system.cpuPercent >= 85);
  statRam.classList.toggle("warn", system.ram.percent >= 85);
  statDisk.classList.toggle("warn", system.disk.percent >= 90);
}

async function loadTopbarStatus() {
  try {
    const res = await fetch("/api/status");
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    const data = await res.json();
    const wifiLabel = data.wifi?.connected ? data.wifi.ssid : "sin wifi";
    statusPill.textContent = `${data.model} · ${wifiLabel}`;
    setTxt("hdr-model", data.model || "—");
    setTxt("hdr-model-full", data.model || "—");
    setTxt("hdr-wifi", wifiLabel);
    const dot = document.getElementById("hdr-online-dot");
    if (dot) dot.classList.add("online");
    updateBatteryIndicator(data.battery);
    updateSystemStats(data.system);
  } catch {
    statusPill.textContent = "sin conexión con el dispositivo";
    const dot = document.getElementById("hdr-online-dot");
    if (dot) dot.classList.remove("online");
  }
}

(function mobileNav() {
  const toggle = document.getElementById("nav-toggle");
  const tabs = document.getElementById("main-tabs");
  const backdrop = document.getElementById("nav-backdrop");
  if (!toggle || !tabs || !backdrop) return;
  function close() {
    tabs.classList.remove("open");
    backdrop.classList.add("hidden");
    toggle.setAttribute("aria-expanded", "false");
  }
  function open() {
    tabs.classList.add("open");
    backdrop.classList.remove("hidden");
    toggle.setAttribute("aria-expanded", "true");
  }
  toggle.addEventListener("click", () => (tabs.classList.contains("open") ? close() : open()));
  backdrop.addEventListener("click", close);
  for (const link of tabs.querySelectorAll(".tab-link")) link.addEventListener("click", close);
})();

(function sysPopover() {
  const toggle = document.getElementById("sys-toggle");
  const pop = document.getElementById("sys-popover");
  if (!toggle || !pop) return;
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!pop.contains(e.target) && e.target !== toggle) pop.classList.add("hidden");
  });
})();

void loadTopbarStatus();
setInterval(loadTopbarStatus, 60000);

// ---- platform toggle (LIVE/DEMO) — per-feature, posts /api/aircraft/mode
// (unlike WIFIRADAR's toggle, which posts the device-wide /api/platform/mode
// — Aircraft Radar isn't part of that shared switch's UI, only its backend
// wiring in utils/platform-mode.ts) ----
let requestedMode = "live";

function initPlatformToggle() {
  const toggle = document.getElementById("platform-toggle");
  if (!toggle) return;
  const render = () => {
    for (const label of toggle.querySelectorAll(".plx-toggle-label")) {
      label.classList.toggle("active", label.dataset.mode === requestedMode);
    }
  };
  void (async () => {
    try {
      const res = await fetch("/api/aircraft/mode");
      if (res.ok) {
        const data = await res.json();
        requestedMode = data.requested || "live";
      }
    } catch { /* default live */ }
    render();
  })();
  toggle.addEventListener("click", async (ev) => {
    const label = ev.target.closest(".plx-toggle-label");
    if (!label || label.dataset.mode === requestedMode) return;
    toggle.classList.add("busy");
    try {
      const res = await fetch("/api/aircraft/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: label.dataset.mode }),
      });
      const data = await res.json();
      if (data && data.ok) requestedMode = data.requested;
    } catch { /* keep previous state */ }
    toggle.classList.remove("busy");
    render();
  });
}
initPlatformToggle();

// ---- radar state ----
const listEl = document.getElementById("ar-list");
const emptyEl = document.getElementById("ar-empty");
const canvas = document.getElementById("ar-radar");
const ctx = canvas.getContext("2d");
const nofixEl = document.getElementById("ar-nofix");
const detailModal = document.getElementById("ar-detail-modal");
const detailBody = document.getElementById("ar-detail-body");
document.getElementById("ar-detail-close").addEventListener("click", () => detailModal.classList.add("hidden"));
detailModal.querySelector(".apm-backdrop").addEventListener("click", () => detailModal.classList.add("hidden"));

const RING_KM = [10, 25, 50, 100];
const MAX_RANGE_KM = RING_KM[RING_KM.length - 1];

let latestSnapshot = null;
let selectedIcao = null;

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}
window.addEventListener("resize", resizeCanvas);

function fmt(value, unit, digits = 0) {
  if (value === null || value === undefined) return "—";
  return `${Number(value).toFixed(digits)}${unit || ""}`;
}

function routeLabel(aircraft) {
  return aircraft.origin && aircraft.destination ? `${aircraft.origin} → ${aircraft.destination}` : "Route unknown";
}

function displayName(aircraft) {
  return aircraft.callsign || aircraft.icao;
}

function renderList(snapshot) {
  listEl.querySelectorAll(".ar-card").forEach((el) => el.remove());
  emptyEl.classList.toggle("hidden", snapshot.aircraft.length > 0);
  for (const aircraft of snapshot.aircraft) {
    const card = document.createElement("div");
    card.className = "ar-card" + (aircraft.icao === selectedIcao ? " selected" : "");
    card.dataset.icao = aircraft.icao;
    card.innerHTML = `
      <div class="ar-card-top">
        <span class="ar-flight">${displayName(aircraft)}</span>
        <span class="ar-reg">${aircraft.registration || aircraft.icao}</span>
      </div>
      <div class="ar-model">${aircraft.manufacturer ? `${aircraft.manufacturer} ${aircraft.model || ""}`.trim() : (aircraft.model || "Modelo desconocido")}</div>
      <div class="ar-route">${routeLabel(aircraft)}</div>
      <div class="ar-card-metrics">
        <span>${fmt(aircraft.altitudeFt, " ft")}</span>
        <span>${fmt(aircraft.speedKt, " kt")}</span>
        <span class="${aircraft.distanceKm === null ? "" : "warn"}">${aircraft.distanceKm === null ? "sin GPS" : fmt(aircraft.distanceKm, " km", 1)}</span>
        <span>${aircraft.bearingDeg === null ? "" : `${bearingCompass(aircraft.bearingDeg)} ${Math.round(aircraft.bearingDeg)}°`}</span>
      </div>
    `;
    card.addEventListener("click", () => openDetail(aircraft));
    listEl.appendChild(card);
  }
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function bearingCompass(deg) {
  return COMPASS[Math.round(deg / 45) % 8];
}

function render() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);
  if (!w || !h) return;

  const cx = w / 2;
  const cy = h / 2;
  const maxRadiusPx = Math.min(w, h) / 2 - 24;

  // Rings
  ctx.strokeStyle = "rgba(80, 255, 120, 0.18)";
  ctx.fillStyle = "rgba(150, 156, 161, 0.7)";
  ctx.font = "10px monospace";
  ctx.lineWidth = 1;
  for (const km of RING_KM) {
    const r = (km / MAX_RANGE_KM) * maxRadiusPx;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Akbal at the center
  ctx.fillStyle = "#50ff78";
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();

  if (!latestSnapshot) return;
  const withFix = latestSnapshot.aircraft.filter((a) => a.distanceKm !== null && a.bearingDeg !== null);
  // Only relevant in radar view — the map plots aircraft by their own
  // absolute lat/lon and never needs Akbal's fix to do it.
  nofixEl.classList.toggle("hidden", view !== "radar" || withFix.length > 0 || latestSnapshot.aircraft.length === 0);

  for (const aircraft of withFix) {
    const r = Math.min(aircraft.distanceKm / MAX_RANGE_KM, 1) * maxRadiusPx;
    // bearing 0 = north = up on screen (negative Y), clockwise.
    const angleRad = ((aircraft.bearingDeg - 90) * Math.PI) / 180;
    const x = cx + r * Math.cos(angleRad);
    const y = cy + r * Math.sin(angleRad);

    ctx.fillStyle = aircraft.icao === selectedIcao ? "#ffffff" : "#50ff78";
    ctx.beginPath();
    ctx.arc(x, y, aircraft.icao === selectedIcao ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(236, 236, 236, 0.85)";
    ctx.font = "10px monospace";
    ctx.fillText(displayName(aircraft), x + 7, y - 6);
  }
}

canvas.addEventListener("click", (ev) => {
  if (!latestSnapshot) return;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const cx = w / 2;
  const cy = h / 2;
  const maxRadiusPx = Math.min(w, h) / 2 - 24;
  const clickX = ev.clientX - rect.left;
  const clickY = ev.clientY - rect.top;

  let closest = null;
  let closestDist = 16; // px hit-test radius
  for (const aircraft of latestSnapshot.aircraft) {
    if (aircraft.distanceKm === null || aircraft.bearingDeg === null) continue;
    const r = Math.min(aircraft.distanceKm / MAX_RANGE_KM, 1) * maxRadiusPx;
    const angleRad = ((aircraft.bearingDeg - 90) * Math.PI) / 180;
    const x = cx + r * Math.cos(angleRad);
    const y = cy + r * Math.sin(angleRad);
    const d = Math.hypot(clickX - x, clickY - y);
    if (d < closestDist) {
      closestDist = d;
      closest = aircraft;
    }
  }
  if (closest) openDetail(closest);
});

function openDetail(aircraft) {
  selectedIcao = aircraft.icao;
  detailBody.innerHTML = `
    <div class="apm-head">
      <div class="apm-title">${displayName(aircraft)}</div>
      <div class="apm-sub">ICAO ${aircraft.icao}</div>
    </div>
    <div class="apm-grid">
      <div class="apm-row"><span>Registration</span><span>${aircraft.registration || "—"}</span></div>
      <div class="apm-row"><span>Callsign</span><span>${aircraft.callsign || "—"}</span></div>
      <div class="apm-row"><span>Airline</span><span>${aircraft.operator || "—"}</span></div>
      <div class="apm-row"><span>Aircraft</span><span>${aircraft.manufacturer ? `${aircraft.manufacturer} ${aircraft.model || ""}`.trim() : (aircraft.model || "—")}</span></div>
      <div class="apm-row"><span>From</span><span>${aircraft.origin || "—"}</span></div>
      <div class="apm-row"><span>To</span><span>${aircraft.destination || "—"}</span></div>
      <div class="apm-row"><span>Altitude</span><span>${fmt(aircraft.altitudeFt, " ft")}</span></div>
      <div class="apm-row"><span>Speed</span><span>${fmt(aircraft.speedKt, " kt")}</span></div>
      <div class="apm-row"><span>Heading</span><span>${aircraft.headingDeg === null ? "—" : `${Math.round(aircraft.headingDeg)}°`}</span></div>
      <div class="apm-row"><span>Squawk</span><span>${aircraft.squawk || "—"}</span></div>
      <div class="apm-row"><span>Distance</span><span>${aircraft.distanceKm === null ? "sin fix GPS" : fmt(aircraft.distanceKm, " km", 1)}</span></div>
      <div class="apm-row"><span>Bearing</span><span>${aircraft.bearingDeg === null ? "—" : `${bearingCompass(aircraft.bearingDeg)} ${Math.round(aircraft.bearingDeg)}°`}</span></div>
      <div class="apm-row"><span>Last seen</span><span>${lastSeenLabel(aircraft.lastSeen)}</span></div>
    </div>
  `;
  detailModal.classList.remove("hidden");
  renderList(latestSnapshot);
  render();
}

function lastSeenLabel(ts) {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs} seg`;
  return `${Math.round(secs / 60)} min`;
}

function applySnapshot(snapshot) {
  latestSnapshot = snapshot;
  setTxt("ar-count", String(snapshot.aircraft.length));
  setTxt("ar-mpm", String(snapshot.messagesPerMinute));
  setTxt("ar-hardware", snapshot.demo ? "DEMO" : (snapshot.hardware || "—"));
  renderList(snapshot);
  render();
  updateAircraftMarkers(snapshot.aircraft);
}

// ---- Map view (MAPA/RADAR toggle) — real Leaflet tiles, Akbal + every
// aircraft plotted by its actual lat/lon (the zone they're flying over),
// same OSM basemap and divIcon-marker approach as gps.js. Unlike the
// circular radar, this needs no GPS fix on Akbal's side to place aircraft —
// only Akbal's own marker does.
const GPS_POLL_MS = 2000;
const WORLD_VIEW = { lat: 20, lon: 0, zoom: 2 };
const FIX_ZOOM = 10; // wider than gps.js's own 15 — aircraft can be tens of km out

let map = null;
let ownMarker = null;
let firstFixSeen = false;
const aircraftMarkers = new Map(); // icao -> L.Marker
let view = "map"; // "map" | "radar"

function initMap() {
  const el = document.getElementById("ar-map");
  const errEl = document.getElementById("ar-map-error");
  if (!el || typeof L === "undefined") {
    if (errEl) {
      errEl.textContent = "No se pudo cargar el motor de mapas (vendor/leaflet) — revisá el deploy.";
      errEl.classList.remove("hidden");
    }
    return;
  }
  map = L.map(el, {
    center: [WORLD_VIEW.lat, WORLD_VIEW.lon],
    zoom: WORLD_VIEW.zoom,
    zoomControl: true,
    attributionControl: true,
    worldCopyJump: true,
  });
  const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    subdomains: "abc",
    maxZoom: 19,
    crossOrigin: true,
  });
  tiles.addTo(map);
  tiles.on("tileerror", () => {
    if (errEl && errEl.classList.contains("hidden")) {
      errEl.textContent = "Los tiles del mapa (OpenStreetMap) no cargan — sin salida a internet desde la Pi.";
      errEl.classList.remove("hidden");
      clearTimeout(tiles._akbalErrTimer);
      tiles._akbalErrTimer = setTimeout(() => errEl.classList.add("hidden"), 8000);
    }
  });
  map.on("move zoom", () => updateThreePositions());
  initThree();
}

// ---- 3D aircraft layer (Three.js) — a small plane mesh per aircraft,
// floating above its ground point at a height proportional to altitude,
// with a drop line + ground ring so the altitude actually reads visually.
// Ground X/Z come straight from Leaflet's own container-pixel projection
// of each aircraft's lat/lon (map.latLngToContainerPoint), recomputed on
// every pan/zoom — so the 3D layer always lines up with the 2D map
// underneath instead of keeping its own separate camera/projection math.
const GROUND_SCALE = 0.35; // pixel offset -> Three.js world units
const ALT_SCALE = 300; // altitudeFt -> world units of height (a 35,000ft airliner sits ~117 units up)
let three = null; // { renderer, scene, camera, planes: Map<icao, {group,cone,line,ring}> }

function planeColor(aircraft) {
  return aircraft.approaching === true ? 0x50ff78 : aircraft.approaching === false ? 0xff6b6b : 0xffd166;
}

function makePlaneGroup(color) {
  const group = new THREE.Group();

  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(7, 22, 3),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, flatShading: true }),
  );
  cone.rotation.x = -Math.PI / 2; // apex now points toward -Z ("north")
  group.add(cone);

  const lineGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0)]);
  const line = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }));
  group.add(line);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(5, 8, 16),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  return { group, cone, line, ring };
}

function initThree() {
  const canvas = document.getElementById("ar-3d");
  if (!canvas || !map) return;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(200, 400, 200);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
  three = { renderer, scene, camera, planes: new Map() };
  resizeThree();
  requestAnimationFrame(animateThree);
}

function resizeThree() {
  if (!three) return;
  const el = document.getElementById("ar-map");
  const rect = el.getBoundingClientRect();
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  three.renderer.setSize(w, h, false);
  three.camera.aspect = w / h;
  // Fixed tilted-down view over the scene center — the "3D radar tower"
  // look. Objects' ground X/Z (from Leaflet pixels) stay centered around
  // the viewport middle regardless of pan/zoom, so this camera never needs
  // to move to track the map. Pulled back/up and aimed above ground level
  // so a high-altitude airliner (which can sit ~150 world units up) stays
  // in frame alongside low ones near the ground plane.
  three.camera.position.set(0, 420, 480);
  three.camera.lookAt(0, 60, 0);
  three.camera.updateProjectionMatrix();
  updateThreePositions();
}
window.addEventListener("resize", () => resizeThree());

function animateThree(t) {
  requestAnimationFrame(animateThree);
  if (!three || view !== "map") return;
  // Gentle bob so the 3D layer reads as alive even between snapshot ticks.
  for (const { group } of three.planes.values()) {
    group.position.y += Math.sin((t || 0) / 600 + group.position.x) * 0.02;
  }
  three.renderer.render(three.scene, three.camera);
}

// Recomputes every plane's ground X/Z from the map's current pan/zoom —
// called on Leaflet 'move'/'zoom' and whenever aircraft data updates.
function updateThreePositions() {
  if (!three || !map) return;
  const rect = document.getElementById("ar-map").getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  for (const [icao, entry] of three.planes) {
    const aircraft = latestAircraftByIcao.get(icao);
    if (!aircraft || aircraft.latitude === null) continue;
    const pt = map.latLngToContainerPoint([aircraft.latitude, aircraft.longitude]);
    const x = (pt.x - cx) * GROUND_SCALE;
    const z = (pt.y - cy) * GROUND_SCALE;
    const y = Math.max(6, (aircraft.altitudeFt || 0) / ALT_SCALE);
    entry.group.position.set(x, y, z);
    entry.group.rotation.y = -THREE.MathUtils.degToRad(aircraft.headingDeg ?? 0);
    entry.line.geometry.setFromPoints([new THREE.Vector3(0, -y, 0), new THREE.Vector3(0, 0, 0)]);
    entry.ring.position.y = -y;
  }
}

const latestAircraftByIcao = new Map();

function updateThreeAircraft(aircraftList) {
  if (!three) return;
  const seen = new Set();
  for (const aircraft of aircraftList) {
    if (aircraft.latitude === null || aircraft.longitude === null) continue;
    seen.add(aircraft.icao);
    latestAircraftByIcao.set(aircraft.icao, aircraft);
    let entry = three.planes.get(aircraft.icao);
    if (!entry) {
      entry = makePlaneGroup(planeColor(aircraft));
      three.scene.add(entry.group);
      three.planes.set(aircraft.icao, entry);
    } else {
      const color = planeColor(aircraft);
      entry.cone.material.color.setHex(color);
      entry.cone.material.emissive.setHex(color);
      entry.line.material.color.setHex(color);
      entry.ring.material.color.setHex(color);
    }
  }
  for (const [icao, entry] of three.planes) {
    if (!seen.has(icao)) {
      three.scene.remove(entry.group);
      three.planes.delete(icao);
      latestAircraftByIcao.delete(icao);
    }
  }
  updateThreePositions();
}

function updateOwnMarker(lat, lon) {
  if (!map) return;
  const pos = [lat, lon];
  if (!ownMarker) {
    const icon = L.divIcon({
      className: "ar-own-marker-wrap",
      html: '<div class="ar-own-marker"><div class="ar-own-marker-pulse"></div><div class="ar-own-marker-dot"></div></div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    ownMarker = L.marker(pos, { icon, title: "Akbal", zIndexOffset: 1000 }).addTo(map);
  } else {
    ownMarker.setLatLng(pos);
  }
  if (!firstFixSeen) {
    firstFixSeen = true;
    map.setView(pos, FIX_ZOOM);
  }
}

function clearOwnMarker() {
  firstFixSeen = false;
  if (ownMarker) {
    map.removeLayer(ownMarker);
    ownMarker = null;
  }
}

async function refreshOwnPosition() {
  try {
    const res = await fetch("/api/gps/status");
    if (!res.ok) return;
    const gps = await res.json();
    if (gps.hasFix && gps.latitude != null && gps.longitude != null) {
      updateOwnMarker(gps.latitude, gps.longitude);
    } else {
      clearOwnMarker();
    }
  } catch {
    // offline poll — keep whatever marker state we had
  }
}

// The visible plane glyph is now the Three.js 3D layer (see makePlaneGroup)
// — this marker only exists as the click hit-target under it, sized for a
// comfortable tap/click area but with no drawn icon of its own.
const PLANE_HITBOX_ICON = L.divIcon({
  className: "ar-plane-marker-wrap",
  html: '<div class="ar-plane-hitbox"></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

// Adds/updates a marker per aircraft that has a real lat/lon, and removes
// markers for aircraft that dropped out of the snapshot (out of range,
// pruned) — same "only what's currently tracked" rule as the list/radar.
function updateAircraftMarkers(aircraftList) {
  if (!map) return;
  const seen = new Set();
  for (const aircraft of aircraftList) {
    if (aircraft.latitude === null || aircraft.longitude === null) continue;
    seen.add(aircraft.icao);
    const pos = [aircraft.latitude, aircraft.longitude];
    let marker = aircraftMarkers.get(aircraft.icao);
    if (!marker) {
      marker = L.marker(pos, { icon: PLANE_HITBOX_ICON, title: displayName(aircraft) }).addTo(map);
      marker.bindTooltip(displayName(aircraft), {
        permanent: true,
        direction: "top",
        offset: [0, -8],
        className: "ar-plane-label",
      });
      marker.on("click", () => openDetail(aircraft));
      aircraftMarkers.set(aircraft.icao, marker);
    } else {
      marker.setLatLng(pos);
      marker.setTooltipContent(displayName(aircraft));
    }
  }
  for (const [icao, marker] of aircraftMarkers) {
    if (!seen.has(icao)) {
      map.removeLayer(marker);
      aircraftMarkers.delete(icao);
    }
  }
  updateThreeAircraft(aircraftList);
}

function initViewToggle() {
  const toggle = document.getElementById("ar-view-toggle");
  if (!toggle) return;
  const activate = () => setView(view === "map" ? "radar" : "map");
  toggle.addEventListener("click", activate);
  toggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  });
}

function setView(next) {
  view = next;
  const isRadar = view === "radar";
  document.getElementById("ar-map")?.classList.toggle("hidden", isRadar);
  document.getElementById("ar-radar")?.classList.toggle("hidden", !isRadar);
  document.getElementById("ar-radar-legend")?.classList.toggle("hidden", !isRadar);
  const toggle = document.getElementById("ar-view-toggle");
  toggle?.classList.toggle("on", isRadar);
  toggle?.setAttribute("aria-checked", isRadar ? "true" : "false");
  document.getElementById("ar-view-label-map")?.classList.toggle("active", !isRadar);
  document.getElementById("ar-view-label-radar")?.classList.toggle("active", isRadar);
  if (isRadar) {
    resizeCanvas();
  } else if (map) {
    // Leaflet can't measure a container that was display:none — force a
    // remeasure now that it's visible again (same fix gps.js uses).
    map.invalidateSize({ animate: false });
    resizeThree();
  }
}

initMap();
initViewToggle();
void refreshOwnPosition();
setInterval(() => void refreshOwnPosition(), GPS_POLL_MS);

// ---- live snapshot stream ----
function connectWs() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${window.location.host}/aircraft-radar/ws`);
  ws.addEventListener("message", (ev) => {
    try {
      applySnapshot(JSON.parse(ev.data));
    } catch (err) {
      console.warn("[aircraft-radar] bad snapshot", err);
    }
  });
  ws.addEventListener("close", () => setTimeout(connectWs, 2000));
  ws.addEventListener("error", () => ws.close());
}
connectWs();
resizeCanvas();
