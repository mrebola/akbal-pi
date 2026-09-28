// Wardrive page (driving capture — docs/wardrive.md): fullscreen Leaflet map
// (same vendored engine + dark tiles as gps.js) with the live GPS track,
// handshake dots, an opportunistic-deauth toggle gated by speed, and a
// right panel for live networks + past sessions. Polls /api/wardrive/drive/status
// every 1s — the backend aggregates everything, polling stays cheap.
"use strict";

const POLL_MS = 1000;
const WORLD_VIEW = { lat: 20, lon: 0, zoom: 2 };
const FIX_ZOOM = 16;
const MAX_TRACK_POINTS = 1500; // live polyline cap (DB keeps everything)

let map = null;
let posMarker = null;
let trackLine = null;
let hsLayer = null; // handshake capture dots (all sessions, "mapa general")
let trackPoints = []; // [[lat, lon], ...] live session only
let firstFixSeen = false;
let followCar = true;
let lastStatus = null;

const el = (id) => document.getElementById(id);
const setText = (id, text) => {
  const n = el(id);
  if (n && n.textContent !== text) n.textContent = text; // skip reflow churn
};
const fmt = (n, d = 5) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");

initMap();
initHeader();
initPanel();
initControls();
void refresh();
setInterval(() => void refresh(), POLL_MS);

// ---- Map ----

function initMap() {
  const container = el("wd-map");
  if (!container || typeof L === "undefined") {
    showError("No se pudo cargar el motor de mapas (vendor/leaflet) — revisá el deploy.");
    return;
  }
  map = L.map(container, {
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
    showError("Los tiles (OpenStreetMap) no cargan — sin salida a internet. El HUD sigue siendo válido.");
    clearTimeout(tiles._akbalErrTimer);
    tiles._akbalErrTimer = setTimeout(hideError, 8000);
  });
  // Handshake dots sit on their own layer (global "todas las capturas" view).
  hsLayer = L.layerGroup().addTo(map);
  // Stop following when the user pans; a control button re-centers.
  map.on("dragstart", () => {
    followCar = false;
  });
  map.on("zoomend", () => {
    if (followCar && posMarker) map.panTo(posMarker.getLatLng(), { animate: true });
  });
}

function showError(text) {
  const banner = el("wd-error-banner");
  if (!banner) return;
  banner.textContent = text;
  banner.classList.remove("hidden");
}

function hideError() {
  el("wd-error-banner")?.classList.add("hidden");
}

// ---- Status polling ----

