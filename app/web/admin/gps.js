// GPS page (docs/gps.md): fullscreen world map (Leaflet, vendored) with the
// live position from the GPS dongle + a satellite sky plot. Polls
// /api/gps/status every 2s — the backend keeps a long-lived NMEA reader, so
// polling is cheap and reconnects survive navigation.
"use strict";

const POLL_MS = 2000;
// World view until the first fix zooms us in.
const WORLD_VIEW = { lat: 20, lon: 0, zoom: 2 };
const FIX_ZOOM = 15;

let map = null;
let marker = null;
let accuracyCircle = null;
let firstFixSeen = false;
let lastHadFix = false;
let lastSnapshot = null; // forwarded to the globe view when it's active
let view = "map"; // "map" | "globe"

initMap();
initHeader();
initViewToggle();
void refresh();
setInterval(() => void refresh(), POLL_MS);

// ---- View toggle (MAPA / GLOBO 3D) ----

function initViewToggle() {
  const toggle = document.getElementById("gps-view-toggle");
  if (!toggle) return;
  const activate = () => {
    setView(view === "map" ? "globe" : "map");
  };
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
  const isGlobe = view === "globe";
  const mapEl = document.getElementById("gps-map");
  const globeEl = document.getElementById("gps-globe");
  const hint = document.getElementById("gps-globe-hint");
  const toggle = document.getElementById("gps-view-toggle");
  toggle?.classList.toggle("on", isGlobe);
  toggle?.setAttribute("aria-checked", isGlobe ? "true" : "false");
  document.getElementById("gps-view-label-map")?.classList.toggle("active", !isGlobe);
  document.getElementById("gps-view-label-globe")?.classList.toggle("active", isGlobe);
  mapEl?.classList.toggle("hidden", isGlobe);
  globeEl?.classList.toggle("hidden", !isGlobe);
  hint?.classList.toggle("hidden", !isGlobe);
  // Sky plot stays visible in both views — it's the compact readout of the
  // same satellites the globe renders in 3D.
  if (isGlobe) {
    if (map) map.invalidateSize({ animate: false });
    window.__akbalGlobe?.setActive?.(true);
    if (lastSnapshot) forwardToGlobe(lastSnapshot);
  } else {
    window.__akbalGlobe?.setActive?.(false);
    if (map) setTimeout(() => map.invalidateSize(), 60);
  }
}

function forwardToGlobe(snapshot) {
  const lat = snapshot.hasFix ? snapshot.latitude : null;
  const lon = snapshot.hasFix ? snapshot.longitude : null;
  window.__akbalGlobe?.update?.(lat, lon, snapshot.satellites || []);
}

function initMap() {
  const el = document.getElementById("gps-map");
  if (!el || typeof L === "undefined") {
    // Leaflet failed to load — make it visible instead of a silent black map.
    const err = document.getElementById("gps-error");
    if (err) {
      err.textContent = "No se pudo cargar el motor de mapas (vendor/leaflet) — revisá el deploy.";
      err.classList.remove("hidden");
    }
    return;
  }
  map = L.map(el, {
    center: [WORLD_VIEW.lat, WORLD_VIEW.lon],
    zoom: WORLD_VIEW.zoom,
    zoomControl: true,
    attributionControl: true,
    worldCopyJump: true, // panning past ±180° keeps the marker visible
  });
  // OSM basemap: free, no API key (CARTO started serving an "API key
  // required" placeholder tile instead of real imagery — 2049 bytes every
  // time). tile.openstreetmap.org asks for a proper User-Agent, which
  // browsers already send; the header below is for the Leaflet request.
  const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    subdomains: "abc",
    maxZoom: 19,
    crossOrigin: true,
  });
  tiles.addTo(map);
  // Slow tiles (weak connectivity) shouldn't look like a broken map.
  tiles.on("tileerror", () => {
    const err = document.getElementById("gps-error");
    if (err && err.classList.contains("hidden")) {
      err.textContent = "Los tiles del mapa (OpenStreetMap) no cargan — sin salida a internet desde la Pi. La posición del HUD sigue siendo válida.";
      err.classList.remove("hidden");
      clearTimeout(tiles._akbalErrTimer);
      tiles._akbalErrTimer = setTimeout(() => err.classList.add("hidden"), 8000);
    }
  });
}

