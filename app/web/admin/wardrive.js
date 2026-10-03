// Wardrive page (driving capture — docs/wardrive.md): fullscreen Leaflet map
// (same vendored engine + dark tiles as gps.js) with the live GPS track,
// handshake dots, an opportunistic-deauth toggle gated by speed, and a
// right panel for live networks + past sessions. Polls /api/wardrive/drive/status
// every 1s — the backend aggregates everything, polling stays cheap.
"use strict";

const t = (key, fallback, vars) => (window.AkbalI18n ? window.AkbalI18n.t(key, vars) : null) || fallback;

const POLL_MS = 1000;
const WORLD_VIEW = { lat: 20, lon: 0, zoom: 2 };
const FIX_ZOOM = 16;
const MAX_TRACK_POINTS = 1500; // live polyline cap (DB keeps everything)
// Used by initCollapsibleHuds(), called from the top-level init sequence
// below — must be declared before that point runs or referencing it inside
// isMobile() throws "Cannot access before initialization" (TDZ), which
// aborted the whole script and broke everything after it in the init
// sequence, including initControls()'s #wd-toggle click handler (start/stop
// stopped working entirely, not just the collapse feature).
const WD_MOBILE_BREAKPOINT = 640;

let map = null;
let posMarker = null;
let trackLayer = null; // polyline segments group (gap-aware, see drawTrack)
let hsLayer = null; // handshake capture dots (CURRENT session only, see below)
let apLayer = null; // plain AP dots with position + click-info popup
let trackPoints = []; // {lat, lon, ts} live session only
let firstFixSeen = false;
let followCar = true;

// Toggling follow-mode also reflects on the "Centrar mapa" button (lit up
// while actively following, same visual language as the start/stop button).
function wdSetFollowCar(value) {
  followCar = value;
  el("wd-recenter")?.classList.toggle("active", value);
}
let lastStatus = null;
// Track/session isolation: the map shows ONLY the live session (or one
// explicitly opened from the drawer). Loading the page cold must NOT draw
// other sessions' routes/handshakes — they live one explicit click away
// in the sessions drawer.
let dotsSessionFilter = null; // session id for the dots layer (live id)
// Live car position as a track candidate: appended on fix with the same
// distance/time gates the backend uses (this is the INSTANT trail — the
// DB polyline reload every few seconds stays the authoritative one).
let liveLastPoint = null; // {lat, lon, ts}

const el = (id) => document.getElementById(id);
const setText = (id, text) => {
  const n = el(id);
  if (n && n.textContent !== text) n.textContent = text; // skip reflow churn
};
const fmt = (n, d = 5) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");

// The overlays (HUD, right panel, activity ticker) are position:fixed and
// must start below the real header — measuring it (not a hardcoded px
// fallback) keeps the layout right on narrow screens where the topbar
// wraps taller. Same mechanism as wifiradar.js.
function updateHeaderHeight() {
  const headerEl = document.querySelector("#wd-header .topbar");
  if (headerEl) {
    document.documentElement.style.setProperty("--header-height", `${headerEl.offsetHeight}px`);
  }
}
updateHeaderHeight();
window.addEventListener("resize", () => {
  updateHeaderHeight();
  if (map) setTimeout(() => map.invalidateSize(), 60);
});
// Switching language (i18n.js) can change how the nav wraps and therefore
// the header's real height — resize alone wouldn't catch that.
document.addEventListener("akbal:locale-changed", updateHeaderHeight);

initMap();
initHeader();
initPanel();
initCollapsibleHuds();
initControls();
initDonglePicker();
void refresh();
setInterval(() => void refresh(), POLL_MS);

// ---- Map ----