async function refresh() {
  let data;
  try {
    const res = await fetch("/api/wardrive/drive/status");
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  lastStatus = data;
  render(data);
  renderApList(data);
}

function render(st) {
  // Start/stop button
  const btn = el("wd-toggle");
  btn.textContent = st.running ? "■ DETENER" : "▶ INICIAR";
  btn.classList.toggle("on", st.running);

  // Deauth toggle (server state wins — it gates by speed too)
  const deauth = el("wd-deauth");
  if (deauth.checked !== Boolean(st.opportunisticDeauth)) deauth.checked = Boolean(st.opportunisticDeauth);
  const gate = el("wd-speed-gate");
  if (st.gps?.speedKmh != null) {
    const slow = st.gps.speedKmh <= 25;
    gate.textContent = slow ? "✓ lento" : `🔒 ${Math.round(st.gps.speedKmh)} km/h`;
  }

  // HUD counters
  const s = st.stats || {};
  setText("wd-time", st.session ? fmtDuration(st.session.durationSec) : "—");
  setText("wd-dist", st.session ? fmtDistance(st.session.distanceMeters) : "—");
  setText("wd-aps", String(s.aps ?? "—"));
  setText("wd-new", String(s.newThisSession ?? "—"));
  setText("wd-unique", String(s.unique ?? "—"));
  setText("wd-hs", `${s.handshakes ?? 0} (+${s.newHandshakes ?? 0})`);
  setText("wd-ch", st.channel ? `CH ${st.channel}` : "—");
  setText("wd-iface", st.iface ? st.iface.toUpperCase() : st.running ? "DEMO" : "—");

  // Error line (dongle missing, capture interrupted…)
  const errEl = el("wd-error");
  if (st.error) {
    errEl.textContent = st.error;
    errEl.classList.remove("hidden");
  } else {
    errEl.classList.add("hidden");
  }

  // GPS panel
  const gps = st.gps || {};
  setText("wd-coords", gps.hasFix ? `${fmt(gps.latitude)}, ${fmt(gps.longitude)}` : "— , —");
  setText("wd-speed", gps.speedKmh != null ? `${gps.speedKmh.toFixed(1)} km/h` : "—");
  setText("wd-heading", gps.headingDeg != null ? `${Math.round(gps.headingDeg)}°` : "—");
  setText("wd-sats", `${gps.satellitesUsed ?? 0}/${gps.satellitesInView ?? 0}`);
  setText("wd-hdop", gps.hdop != null ? gps.hdop.toFixed(1) : "—");
  const fix = el("wd-fix-msg");
  if (gps.hasFix) {
    fix.textContent = "";
    fix.classList.remove("warn");
  } else {
    fix.classList.add("warn");
    fix.textContent = gps.error || "Buscando satélites…";
  }

  // Map
  if (gps.hasFix && gps.latitude != null && gps.longitude != null) {
    updateCar(gps.latitude, gps.longitude);
    if (st.session && !trackLine) loadLiveTrack(st.session.id);
  }
  // Handshake dots refresh rarely; poll piggybacks cheaply
  if (!render.dotsAt || Date.now() - render.dotsAt > 10000) {
    render.dotsAt = Date.now();
    void refreshHandshakeDots();
  }
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s2 = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s2).padStart(2, "0")}`
    : `${m}:${String(s2).padStart(2, "0")}`;
}

function fmtDistance(m) {
  if (m == null) return "—";
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${m} m`;
}

// ---- Car position + live track ----

