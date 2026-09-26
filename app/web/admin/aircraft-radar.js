// AIRCRAFT RADAR — HackRF One + dump1090 ADS-B (docs/aircraft-radar.md).
// The backend (device/web-admin-server.ts + services/adsb/*) only ever
// sends small aggregated JSON snapshots over /aircraft-radar/ws, same
// shape/cadence as WIFIRADAR's own /wifiradar/ws (see wifiradar.js).

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
  nofixEl.classList.toggle("hidden", withFix.length > 0 || latestSnapshot.aircraft.length === 0);

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
}

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