// ---- Position marker ----

function updateMarker(lat, lon, hdop) {
  if (!map) return;
  const pos = [lat, lon];
  if (!marker) {
    const icon = L.divIcon({
      className: "gps-marker-wrap",
      html: '<div class="gps-marker"><div class="gps-marker-pulse"></div><div class="gps-marker-dot"></div></div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    marker = L.marker(pos, { icon, title: "Akbal — posición GPS" }).addTo(map);
  } else {
    marker.setLatLng(pos);
  }
  // HDOP is roughly a horizontal error in meters (1 HDOP ≈ 1m under open sky).
  const accuracy = hdop ? Math.min(100, Math.max(5, hdop * 1.5)) : 15;
  if (!accuracyCircle) {
    accuracyCircle = L.circle(pos, {
      radius: accuracy,
      color: "#34d351",
      weight: 1,
      fillColor: "#34d351",
      fillOpacity: 0.12,
    }).addTo(map);
  } else {
    accuracyCircle.setLatLng(pos);
    accuracyCircle.setRadius(accuracy);
  }
  if (!firstFixSeen) {
    firstFixSeen = true;
    map.setView(pos, FIX_ZOOM);
  } else {
    map.panTo(pos, { animate: true, duration: 0.5 });
  }
}

function clearMarker() {
  firstFixSeen = false;
  if (marker) {
    map.removeLayer(marker);
    marker = null;
  }
  if (accuracyCircle) {
    map.removeLayer(accuracyCircle);
    accuracyCircle = null;
  }
  if (map) map.setView([WORLD_VIEW.lat, WORLD_VIEW.lon], WORLD_VIEW.zoom);
}

// ---- Poll /api/gps/status ----

async function refresh() {
  let data;
  try {
    const res = await fetch("/api/gps/status");
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  lastSnapshot = data;
  render(data);
  if (view === "globe") forwardToGlobe(data);
}

function fmt(n, digits = 5) {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function render(gps) {
  const errEl = document.getElementById("gps-error");
  const fixMsg = document.getElementById("gps-fix-msg");
  const hud = document.getElementById("gps-hud");
  const satPanel = document.getElementById("gps-sat-panel");
  const addressPanel = document.getElementById("gps-address-panel");

  if (!gps.present) {
    clearMarker();
    lastHadFix = false;
    hud?.classList.add("dim");
    satPanel?.classList.add("dim");
    addressPanel?.classList.add("dim");
    setGpsAddress("Sin dongle GPS conectado", true);
    if (fixMsg) fixMsg.textContent = "Sin dongle GPS conectado — enchufá el receptor USB";
    setText("gps-coords", "— , —");
    setText("gps-device", "—");
    setText("gps-alt", "—");
    setText("gps-speed", "—");
    setText("gps-heading", "—");
    setText("gps-hdop", "—");
    setText("gps-time", "—");
    setText("gps-sat-used", "0");
    setText("gps-sat-view", "0");
    setText("gps-sat-need", String(gps.satellitesNeeded || 4));
    setText("gps-sat-total", "—");
    renderSatDots([]);
    if (errEl) {
      errEl.textContent = "No hay dongle GPS conectado a la Raspberry Pi.";
      errEl.classList.remove("hidden");
    }
    return;
  }

  errEl?.classList.add("hidden");
  hud?.classList.remove("dim");
  satPanel?.classList.remove("dim");
  addressPanel?.classList.remove("dim");
  setText("gps-device", gps.device || "—");

  if (gps.hasFix && gps.latitude != null && gps.longitude != null) {
    lastHadFix = true;
    if (fixMsg) {
      fixMsg.textContent = "";
      fixMsg.classList.remove("warn");
    }
    setText("gps-coords", `${fmt(gps.latitude)}, ${fmt(gps.longitude)}`);
    setText("gps-alt", gps.altitudeM != null ? `${gps.altitudeM.toFixed(1)} m` : "—");
    setText("gps-speed", gps.speedKmh != null ? `${gps.speedKmh.toFixed(1)} km/h` : "—");
    setText("gps-heading", gps.headingDeg != null ? `${Math.round(gps.headingDeg)}°` : "—");
    setText("gps-hdop", gps.hdop != null ? gps.hdop.toFixed(1) : "—");
    setText("gps-time", gps.fixTime || "—");
    updateMarker(gps.latitude, gps.longitude, gps.hdop);
    // Reverse-geocoded address: the backend caches it per position (~40m
    // radius) and refreshes when the fix moves, so this stays current.
    if (gps.address) {
      setGpsAddress(gps.address, false);
    } else {
      setGpsAddress("Resolviendo dirección…", true);
    }
  } else {
    if (lastHadFix) clearMarker();
    lastHadFix = false;
    setText("gps-coords", "— , —");
    setText("gps-alt", "—");
    setText("gps-speed", "—");
    setText("gps-heading", "—");
    setText("gps-hdop", "—");
    setText("gps-time", "—");
    setGpsAddress("Sin fix — la dirección aparece al tener posición", true);
    if (fixMsg) {
      fixMsg.classList.add("warn");
      // The core requirement: say how many satellites we have vs need.
      fixMsg.textContent = satMessage(gps);
    }
  }

  renderSatellites(gps);
}

// ---- Address panel ----

function setGpsAddress(text, dimmed) {
  const el = document.getElementById("gps-address");
  const panel = document.getElementById("gps-address-panel");
  if (!el) return;
  if (el.textContent !== text) el.textContent = text; // avoid reflow churn
  panel?.classList.toggle("pending", Boolean(dimmed));
}

function satMessage(gps) {
  const used = gps.satellitesUsed || 0;
  const need = gps.satellitesNeeded || 4;
  const view = gps.satellitesInView || 0;
  if (view === 0) return "Buscando satélites… (0 visibles — asegurate de tener cielo despejado)";
  if (used >= need) return "Señal insuficiente — recalculando…";
  return `Fix inválido: se necesitan ${need} satélites y hay ${used} en la solución (${view} visibles). Sal a cielo despejado.`;
}

// ---- Satellite sky plot ----

function renderSatellites(gps) {
  setText("gps-sat-used", String(gps.satellitesUsed || 0));
  setText("gps-sat-view", String(gps.satellitesInView || 0));
  setText("gps-sat-need", String(gps.satellitesNeeded || 4));
  // Total tracked by the receiver = all PRNs the GSV/GSA sentences named.
  setText("gps-sat-total", String((gps.satellites || []).length));
  renderSatDots(gps.satellites || []);
}

function renderSatDots(sats) {
  const host = document.getElementById("gps-sat-dots");
  if (!host) return;
  host.innerHTML = sats
    .map((s) => {
      if (s.elevation < 0) return ""; // unknown elevation → skip on the plot
      // elevation 90° = center, 0° = outer ring.
      const r = (1 - s.elevation / 90) * 46; // % of the plot's half-size
      const angle = ((s.azimuth - 90) * Math.PI) / 180; // 0° az = up (N)
      const x = 50 + r * Math.cos(angle);
      const y = 50 + r * Math.sin(angle);
      const strength = Math.max(0, Math.min(1, s.snr / 45));
      const cls = s.used ? "sat-dot used" : s.snr > 0 ? "sat-dot" : "sat-dot idle";
      return `<div class="${cls}" style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;--sat-strength:${strengthColor(strength)}" title="${escapeHtml(s.prn)} · ${s.elevation}° el · ${s.azimuth}° az · ${s.snr} dB${s.used ? " · en fix" : ""}"></div>`;
    })
    .join("");
}

function strengthColor(strength) {
  // green → yellow by SNR
  const hue = 130 * strength;
  return `hsl(${hue.toFixed(0)}, 85%, ${45 + 10 * strength}%)`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ---- Header (same /api/status pipeline as index.html) ----

function initHeader() {
  // Copy of index.html's loadStatus, trimmed to what this page shows.
  void loadStatus();
  setInterval(() => void loadStatus(), 60000);
  // Platform LIVE/DEMO toggle (device-wide; the backend parks the dongle in
  // demo and serves a synthetic fix, so this page needs no special casing).
  const plx = document.getElementById("platform-toggle");
  plx?.addEventListener("click", async (ev) => {
    const label = ev.target.closest(".plx-toggle-label");
    if (!label) return;
    const next = label.dataset.mode;
    plx.classList.add("busy");
    try {
      const res = await fetch("/api/platform/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      if (res.ok) {
        for (const l of plx.querySelectorAll(".plx-toggle-label")) {
          l.classList.toggle("active", l.dataset.mode === next);
        }
      }
    } catch { /* keep previous */ }
    plx.classList.remove("busy");
  });
  void (async () => {
    try {
      const res = await fetch("/api/platform/mode");
      if (res.ok) {
        const mode = (await res.json()).mode || "live";
        for (const l of plx.querySelectorAll(".plx-toggle-label")) {
          l.classList.toggle("active", l.dataset.mode === mode);
        }
      }
    } catch { /* default live */ }
  })();
  const toggle = document.getElementById("sys-toggle");
  const pop = document.getElementById("sys-popover");
  toggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    pop?.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (pop && !pop.contains(e.target) && e.target !== toggle) pop?.classList.add("hidden");
  });
  const logout = document.getElementById("logout-btn");
  logout?.addEventListener("click", async () => {
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch { /* ignore */ }
    window.location.href = "/login";
  });
  const navToggle = document.getElementById("nav-toggle");
  navToggle?.addEventListener("click", () => {
    const tabs = document.getElementById("main-tabs");
    const backdrop = document.getElementById("nav-backdrop");
    const expanded = navToggle.getAttribute("aria-expanded") === "true";
    navToggle.setAttribute("aria-expanded", String(!expanded));
    tabs?.classList.toggle("open", !expanded);
    backdrop?.classList.toggle("hidden", expanded);
  });
}

async function loadStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return;
    const data = await res.json();
    const wifiLabel = data.wifi?.connected ? data.wifi.ssid : "sin wifi";
    const pill = document.getElementById("status-pill");
    if (pill) pill.textContent = `${data.model} · ${wifiLabel}`;
    setText("hdr-model", data.model || "—");
    setText("hdr-model-full", data.model || "—");
    setText("hdr-wifi", wifiLabel);
    document.getElementById("hdr-online-dot")?.classList.add("online");
    const battery = data.battery;
    const pct = document.getElementById("battery-pct");
    const icon = document.getElementById("battery-icon");
    if (pct && icon) {
      if (!battery || !battery.connected || battery.level == null) {
        pct.textContent = "N/A";
        icon.textContent = "🔋";
      } else {
        pct.textContent = `${battery.level}%`;
        icon.textContent = battery.charging ? "⚡" : "🔋";
      }
    }
    const sys = data.system;
    setText("stat-cpu", sys ? `${sys.cpuPercent}%` : "—");
    setText("stat-ram", sys ? `${Math.round(sys.ram.percent)}%` : "—");
    setText("stat-disk", sys ? `${Math.round(sys.disk.percent)}%` : "—");
  } catch {
    setText("hdr-model", "sin conexión");
  }
}