function initMap() {
  const container = el("wd-map");
  if (!container || typeof L === "undefined") {
    showError(t("gps.err_map_engine", "No se pudo cargar el motor de mapas (vendor/leaflet) — revisá el deploy."));
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
    showError(t("wardrive.err_tiles", "Los tiles (OpenStreetMap) no cargan — sin salida a internet. El HUD sigue siendo válido."));
    clearTimeout(tiles._akbalErrTimer);
    tiles._akbalErrTimer = setTimeout(hideError, 8000);
  });
  // Handshake dots sit on their own layer (global "todas las capturas" view).
  hsLayer = L.layerGroup().addTo(map);
  apLayer = L.layerGroup().addTo(map);
  // Stop following when the user pans; the "Centrar mapa" button re-arms it
  // (see wdSetFollowCar / #wd-recenter in initControls).
  map.on("dragstart", () => {
    wdSetFollowCar(false);
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

  // Compact summary shown only while the HUD card is collapsed (same
  // numbers as the grid above, so collapsing it doesn't hide what's
  // actually happening right now).
  setText("wd-mini-aps", String(s.aps ?? "—"));
  setText("wd-mini-hs", String(s.handshakes ?? 0));
  setText("wd-mini-time", st.session ? fmtDuration(st.session.durationSec) : "—");

  // Activity ticker: always-visible strip at the bottom center of the map
  renderActivityTicker(st);

  // Dongle picker state: disabled while running, refreshed occasionally
  if (!render.dongleAt || Date.now() - render.dongleAt > 8000) {
    render.dongleAt = Date.now();
    void refreshDongleList();
    void syncRadioModeSelect(st);
    if (!render.compareAt || Date.now() - render.compareAt > 15000) {
      render.compareAt = Date.now();
      void refreshRadioComparison();
    }
  }
  // Live radio badge on the iface HUD item
  const ifaceEl = el("wd-iface");
  if (ifaceEl && st.dualRadio) {
    ifaceEl.textContent = `${(st.iface || "?").toUpperCase()}+${(st.attackIface || "?").toUpperCase()}`;
  } else if (ifaceEl && typeof st.iface === "string") {
    // single mode keeps the plain label (DEMO / IFCACE name)
    if (!ifaceEl.textContent.includes("+")) ifaceEl.textContent = st.running ? ifaceEl.textContent : st.iface ? st.iface.toUpperCase() : "—";
    if (st.running && !st.dualRadio) ifaceEl.textContent = `${st.iface ? st.iface.toUpperCase() : "DEMO"} · 1 radio`;
  }
  // Home-network guard badge: which SSID is protected
  const homeGuard = el("wd-home-guard");
  if (homeGuard) {
    const home = st.homeSsid;
    homeGuard.classList.toggle("hidden", !home);
    if (home) setText("wd-home-ssid", home.length > 18 ? home.slice(0, 17) + "…" : home);
  }

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
  setText("wd-hdop", gps.hdop != null ? gps.hdop.toFixed(1) : "—");
  renderSatellites(gps);
  const fix = el("wd-fix-msg");
  if (gps.hasFix) {
    fix.textContent = "";
    fix.classList.remove("warn");
  } else {
    fix.classList.add("warn");
    fix.textContent = gps.error || t("gps.hud_searching", "Buscando satélites…");
  }

  // Map
  if (gps.hasFix && gps.latitude != null && gps.longitude != null) {
    updateCar(gps.latitude, gps.longitude);
    // Heading arrow: GPS heading when moving (most devices null it while
    // parked — fallback to bearing between the last two track points).
    let heading = gps.headingDeg;
    if (heading == null && trackPoints.length >= 2) {
      const a = trackPoints[trackPoints.length - 2];
      const b = trackPoints[trackPoints.length - 1];
      const dLon = ((b.lon - a.lon) * Math.PI) / 180;
      const lat1 = (a.lat * Math.PI) / 180;
      const lat2 = (b.lat * Math.PI) / 180;
      const y = Math.sin(dLon) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      heading = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }
    updateHeadingMarker(gps.latitude, gps.longitude, heading);
    appendLivePoint(gps.latitude, gps.longitude);
    if (st.session && !trackLayer) void loadLiveTrack(st.session.id);
  }
  // Map dots (APs + handshakes across ALL sessions) refresh every ~5s —
  // the authoritative sighting positions come from session-networks.
  if (!render.dotsAt || Date.now() - render.dotsAt > 5000) {
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
    // Keep the car CENTERED while driving: panTo with high-duration
    // animation smooths the 1s poll steps into a continuous glide, and
    // setView re-centers hard when the fix jumps (tunnel/garage re-lock).
    const center = map.getCenter();
    const jumped = map.distance(center, pos) > 50; // meters — GPS re-lock
    if (jumped) {
      map.setView(pos, map.getZoom(), { animate: false });
    } else {
      map.panTo(pos, { animate: true, duration: 0.9, easeLinearity: 1 });
    }
  }
}

async function loadLiveTrack(sessionId) {
  try {
    const res = await fetch(`/api/wardrive/drive/track?id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return;
    const data = await res.json();
    const dbPoints = data.points || [];
    // DB reload is authoritative up to the last recorded point; anything
    // the live feed appended BEYOND it (frontend-only trail) is preserved.
    const liveTail = trackPoints.slice((data.count || dbPoints.length));
    trackPoints = dbPoints.concat(liveTail.filter((p) => {
      const last = dbPoints[dbPoints.length - 1];
      return !last || p.ts > last.ts;
    }));
    liveLastPoint = null; // next fix re-anchors the live append
    drawTrack();
  } catch { /* next poll retries */ }
}

// ── Gap-aware track drawing ──
// The polyline is broken where the track has no points: two consecutive
// samples separated by more than TRACK_GAP_* are NOT bridged (GPS re-lock,
// tunnel, the session sat parked for minutes). Straight bridges used to
// draw routes never driven. Gap size is TIME-first (a parked car emits
// far-apart points that were still really travelled at <20s gaps):
//   dt > 40s        → cut the line
//   distance > 150m → line break too (sample dropout at speed)
const TRACK_GAP_DT_MS = 40_000;
const TRACK_GAP_DIST_M = 150;

function trackSegments(points) {
  const segs = [];
  let cur = [];
  for (const p of points) {
    if (cur.length === 0) {
      cur.push(p);
      continue;
    }
    const prev = cur[cur.length - 1];
    const dt = p.ts - prev.ts;
    const dist = map ? map.distance([prev.lat, prev.lon], [p.lat, p.lon]) : Number.MAX_SAFE_INTEGER;
    if (dt > TRACK_GAP_DT_MS || dist > TRACK_GAP_DIST_M) {
      if (cur.length >= 2) segs.push(cur);
      cur = [p];
    } else {
      cur.push(p);
    }
  }
  if (cur.length >= 2) segs.push(cur);
  return segs;
}

// Solid neon green (same accent as the rest of the UI — LIVE indicators,
// buttons, etc.) — used to cycle a rainbow hue per point, which read as a
// confusing multicolor ribbon rather than a clear route.
const TRACK_COLOR = "#50ff78";
const TRACK_HALO_COLOR = "rgba(80, 255, 120, 0.18)";

function drawTrack() {
  if (!map) return;
  if (trackLayer) trackLayer.remove();
  trackLayer = L.layerGroup().addTo(map);
  const segs = trackSegments(trackPoints);
  for (const seg of segs) {
    const latlngs = seg.map((p) => [p.lat, p.lon]);
    L.polyline(latlngs, {
      color: TRACK_HALO_COLOR, // halo under the line — keeps it legible over dark tiles
      weight: 9,
      opacity: 0.6,
      lineCap: "round",
      lineJoin: "round",
      className: "wd-track-halo",
      interactive: false,
    }).addTo(trackLayer);
    L.polyline(latlngs, {
      color: TRACK_COLOR,
      weight: 4,
      opacity: 0.9,
      lineCap: "round",
      lineJoin: "round",
      className: "wd-track-line",
      interactive: false,
    }).addTo(trackLayer);
  }
}

// ── Heading arrow marker ──
// A rotating arrow at the car's tip: from GPS heading when present, else
// from the last two track points (course-over-ground). No heading data →
// the arrow hides (parked / warm-up).
let headingMarker = null;
let lastHeadingDeg = null;

const HEADING_ARROW_HTML =
  '<div class="wd-heading-arrow">' +
  '<div class="wd-heading-tip"></div>' +
  '<div class="wd-heading-shaft"></div>' +
  "</div>";

function updateHeadingMarker(lat, lon, headingDeg) {
  if (!map) return;
  if (headingDeg == null || Number.isNaN(headingDeg)) {
    headingMarker?.remove();
    headingMarker = null;
    lastHeadingDeg = null;
    return;
  }
  lastHeadingDeg = headingDeg;
  const pos = [lat, lon];
  if (!headingMarker) {
    const icon = L.divIcon({
      className: "wd-heading-wrap",
      html: HEADING_ARROW_HTML,
      iconSize: [46, 46],
      iconAnchor: [23, 46], // tip of the arrow sits at the car position
    });
    headingMarker = L.marker(pos, { icon, interactive: false, zIndexOffset: 400 }).addTo(map);
  } else {
    headingMarker.setLatLng(pos);
  }
  const arrowEl = headingMarker.getElement()?.querySelector(".wd-heading-arrow");
  if (arrowEl) {
    // Smooth rotation (shortest path): CSS transitions handle the glide.
    arrowEl.style.transform = `rotate(${headingDeg.toFixed(1)}deg)`;
  }
}

// Live trail: same distance/time gates the backend's track recorder uses
// (>=6m move or >=20s parked). The DB-backed polyline reload stays
// authoritative — this only makes the trail grow in realtime between
// reloads (the old UI only repainted the track every reload cycle).
const LIVE_MIN_MOVE_M = 6;
const LIVE_MAX_DT_MS = 20_000;

function appendLivePoint(lat, lon) {
  const now = Date.now();
  if (!liveLastPoint) {
    liveLastPoint = { lat, lon, ts: now };
    trackPoints.push(liveLastPoint);
    drawTrack();
    return;
  }
  const prev = liveLastPoint;
  const moved = map ? map.distance([prev.lat, prev.lon], [lat, lon]) : 0;
  const movedEnough = moved >= LIVE_MIN_MOVE_M;
  if (movedEnough || now - prev.ts >= LIVE_MAX_DT_MS) {
    // Parked (time-triggered, not a real move): pin the point to the last
    // STABLE position instead of the current GPS-noise reading — matches
    // the backend's own fix (wardrive/service.ts's recordPoint) for the
    // same bug: letting the anchor itself drift a couple of meters every
    // ~20s while stationary made pure GPS jitter read back as the car
    // circling a parked spot (each noisy anchor became the reference for
    // the next "did we move 6m" check).
    const pointLat = movedEnough ? lat : prev.lat;
    const pointLon = movedEnough ? lon : prev.lon;
    // Skip duplicates of the authoritative reload (points that both came
    // from the DB poll AND the live feed shouldn't stack twice).
    const last = trackPoints[trackPoints.length - 1];
    if (last && Math.abs(last.lat - pointLat) < 1e-6 && Math.abs(last.lon - pointLon) < 1e-6) {
      liveLastPoint = last;
      return;
    }
    liveLastPoint = { lat: pointLat, lon: pointLon, ts: now };
    trackPoints.push(liveLastPoint);
    if (trackPoints.length > MAX_TRACK_POINTS) {
      trackPoints.splice(0, trackPoints.length - MAX_TRACK_POINTS);
    }
    drawTrack();
  }
}

// ---- Map dots (session-scoped) + overlapping-picker modal ----

// The map shows ONLY the active session's networks (or the session
// explicitly opened in the drawer). Fresh page load = clean map with no
// other sessions' routes/dots; past data is one drawer-click away. The
// live list at the right (from getStatus().recent) is the live-session
// AP table; these map dots come from the session-networks endpoint.
async function refreshHandshakeDots() {
  if (!map || !hsLayer) return;
  try {
    // Which session the map is showing: the drawer-opened one, else the
    // live one, else nothing (idle state shows a clean map).
    const sessionId = dotsSessionFilter || lastStatus?.session?.id;
    if (!sessionId) {
      hsLayer.clearLayers();
      apLayer.clearLayers();
      mapDots = [];
      return;
    }
    const res = await fetch(`/api/wardrive/drive/session-networks?id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return;
    const nets = (await res.json()).networks || [];
    hsLayer.clearLayers();
    apLayer.clearLayers();
    mapDots = [];
    let dots = 0;
    for (const n of nets) {
      if (n.lat == null || n.lon == null) continue;
      const info = { ...n, sessionId };
      if (n.handshake) {
        L.marker([n.lat, n.lon], {
          icon: L.divIcon({
            className: "",
            html: '<div class="wd-hs-dot" style="width:10px;height:10px;"></div>',
            iconSize: [10, 10],
            iconAnchor: [5, 5],
          }),
          title: `🏴‍☠️ ${n.ssid}`,
        }).on("click", (ev) => {
          L.DomEvent.stopPropagation(ev);
          pickDotAt(ev.latlng ?? [n.lat, n.lon], info);
        }).addTo(hsLayer);
        mapDots.push(info);
        dots += 1;
      } else if (dots < 400) {
        const col = n.security === "OPEN" ? "#7ab7ff" : n.security === "WPA2/3" ? "#ff9500" : "#ffd166";
        const m = L.marker([n.lat, n.lon], {
          icon: L.divIcon({
            className: "",
            html: `<div class="wd-ap-dot" style="background:${col};box-shadow:0 0 6px ${col}"></div>`,
            iconSize: [7, 7],
            iconAnchor: [3.5, 3.5],
          }),
        }).on("click", (ev) => {
          L.DomEvent.stopPropagation(ev);
          pickDotAt(ev.latlng ?? [n.lat, n.lon], info);
        }).addTo(apLayer);
        mapDots.push(info);
        dots += 1;
      }
      if (dots > 400) break; // sane cap for the browser
    }
  } catch { /* map dots are decorative */ }
}

// ── Overlapping-dots picker ──
// Clicks collect every dot within PICK_RADIUS_M of the click; 1 → its
// info card directly, ≥2 → a picker modal (many SSIDs share a mast at the
// same street corner, so exact-pixel hits alone miss most of the pile).
const PICK_RADIUS_M = 40;

let mapDots = []; // every dot {lat, lon, info} the current session rendered

function pickDotAt(latlng, clicked) {
  if (!map) return;
  const point = Array.isArray(latlng) ? latlng : [latlng.lat, latlng.lng];
  const nearby = mapDots.filter((d) => map.distance([d.lat, d.lon], point) <= PICK_RADIUS_M);
  if (nearby.length <= 1) {
    showDotInfoModal(clicked || nearby[0]);
    return;
  }
  nearby.sort((a, b) => map.distance([a.lat, a.lon], point) - map.distance([b.lat, b.lon], point));
  const body = document.getElementById("wd-pick-list");
  if (!body) return;
  body.innerHTML = nearby
    .map((d, i) => `<button class="wd-pick-row" data-idx="${i}">
      ${d.handshake ? "🏴‍☠️" : "•"}
      <span class="wd-pick-ssid">${escapeHtml(d.ssid)}</span>
      <span class="wd-pick-meta mono">${escapeHtml(d.bssid || "")}</span>
    </button>`)
    .join("");
  for (const btn of body.querySelectorAll(".wd-pick-row")) {
    btn.addEventListener("click", () => {
      const d = nearby[Number(btn.dataset.idx)];
      document.getElementById("wd-pick-modal")?.classList.add("hidden");
      showDotInfoModal(d);
    });
  }
  document.getElementById("wd-pick-modal")?.classList.remove("hidden");
}

// Same AP detail card as the live list ("Red detectada"), fed from the
// session-networks row instead of the live air view.
function showDotInfoModal(n) {
  if (!n) return;
  setText("wd-apm-title", n.ssid || t("wardrive.hidden_ssid", "(oculta)"));
  setText("wd-apm-bssid", n.bssid || "—");
  setText("wd-apm-vendor", n.last_method ? t("wardrive.method_label", "método {m}", { m: n.last_method }) : "—");
  setText("wd-apm-security", n.security || "—");
  setText("wd-apm-channel", `CH ${n.channel ?? "—"}`);
  setText("wd-apm-rssi", t("wardrive.rssi_best", "{rssi} dBm (mejor señal registrada)", { rssi: n.best_rssi ?? n.rssi ?? "—" }));
  setText("wd-apm-packets", String(n.times_seen ?? "—"));
  setText(
    "wd-apm-hs",
    n.handshake
      ? n.cracked
        ? `🏴‍☠️🏴‍☠️ ${n.password || t("wardrive.cracked", "crackeada")}`
        : `🏴‍☠️ ${t("wardrive.handshake_captured", "Handshake capturado")}`
      : t("wardrive.no_handshake_yet", "Sin handshake aún"),
  );
  setText(
    "wd-apm-attempts",
    `${n.attempts ?? 0} intentos · PMKID ${n.pmkid_attempts ?? 0} · deauth ${n.deauth_attempts ?? 0}`,
  );
  document.getElementById("wd-ap-modal")?.classList.remove("hidden");
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

// ---- Collapsible HUD cards (.wd-hud, .wd-radio-compare) ----
// The floating cards used to always show in full, fighting each other and
// the map for space on a phone (user report: "se encinan mucho las cosas").
// Only .wd-activity (bottom-center "what's happening now" ticker) and the
// start/stop button always stay visible — everything else defaults to a
// compact pill on narrow screens and expands on tap, same pattern as the
// pre-existing .wd-panel-collapse. (WD_MOBILE_BREAKPOINT is declared near
// the top of the file, above the init-call sequence — see the comment
// there.)
function initCollapsibleHuds() {
  const isMobile = () => window.innerWidth <= WD_MOBILE_BREAKPOINT;

  const hud = el("wd-hud");
  const hudBtn = el("wd-hud-collapse");
  hudBtn?.addEventListener("click", () => {
    hud.classList.toggle("collapsed");
    hudBtn.textContent = hud.classList.contains("collapsed") ? "▴" : "▾";
  });

  const compare = el("wd-radio-compare");
  const compareBtn = el("wd-radio-compare-collapse");
  compareBtn?.addEventListener("click", () => {
    compare.classList.toggle("collapsed");
    compareBtn.textContent = compare.classList.contains("collapsed") ? "▸" : "▾";
  });

  // Defaults: WARDRIVE card and the networks panel start collapsed only on
  // phone-width screens (desktop/tablet had no "too cluttered" complaint —
  // leave that layout alone). The radio-compare table is secondary
  // diagnostic data either way, so it starts collapsed everywhere; it
  // already ships with the "collapsed" class in the HTML for that reason,
  // nothing to do here beyond keeping its button glyph in sync.
  if (isMobile()) {
    hud.classList.add("collapsed");
    if (hudBtn) hudBtn.textContent = "▴";
    const panel = el("wd-panel");
    panel?.classList.add("collapsed");
    const panelBtn = el("wd-panel-collapse");
    if (panelBtn) panelBtn.textContent = "▴";
  }
}

// ---- Dongle picker ----
// The wardrive adapter can be pinned; only while stopped. Default
// recommendation: ath9k_htc (AR9271) — deterministic EAPOL capture.

async function refreshDongleList() {
  const sel = el("wd-dongle-select");
  if (!sel) return;
  try {
    const res = await fetch("/api/wardrive/drive/adapters");
    if (!res.ok) return;
    const data = await res.json();
    const cur = data.preferred || "";
    sel.innerHTML =
      '<option value="">auto</option>' +
      (data.adapters || [])
        .map((a) => {
          const tag = a.driver === "ath9k_htc" ? " ← recomendado" : "";
          const label = `${a.iface} · ${a.driver || "?"}${tag}${a.monitorSupported ? "" : " (sin monitor)"}`;
          // value = MAC, not iface name: wlan* names get reassigned by the
          // kernel/udev on any USB reconnect (including one on a totally
          // different dongle), so pinning by name silently drifted onto
          // the wrong physical adapter after a replug.
          return `<option value="${escapeHtml(a.mac)}"${a.isPreferred ? " selected" : ""}>${escapeHtml(label)}</option>`;
        })
        .join("");
    // Reflect the pinned value even if the list came back without it.
    if (cur && !sel.querySelector(`option[value="${CSS.escape(cur)}"]`)) {
      const o = document.createElement("option");
      o.value = cur;
      o.textContent = `${cur} (no presente)`;
      o.selected = true;
      sel.appendChild(o);
    } else if (!cur) {
      sel.value = "";
    }
    sel.dataset.running = lastStatus?.running ? "1" : "0";
    sel.disabled = Boolean(lastStatus?.running);
  } catch { /* picker is optional */ }
}

// ---- Radio count (1 vs 2 adapters) ----
// Selector in the HUD + efficiency comparison table fed by the
// attack_rounds DB (hit rate + blind time per mode).

async function syncRadioModeSelect(st) {
  const sel = el("wd-radio-select");
  if (!sel) return;
  // Load the persisted mode once (status carries what the session
  // resolved; the select shows the REQUESTED mode).
  if (!st || !st.running) {
    try {
      const res = await fetch("/api/wardrive/drive/radio-mode");
      if (res.ok) {
        const data = await res.json();
        if (data.mode) sel.value = data.mode;
      }
    } catch { /* keep current */ }
  }
  sel.disabled = Boolean(lastStatus?.running);
}

el("wd-radio-select")?.addEventListener("change", async (ev) => {
  const sel = ev.target;
  const msg = el("wd-radio-msg");
  try {
    const res = await fetch("/api/wardrive/drive/radio-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: sel.value }),
    });
    const data = await res.json();
    if (msg) msg.textContent = data?.ok ? "" : data?.error || "No se pudo cambiar";
    if (!data?.ok) void syncRadioModeSelect(lastStatus);
  } catch {
    if (msg) msg.textContent = "Error de red";
  }
});

async function refreshRadioComparison() {
  const host = el("wd-radio-compare");
  const body = el("wd-radio-compare-body");
  if (!host || !body) return;
  try {
    const res = await fetch("/api/wardrive/drive/rounds/comparison");
    if (!res.ok) return;
    const data = await res.json();
    const rows = data.comparison || [];
    // Only worth showing once there are rounds of BOTH modes; a single
    // mode's data is just its own baseline.
    host.style.display = rows.length > 0 ? "" : "none";
    if (rows.length === 0) return;
    body.innerHTML = rows
      .map((r) => {
        // Row's total discovery-down time (single mode pays it, dual ≈ 0).
        const blindTotal = r.rounds > 0 ? r.blindMs / r.rounds : 0;
        return `<tr>
          <td>${r.mode === "dual" ? "2 radios" : "1 radio"}</td>
          <td>${r.rounds}</td>
          <td>${r.captured}</td>
          <td>${(r.hitRate * 100).toFixed(0)}%</td>
          <td title="Tiempo de discovery pausada (total y por ronda)">${blindH(r.blindMs)} · ${blindH(blindTotal)}/ronda</td>
        </tr>`;
      })
      .join("");
  } catch { /* metrics panel is optional */ }
}

function blindH(ms) {
  if (!ms) return "0";
  if (ms >= 3.6e6) return (ms / 3.6e6).toFixed(1) + " h";
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + " min";
  return (ms / 1000).toFixed(0) + "s";
}

function initDonglePicker() {
  const sel = el("wd-dongle-select");
  const msg = el("wd-dongle-msg");
  sel?.addEventListener("change", async (ev) => {
    const mac = ev.target.value || null; // the <option value>s are MACs now, not iface names
    try {
      const res = await fetch("/api/wardrive/drive/adapter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ iface: mac }),
      });
      const data = await res.json();
      if (msg) {
        msg.textContent = data.ok ? "" : data.error || "No se pudo fijar el dongle";
      }
      void refreshDongleList();
    } catch {
      if (msg) msg.textContent = "Error de red";
    }
  });
}

function renderApList(st) {
  const list = el("wd-ap-list");
  if (!list || !st) return;
  const recent = st.recent || [];
  setText("wd-count-total", String(st.stats?.aps ?? recent.length));
  setText("wd-count-hs", String(st.stats?.newHandshakes ?? 0));
  // Badge per attack state. 🏴‍☠️ = handshake captured (pirate flag — booty),
  // ⚡ = being attacked right now, 🤝 HS = covered by another AP of the SSID,
  // ✕ = attempts exhausted. ⚡ button = manual attack NOW.
  const attackingNow = Boolean(st.currentAttack);
  list.innerHTML = recent
    .map((ap) => {
      const badge = ap.handshakeHere
        ? '<span class="wd-map-badge hs">🏴‍☠️</span>'
        : ap.handshakeKnown
          ? '<span class="wd-map-badge hs" title="cubierto por otro AP del mismo SSID">🤝</span>'
          : ap.status === "attacking"
            ? '<span class="wd-map-badge attack" title="atacando ahora">⚡</span>'
            : ap.status === "attack-scheduled"
              ? '<span class="wd-map-badge scheduled" title="en cola de ataque">⏳</span>'
              : ap.status === "exhausted"
                ? `<span class="wd-map-badge fail" title="${t("wardrive.exhausted_attempts", "agotó intentos")}">✕</span>`
                : ap.security === "OPEN"
                  ? '<span class="wd-map-badge open">OPEN</span>'
                  : "";
        return `<li class="wd-ap-row ${ap.status === "attacking" ? "attacking" : ""}" data-bssid="${escapeHtml(ap.bssid)}">
        <div>
          <div class="wd-ap-ssid" title="${escapeHtml(ap.ssid)}">${escapeHtml(ap.ssid)}</div>
          <div class="wd-ap-meta"><span>CH ${ap.channel}</span><span>${escapeHtml(ap.security)}</span><span>${ap.attempts ? ap.attempts + " int." : ""}</span></div>
        </div>
        <div class="wd-ap-right">
          ${badge}
          <span class="wd-rssi ${rssiClass(ap.rssi)}">${ap.rssi} dBm</span>
          ${attackingNow ? "" : ap.handshakeHere || ap.handshakeKnown || ap.security === "OPEN" ? "" : `<button class="wd-ap-attack" title="Atacar ahora (PMKID → deauth)">⚡</button>`}
        </div>
      </li>`;
    })
    .join("");
  if (recent.length === 0) {
    list.innerHTML = '<li class="muted" style="padding:8px;">Sin redes en el aire — iniciá la sesión.</li>';
  }
  for (const row of list.querySelectorAll(".wd-ap-row")) {
    for (const btn of row.querySelectorAll(".wd-ap-attack")) {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        btn.disabled = true;
        btn.textContent = "…";
        try {
          const res = await fetch("/api/wardrive/drive/attack", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bssid: row.dataset.bssid }),
          });
          const data = await res.json();
          if (!data.ok && data.error) showError(data.error);
        } catch {
          showError("No se pudo lanzar el ataque");
        }
        void refresh();
      });
    }
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

