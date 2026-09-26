// AIRCRAFT RADAR — HackRF One + dump1090 ADS-B (docs/aircraft-radar.md).
// The backend (device/web-admin-server.ts + services/adsb/*) only ever
// sends small aggregated JSON snapshots over /aircraft-radar/ws, same
// shape/cadence as WIFIRADAR's own /wifiradar/ws (see wifiradar.js).
//
// Plain 2D Leaflet markers, not Three.js/WebGL: an earlier version drew
// aircraft with a Three.js layer on top of the map, but WebGL support is
// not something to depend on for a page meant to work everywhere (some
// browsers/devices silently give a blank canvas with no visible error) —
// plain divIcon markers work universally and are simpler to keep correct.

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

// "null distance" has two very different causes an operator needs to tell
// apart: Akbal itself has no GPS fix (nothing can be placed on the radar
// right now), vs. this *specific* aircraft simply hasn't had a position
// message (SBS type 2/3) decode yet — real ADS-B reception here is sparse
// enough that an aircraft can have speed/altitude/identity resolved (from
// velocity/surveillance messages) well before its position ever does. Only
// the first case is "sin fix GPS"; conflating them made a perfectly normal
// "still waiting for a position report" look like a GPS problem.
function distanceLabel(aircraft) {
  if (aircraft.distanceKm !== null) return fmt(aircraft.distanceKm, " km", 1);
  if (!ownPosition) return "sin fix GPS de Akbal";
  if (aircraft.latitude === null) return "sin posición aún";
  return "—";
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
        <span class="${aircraft.distanceKm === null ? "" : "warn"}">${distanceLabel(aircraft)}</span>
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
  // absolute lat/lon and never needs Akbal's fix to do it. Two different
  // reasons nothing's plotted (see distanceLabel's comment above): no fix
  // on Akbal at all, vs. every currently-tracked aircraft simply hasn't had
  // a position message decoded yet even though Akbal itself has a fix.
  const showNofix = view === "radar" && withFix.length === 0 && latestSnapshot.aircraft.length > 0;
  nofixEl.classList.toggle("hidden", !showNofix);
  if (showNofix) {
    nofixEl.textContent = !ownPosition
      ? "Sin fix GPS de Akbal — mostrando lista sin radar"
      : "Ninguna aeronave detectada tiene posición todavía";
  }

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
      <div class="apm-row"><span>Distance</span><span>${distanceLabel(aircraft)}</span></div>
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

// ---- distance/bearing, recomputed client-side on every snapshot ----
// The backend only refreshes distanceKm/bearingDeg every 5s (aircraft-
// tracker.ts's GPS poll cadence) while snapshots arrive every 300ms — using
// the backend's values directly made the radar view visibly jump once
// every 5s instead of moving smoothly. Akbal's own position is already
// polled here (refreshOwnPosition, every 2s, for the map marker) and each
// aircraft's raw lat/lon arrives fresh in every snapshot, so recomputing
// locally (same haversine/bearing formulas as services/adsb/geo.ts) lets
// the radar update at full snapshot rate regardless of the backend's own
// GPS-poll timer.
const EARTH_RADIUS_KM = 6371;
function toRad(deg) {
  return (deg * Math.PI) / 180;
}
function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function initialBearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (bearing + 360) % 360;
}

let ownPosition = null; // {lat, lon} | null — from refreshOwnPosition
const lastDistanceByIcao = new Map(); // for the same "approaching" trend the backend computes

function recomputeDistances(aircraftList) {
  if (!ownPosition) return; // no fix yet — leave whatever the backend sent
  for (const aircraft of aircraftList) {
    if (aircraft.latitude === null || aircraft.longitude === null) {
      aircraft.distanceKm = null;
      aircraft.bearingDeg = null;
      aircraft.approaching = null;
      continue;
    }
    const distance = haversineDistanceKm(ownPosition.lat, ownPosition.lon, aircraft.latitude, aircraft.longitude);
    const bearing = initialBearingDeg(ownPosition.lat, ownPosition.lon, aircraft.latitude, aircraft.longitude);
    const last = lastDistanceByIcao.get(aircraft.icao);
    aircraft.approaching = last === undefined ? null : distance < last;
    aircraft.distanceKm = distance;
    aircraft.bearingDeg = bearing;
    lastDistanceByIcao.set(aircraft.icao, distance);
  }
}

function applySnapshot(snapshot) {
  recomputeDistances(snapshot.aircraft);
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
      ownPosition = { lat: gps.latitude, lon: gps.longitude };
      updateOwnMarker(gps.latitude, gps.longitude);
    } else {
      ownPosition = null;
      clearOwnMarker();
    }
  } catch {
    // offline poll — keep whatever marker state we had
  }
}

// Plain SVG triangle rotated by heading, colored by approach trend — same
// three-tier color as the list/radar/LCD (green=approaching, red=receding,
// yellow=unknown/no fix yet).
function planeIconHtml(aircraft) {
  const color = aircraft.approaching === true ? "#50ff78" : aircraft.approaching === false ? "#ff6b6b" : "#ffd166";
  const rotation = aircraft.headingDeg ?? 0;
  return `
    <div class="ar-plane-marker" style="transform: rotate(${rotation}deg)">
      <svg width="20" height="20" viewBox="0 0 24 24">
        <path d="M12 2 L19 20 L12 16 L5 20 Z" fill="${color}" stroke="#0b0d0f" stroke-width="1"/>
      </svg>
    </div>
  `;
}