function updateCar(lat, lon) {
  if (!map) return;
  const pos = [lat, lon];
  if (!posMarker) {
    const icon = L.divIcon({
      className: "wd-pos-wrap",
      html: '<div class="wd-pos"><div class="wd-pos-pulse"></div><div class="wd-pos-dot"></div></div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    posMarker = L.marker(pos, { icon, title: "Akbal — posición" }).addTo(map);
  } else {
    posMarker.setLatLng(pos);
  }
  if (!firstFixSeen) {
    firstFixSeen = true;
    map.setView(pos, FIX_ZOOM);
  } else if (followCar) {
    map.panTo(pos, { animate: true, duration: 0.5 });
  }
}

async function loadLiveTrack(sessionId) {
  try {
    const res = await fetch(`/api/wardrive/drive/track?id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return;
    const data = await res.json();
    trackPoints = (data.points || []).map((p) => [p.lat, p.lon]);
    drawLiveTrack();
  } catch { /* next poll retries */ }
}

function drawLiveTrack() {
  if (!map) return;
  if (trackLine) trackLine.setLatLngs(trackPoints);
  else {
    trackLine = L.polyline(trackPoints, {
      color: "#34d351",
      weight: 4,
      opacity: 0.85,
      className: "wd-track-line",
    }).addTo(map);
  }
}

// ---- Handshake dots (global map view) ----

// All-time capture positions: one dot per handshake SSID (from the sessions
// endpoint, which carries lat/lon per capture). Cheap: a handful of rows.
async function refreshHandshakeDots() {
  if (!map || !hsLayer) return;
  try {
    const res = await fetch("/api/wardrive/drive/sessions");
    if (!res.ok) return;
    const data = await res.json();
    const sessions = data.sessions || [];
    let dots = 0;
    hsLayer.clearLayers();
    for (const s of sessions) {
      // Track the newest sessions' captures only (the DB query would be
      // nicer, but sessions carry handshakes count — dots come per session).
      if (!s.handshakes) continue;
      const res2 = await fetch(`/api/wardrive/drive/session-networks?id=${encodeURIComponent(s.id)}`);
      if (!res2.ok) continue;
      const nets = (await res2.json()).networks || [];
      for (const n of nets) {
        if (!n.handshake || n.lat == null || n.lon == null) continue;
        L.marker([n.lat, n.lon], {
          icon: L.divIcon({
            className: "",
            html: '<div class="wd-hs-dot" style="width:10px;height:10px;"></div>',
            iconSize: [10, 10],
            iconAnchor: [5, 5],
          }),
          title: `✋ ${n.ssid} — ${s.id}`,
        }).addTo(hsLayer);
        dots += 1;
        if (dots > 400) return; // sane cap for the browser
      }
    }
  } catch { /* map dots are decorative */ }
}

// ---- Right panel ----

function initPanel() {
  for (const tab of document.querySelectorAll(".wd-panel-tab")) {
    tab.addEventListener("click", () => {
      for (const t of document.querySelectorAll(".wd-panel-tab")) t.classList.toggle("active", t === tab);
      const pane = tab.dataset.panetab;
      el("wd-pane-live").classList.toggle("active", pane === "live");
      el("wd-pane-sessions").classList.toggle("active", pane === "sessions");
      if (pane === "sessions") void refreshSessions();
    });
  }
  el("wd-panel-collapse")?.addEventListener("click", () => {
    const panel = el("wd-panel");
    panel.classList.toggle("collapsed");
    el("wd-panel-collapse").textContent = panel.classList.contains("collapsed") ? "▴" : "▾";
    if (map) setTimeout(() => map.invalidateSize(), 60);
  });
  void refreshSessions();
}

function renderApList(st) {
  const list = el("wd-ap-list");
  if (!list || !st) return;
  const recent = st.recent || [];
  const chips = el("wd-live-stats");
  setText("wd-count-total", String(st.stats?.aps ?? recent.length));
  setText("wd-count-hs", String(st.stats?.newHandshakes ?? 0));
  const deauthChip = el("wd-chip-deauth");
  if (deauthChip) {
    const attacking = (recent || []).some((ap) => ap.status === "attacking");
    deauthChip.textContent = attacking ? "DEAUTH activo" : st.opportunisticDeauth ? "DEAUTH armado" : "DEAUTH off";
  }
  list.innerHTML = recent
    .map((ap) => {
      const badge = ap.handshakeHere
        ? '<span class="wd-map-badge hs">✋ HS</span>'
        : ap.handshakeKnown
          ? '<span class="wd-map-badge hs" title="cubierto por otro AP del mismo SSID">✓ HS</span>'
          : ap.status === "attacking" || ap.status === "attack-scheduled"
            ? '<span class="wd-map-badge attack">⚡</span>'
            : ap.status === "exhausted"
              ? '<span class="wd-map-badge fail" title="agotó intentos">✕</span>'
              : ap.security === "OPEN"
                ? '<span class="wd-map-badge open">OPEN</span>'
                : "";
      return `<li class="wd-ap-row" data-bssid="${escapeHtml(ap.bssid)}">
        <div>
          <div class="wd-ap-ssid" title="${escapeHtml(ap.ssid)}">${escapeHtml(ap.ssid)}</div>
          <div class="wd-ap-meta"><span>CH ${ap.channel}</span><span>${escapeHtml(ap.security)}</span></div>
        </div>
        <div class="wd-ap-right">
          ${badge}
          <span class="wd-rssi ${rssiClass(ap.rssi)}">${ap.rssi} dBm</span>
        </div>
      </li>`;
    })
    .join("");
  if (recent.length === 0) {
    list.innerHTML = '<li class="muted" style="padding:8px;">Sin redes en el aire — iniciá la sesión.</li>';
  }
  for (const row of list.querySelectorAll(".wd-ap-row")) {
    row.addEventListener("click", () => {
      const ap = recent.find((a) => a.bssid === row.dataset.bssid);
      if (ap) showApModal(ap);
    });
  }
}

function rssiClass(rssi) {
  if (rssi >= -55) return "strong";
  if (rssi >= -75) return "mid";
  return "weak";
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

function showApModal(ap) {
  setText("wd-apm-title", ap.ssid || "(oculta)");
  setText("wd-apm-bssid", ap.bssid);
  setText("wd-apm-vendor", ap.vendor || "—");
  setText("wd-apm-security", ap.security);
  setText("wd-apm-channel", `CH ${ap.channel}`);
  setText("wd-apm-rssi", `${ap.rssi} dBm (mejor ${ap.bestRssi})`);
  setText("wd-apm-packets", String(ap.packets ?? 0));
  setText(
    "wd-apm-hs",
    ap.handshakeHere ? "✋ Capturado en esta sesión" : ap.handshakeKnown ? "✓ Ya cubierto (otro AP del SSID)" : "Sin handshake aún",
  );
  setText("wd-apm-attempts", `${ap.attempts ?? 0} rounds`);
  el("wd-ap-modal").classList.remove("hidden");
}

// ---- Sessions ----

async function refreshSessions() {
  const list = el("wd-session-list");
  if (!list) return;
  try {
    const res = await fetch("/api/wardrive/drive/sessions");
    if (!res.ok) return;
    const data = await res.json();
    const sessions = data.sessions || [];
    if (sessions.length === 0) {
      list.innerHTML = '<li class="muted" style="padding:8px;">Sin sesiones todavía — la primera se guarda al INICIAR.</li>';
      return;
    }
    list.innerHTML = sessions
      .map((s) => {
        const date = new Date(s.started_at).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
        return `<li class="wd-map-session-row" data-id="${escapeHtml(s.id)}">
          <div class="wd-map-session-id">${escapeHtml(s.id.replace("drive-", ""))}</div>
          <div class="wd-map-session-meta">${fmtDistance(s.distance_m)} · ${s.networks} redes · ${s.handshakes} ✋ · ${s.points} pts</div>
          <div class="wd-map-session-meta">${escapeHtml(date)}</div>
        </li>`;
      })
      .join("");
    for (const row of list.querySelectorAll(".wd-session-row")) {
      row.addEventListener("click", () => openSession(row.dataset.id));
    }
  } catch {
    list.innerHTML = '<li class="muted" style="padding:8px;">Error cargando sesiones.</li>';
  }
}

async function openSession(id) {
  const drawer = el("wd-session-drawer");
  if (!drawer) return;
  drawer.classList.remove("hidden");
  setText("wd-drawer-title", id);
  el("wd-exp-csv").href = `/api/wardrive/drive/export/csv?id=${encodeURIComponent(id)}`;
  el("wd-exp-gpx").href = `/api/wardrive/drive/export/gpx?id=${encodeURIComponent(id)}`;
  // Track on the map (replaces the live line)
  try {
    const res = await fetch(`/api/wardrive/drive/track?id=${encodeURIComponent(id)}`);
    if (res.ok) {
      const pts = ((await res.json()).points || []).map((p) => [p.lat, p.lon]);
      if (trackLine) trackLine.remove();
      trackLine = null;
      trackPoints = pts;
      drawLiveTrack();
      if (pts.length > 0) {
        map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
      }
    }
  } catch { /* ignore */ }
  // Networks table
  try {
    const res = await fetch(`/api/wardrive/drive/session-networks?id=${encodeURIComponent(id)}`);
    const nets = res.ok ? (await res.json()).networks || [] : [];
    const summary = el("wd-drawer-summary");
    const hs = nets.filter((n) => n.handshake).length;
    summary.textContent = `${nets.length} redes · ${hs} con handshake · distancia ${fmtDistance(lastSessionDistance(id))}`;
    const body = el("wd-net-body");
    body.innerHTML = nets.length
      ? nets
          .map((n) => {
            const hsBadge = n.handshake
              ? n.cracked
                ? `✋🏴 ${escapeHtml(n.password || "")}`
                : "✋ capturado"
              : n.security === "OPEN"
                ? "— (abierta)"
                : "sin handshake";
            return `<tr class="${n.handshake ? "hs" : ""}">
              <td title="${escapeHtml(n.ssid)}">${escapeHtml(n.ssid)}</td>
              <td>${escapeHtml(n.security)}</td>
              <td>${hsBadge}</td>
              <td><button class="wd-vista-btn" data-lat="${n.lat ?? ""}" data-lon="${n.lon ?? ""}">Ver</button></td>
            </tr>`;
          })
          .join("")
      : '<tr><td colspan="4" class="muted">Sin redes registradas en esta sesión.</td></tr>';
    for (const btn of body.querySelectorAll(".wd-vista-btn")) {
      btn.addEventListener("click", () => {
        const lat = parseFloat(btn.dataset.lat);
        const lon = parseFloat(btn.dataset.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon) && map) {
          map.setView([lat, lon], 17);
          drawer.classList.add("hidden");
        }
      });
    }
  } catch {
    el("wd-net-body").innerHTML = '<tr><td colspan="4" class="muted">Error cargando redes.</td></tr>';
  }
}

function lastSessionDistance(id) {
  const list = el("wd-session-list");
  if (!list) return null;
  const row = [...list.querySelectorAll(".wd-session-row")].find((r) => r.dataset.id === id);
  return row ? row.textContent : null;
}

el("wd-drawer-close")?.addEventListener("click", () => {
  el("wd-session-drawer").classList.add("hidden");
  // Back to the live session view
  trackPoints = [];
  if (trackLine) trackLine.remove();
  trackLine = null;
  if (lastStatus?.session) void loadLiveTrack(lastStatus.session.id);
});

// ---- Controls ----

function initControls() {
  el("wd-toggle")?.addEventListener("click", async () => {
    const btn = el("wd-toggle");
    btn.disabled = true;
    const running = btn.classList.contains("on");
    const path = running ? "/api/wardrive/drive/stop" : "/api/wardrive/drive/start";
    try {
      const res = await fetch(path, { method: "POST" });
      const data = await res.json();
      if (!data.ok && data.error) showError(data.error);
      // Reset the live view when stopping
      if (running) {
        trackPoints = [];
        if (trackLine) trackLine.remove();
        trackLine = null;
        firstFixSeen = false;
      }
    } catch {
      showError("No se pudo cambiar el modo wardrive");
    }
    btn.disabled = false;
    void refresh();
  });

  el("wd-deauth")?.addEventListener("change", async (ev) => {
    const on = ev.target.checked;
    try {
      await fetch("/api/wardrive/drive/deauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on }),
      });
    } catch { /* next poll corrects */ }
  });

  const apModal = el("wd-ap-modal");
  el("wd-ap-modal-close")?.addEventListener("click", () => apModal.classList.add("hidden"));
  el("wd-ap-modal-backdrop")?.addEventListener("click", () => apModal.classList.add("hidden"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      apModal?.classList.add("hidden");
      el("wd-session-drawer")?.classList.add("hidden");
    }
  });
}

// ---- Header (same /api/status pipeline as gps.js) ----

function initHeader() {
  void loadStatus();
  setInterval(() => void loadStatus(), 60000);
  const plx = el("platform-toggle");
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
  const toggle = el("sys-toggle");
  const pop = el("sys-popover");
  toggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    pop?.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (pop && !pop.contains(e.target) && e.target !== toggle) pop?.classList.add("hidden");
  });
  el("logout-btn")?.addEventListener("click", async () => {
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch { /* ignore */ }
    window.location.href = "/login";
  });
  el("nav-toggle")?.addEventListener("click", () => {
    const tabs = el("main-tabs");
    const backdrop = el("nav-backdrop");
    const expanded = el("nav-toggle").getAttribute("aria-expanded") === "true";
    el("nav-toggle").setAttribute("aria-expanded", String(!expanded));
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
    const pill = el("status-pill");
    if (pill) pill.textContent = `${data.model} · ${wifiLabel}`;
    setText("hdr-model", data.model || "—");
    setText("hdr-model-full", data.model || "—");
    setText("hdr-wifi", wifiLabel);
    el("hdr-online-dot")?.classList.add("online");
    const battery = data.battery;
    const pct = el("battery-pct");
    const icon = el("battery-icon");
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