// ---- Satellite sky plot (same design as /gps's bottom-left panel) ----

function renderSatellites(gps) {
  const sats = gps.satellites || [];
  setText("wd-sat-used", String(gps.satellitesUsed || 0));
  setText("wd-sat-view", String(gps.satellitesInView || 0));
  setText("wd-sat-need", String(gps.satellitesNeeded || 4));
  setText("wd-sat-total", String(satsTracked(sats)));
  const host = document.getElementById("wd-sat-dots");
  if (!host) return;
  host.innerHTML = sats
    .map((s) => {
      if (s.elevation < 0) return ""; // unknown elevation → skip on the plot
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

// All tracked = every PRN the GSV/GSA named; the endpoint's list IS that.
function satsTracked(sats) {
  return (sats || []).length || "—";
}

function strengthColor(strength) {
  const hue = 130 * strength;
  return `hsl(${hue.toFixed(0)}, 85%, ${45 + 10 * strength}%)`;
}

// ---- Activity ticker (floating box, bottom center of the map) ----
// Always visible: what the engine is doing right now. One line per event,
// newest first, same floating-card design as the rest of the HUD overlays.

let tickerLastTs = 0;
function renderActivityTicker(st) {
  const box = document.getElementById("wd-activity");
  if (!box) return;
  const act = st?.activity || [];
  if (box._akbalTs === act[0]?.ts) return; // nothing new, skip reflow
  box._akbalTs = act[0]?.ts || 0;
  box.classList.toggle("has-activity", act.length > 0);
  box.innerHTML = act.length
    ? act
        .slice(0, 4)
        .map(
          (a) =>
            `<div class="wd-activity-line ${escapeHtml(a.kind)}">${escapeHtml(a.text)}<span class="wd-activity-ts">${new Date(a.ts).toLocaleTimeString("es-MX")}</span></div>`,
        )
        .join("")
    : '<div class="wd-activity-line idle">Escaneando redes…</div>';
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
  setText("wd-apm-rssi", t("wardrive.rssi_best_short", "{rssi} dBm (mejor {best})", { rssi: ap.rssi, best: ap.bestRssi }));
  setText("wd-apm-packets", String(ap.packets ?? 0));
  setText(
    "wd-apm-hs",
    ap.handshakeHere
      ? `🏴‍☠️ ${t("wardrive.handshake_captured", "Handshake capturado")}`
      : ap.handshakeKnown
        ? `🤝 ${t("wardrive.covered_other_ap", "Cubierto (otro AP del SSID)")}`
        : t("wardrive.no_handshake_yet", "Sin handshake aún"),
  );
  setText(
    "wd-apm-attempts",
    `${ap.attempts ?? 0} esta sesión · PMKID ${ap.pmkidAttempts ?? 0} · deauth ${ap.deauthAttempts ?? 0} históricos`,
  );
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
          <div class="wd-map-session-meta">${fmtDistance(s.distance_m)} · ${s.networks} redes · ${s.handshakes} 🤝 · ${s.points} pts</div>
          <div class="wd-map-session-meta">${escapeHtml(date)}</div>
        </li>`;
      })
      .join("");
    for (const row of list.querySelectorAll(".wd-map-session-row")) {
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
  el("wd-exp-hist").href = `/api/wardrive/drive/export/historial`;
  // Delete button: confirm in-place, POST, then refresh the list + map.
  const delBtn = el("wd-session-delete");
  if (delBtn) {
    delBtn.onclick = async () => {
      if (!delBtn.dataset.confirm) {
        delBtn.dataset.confirm = "1";
        delBtn.textContent = "¿Borrar?";
        setTimeout(() => {
          if (delBtn.dataset.confirm) {
            delBtn.dataset.confirm = "";
            delBtn.textContent = "🗑";
          }
        }, 3000);
        return;
      }
      delBtn.dataset.confirm = "";
      delBtn.textContent = "🗑";
      try {
        const res = await fetch("/api/wardrive/drive/sessions/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        const data = await res.json();
        if (!data.ok) {
          alert(data.error || t("wardrive.delete_session_failed", "No se pudo borrar la sesión"));
          return;
        }
        drawer.classList.add("hidden");
        trackPoints = [];
        drawTrack();
        void refreshSessions();
        void refreshHandshakeDots();
      } catch {
        /* ignore */
      }
    };
  }
  // Track on the map (replaces the live line)
  try {
    const res = await fetch(`/api/wardrive/drive/track?id=${encodeURIComponent(id)}`);
    if (res.ok) {
      const pts = (await res.json()).points || [];
      // Viewing a past session takes over the track layer; the live feed
      // resumes drawing when the drawer closes (drawer-close reloads it).
      liveLastPoint = null;
      trackPoints = pts;
      drawTrack();
      if (pts.length > 0) {
        map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])), { padding: [30, 30] });
      }
    }
  } catch { /* ignore */ }
  // Networks table — full historial row per network: ssid, MAC, signal,
  // channel, encryption, handshake state, capture attempts.
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
            let hsCell = "—";
            if (n.handshake) {
              hsCell = n.cracked ? `🏴‍☠️🏴‍☠️ ${escapeHtml(n.password || "")}` : `🏴‍☠️ ${escapeHtml(n.last_method || n.hs_method || "capturado")}`;
            } else if (n.security === "OPEN") {
              hsCell = "abierta";
            } else if (n.attempts > 0) {
              // What was already tried and with which method — so the next
              // session knows what NOT to repeat.
              hsCell = `✕ PMKID ${n.pmkid_attempts || 0} · deauth ${n.deauth_attempts || 0}`;
            }
            return `<tr class="${n.handshake ? "hs" : ""}">
              <td title="${escapeHtml(n.ssid)}">${escapeHtml(n.ssid)}</td>
              <td class="mono">${escapeHtml(n.bssid || "—")}</td>
              <td>${n.channel ?? "—"}</td>
              <td class="${rssiClass(n.best_rssi ?? -100)}">${n.best_rssi ?? "—"}</td>
              <td>${escapeHtml(n.security)}</td>
              <td>${hsCell}</td>
              <td>${n.attempts || "—"}</td>
              <td><button class="wd-vista-btn" data-lat="${n.lat ?? ""}" data-lon="${n.lon ?? ""}">Ver</button></td>
            </tr>`;
          })
          .join("")
      : '<tr><td colspan="8" class="muted">Sin redes registradas en esta sesión.</td></tr>';
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
    el("wd-net-body").innerHTML = '<tr><td colspan="8" class="muted">Error cargando redes.</td></tr>';
  }
}

function lastSessionDistance(id) {
  const list = el("wd-session-list");
  if (!list) return null;
  const row = [...list.querySelectorAll(".wd-map-session-row")].find((r) => r.dataset.id === id);
  return row ? row.textContent : null;
}

el("wd-drawer-close")?.addEventListener("click", () => {
  const drawer = el("wd-session-drawer");
  drawer.classList.add("hidden");
  drawer.classList.remove("minimized", "maximized");
  // Back to the live session view — the map dots return to the live
  // session (or a clean map while idle), never the opened one.
  dotsSessionFilter = null;
  void refreshHandshakeDots();
  trackPoints = [];
  drawTrack();
  if (lastStatus?.session) void loadLiveTrack(lastStatus.session.id);
});

// ---- Drawer window states: normal / minimized (title bar only) / maximized
// (fullscreen). Clicking a minimized bar restores the normal state.

function setDrawerState(state) {
  const drawer = el("wd-session-drawer");
  if (!drawer) return;
  drawer.classList.remove("minimized", "maximized");
  if (state) drawer.classList.add(state);
  // Icons: ▁ (minimize) becomes ▲ (restore) while minimized; ⛶ becomes ▢
  // while maximized. Keep both buttons visible — each toggles back.
  const minBtn = el("wd-drawer-min");
  const maxBtn = el("wd-drawer-max");
  if (minBtn) minBtn.textContent = state === "minimized" ? "▲" : "▁";
  if (maxBtn) maxBtn.textContent = state === "maximized" ? "▢" : "⛶";
  if (map) setTimeout(() => map.invalidateSize(), 60);
}

el("wd-drawer-min")?.addEventListener("click", () => {
  const drawer = el("wd-session-drawer");
  if (!drawer) return;
  setDrawerState(drawer.classList.contains("minimized") ? "" : "minimized");
});

el("wd-drawer-max")?.addEventListener("click", () => {
  const drawer = el("wd-session-drawer");
  if (!drawer) return;
  setDrawerState(drawer.classList.contains("maximized") ? "" : "maximized");
});

// ---- Controls ----

function initControls() {
  // "Centrar mapa": re-arms follow-mode after a manual pan/zoom, and jumps
  // back to the car's current position right away (instead of waiting for
  // the next poll tick to catch up) — then keeps following as it drives,
  // same as the very first fix, until the user pans away again.
  el("wd-recenter")?.addEventListener("click", () => {
    wdSetFollowCar(true);
    if (map && posMarker) map.setView(posMarker.getLatLng(), Math.max(map.getZoom(), FIX_ZOOM), { animate: true });
  });
  wdSetFollowCar(followCar); // paint the button's initial state (follows by default)

  el("wd-toggle")?.addEventListener("click", async () => {
    const btn = el("wd-toggle");
    btn.disabled = true;
    const running = btn.classList.contains("on");
    const path = running ? "/api/wardrive/drive/stop" : "/api/wardrive/drive/start";
    try {
      const res = await fetch(path, { method: "POST" });
      const data = await res.json();
      if (!data.ok && data.error) showError(data.error);
      // Reset the live view when stopping: the map goes clean (the ended
      // session stays browsable from the sessions drawer only).
      if (running) {
        trackPoints = [];
        liveLastPoint = null;
        dotsSessionFilter = null;
        headingMarker?.remove();
        headingMarker = null;
        void refreshHandshakeDots();
        drawTrack();
        firstFixSeen = false;
        wdSetFollowCar(true); // fresh session next time starts following again
      }
    } catch {
      showError("No se pudo cambiar el modo wardrive");
    }
    btn.disabled = false;
    void refresh();
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

// ---- Header: only the LIVE/DEMO platform toggle is page-specific now —
// the hamburger/drawer, AKBAL OK panel and its /api/status poll live in
// topbar.js (shared across all 6 pages, see that file). ----

function initHeader() {
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
}