function planeIcon(aircraft) {
  return L.divIcon({
    className: "ar-plane-marker-wrap",
    html: planeIconHtml(aircraft),
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

// ---- trajectory trails — one polyline per aircraft, seeded from SQLite
// history (GET /api/aircraft/history?icao=) the first time it's seen so the
// trail isn't just "born empty" on page load, then extended live as new
// positions arrive. Points are deduped (a position repeated verbatim, e.g.
// while waiting on the next real message, doesn't add a segment).
const aircraftTrails = new Map(); // icao -> L.Polyline
const aircraftTrailPoints = new Map(); // icao -> [[lat,lon], ...] chronological
const trailSeeded = new Set(); // icaos whose history fetch has already been kicked off
const MAX_TRAIL_POINTS = 80;

function trailLine(icao) {
  let line = aircraftTrails.get(icao);
  if (!line) {
    line = L.polyline([], { color: "#50ff78", weight: 2, opacity: 0.55, dashArray: "5,5" }).addTo(map);
    aircraftTrails.set(icao, line);
  }
  return line;
}

function pushTrailPoint(icao, lat, lon) {
  const points = aircraftTrailPoints.get(icao) || [];
  const last = points[points.length - 1];
  if (!last || last[0] !== lat || last[1] !== lon) {
    points.push([lat, lon]);
    if (points.length > MAX_TRAIL_POINTS) points.shift();
    aircraftTrailPoints.set(icao, points);
  }
  trailLine(icao).setLatLngs(points);
}

async function seedTrail(icao) {
  if (trailSeeded.has(icao)) return;
  trailSeeded.add(icao);
  try {
    const res = await fetch(`/api/aircraft/history?icao=${encodeURIComponent(icao)}`);
    if (!res.ok) return;
    const rows = await res.json();
    const seeded = rows
      .filter((r) => r.lat != null && r.lon != null)
      .reverse() // history.ts returns newest-first; the trail wants chronological order
      .map((r) => [r.lat, r.lon]);
    if (seeded.length === 0 || !map) return;
    // Prepend history to whatever live points already accumulated while
    // this fetch was in flight, instead of overwriting them.
    const current = aircraftTrailPoints.get(icao) || [];
    const merged = [...seeded, ...current].slice(-MAX_TRAIL_POINTS);
    aircraftTrailPoints.set(icao, merged);
    trailLine(icao).setLatLngs(merged);
  } catch {
    // offline / no history yet — trail just grows from live points instead
  }
}

function clearTrail(icao) {
  const line = aircraftTrails.get(icao);
  if (line) map.removeLayer(line);
  aircraftTrails.delete(icao);
  aircraftTrailPoints.delete(icao);
  trailSeeded.delete(icao);
}

// ---- auto-fit: zoom/pan so the map actually shows whatever's just been
// detected. Only re-fits when the *set* of positioned aircraft changes (a
// new one appears, or the last one disappears) — re-fitting on every
// snapshot tick would fight anyone manually panning/zooming while watching
// a plane move. maxZoom caps how tight it'll go for a very close aircraft.
let positionedIcaosKey = "";
function maybeAutoFit(aircraftList) {
  if (!map || !ownPosition) return;
  const positioned = aircraftList.filter((a) => a.latitude !== null && a.longitude !== null);
  const key = positioned.map((a) => a.icao).sort().join(",");
  if (key === positionedIcaosKey) return;
  positionedIcaosKey = key;
  if (positioned.length === 0) return; // nothing new to frame — keep the current view
  const bounds = L.latLngBounds([[ownPosition.lat, ownPosition.lon]]);
  for (const a of positioned) bounds.extend([a.latitude, a.longitude]);
  map.fitBounds(bounds, { padding: [70, 70], maxZoom: 14 });
}

// Adds/updates a marker per aircraft that has a real lat/lon, and removes
// markers for aircraft that dropped out of the snapshot (out of range,
// pruned) — same "only what's currently tracked" rule as the list/radar.
// setLatLng() alone would jump between positions; aircraft-radar.css adds
// a CSS transition on .leaflet-marker-icon so this glides instead, matching
// the ~1s cadence real/demo position updates actually arrive at.
function updateAircraftMarkers(aircraftList) {
  if (!map) return;
  const seen = new Set();
  for (const aircraft of aircraftList) {
    if (aircraft.latitude === null || aircraft.longitude === null) continue;
    seen.add(aircraft.icao);
    const pos = [aircraft.latitude, aircraft.longitude];
    let marker = aircraftMarkers.get(aircraft.icao);
    if (!marker) {
      marker = L.marker(pos, { icon: planeIcon(aircraft), title: displayName(aircraft) }).addTo(map);
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
      marker.setIcon(planeIcon(aircraft));
      marker.setTooltipContent(displayName(aircraft));
    }
    void seedTrail(aircraft.icao);
    pushTrailPoint(aircraft.icao, aircraft.latitude, aircraft.longitude);
  }
  for (const [icao, marker] of aircraftMarkers) {
    if (!seen.has(icao)) {
      map.removeLayer(marker);
      aircraftMarkers.delete(icao);
      clearTrail(icao);
    }
  }
  maybeAutoFit(aircraftList);
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
