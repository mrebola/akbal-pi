// Crack Station — persistent inventory of every captured handshake, from
// BOTH Wifi Audit (lab sessions, ~/wardrive-sessions/<date>/) and Wardrive
// (driving sessions, ~/wardrive-sessions/drive-*/): one place to crack them
// (dictionary rockyou + mask brute force) and to reach their files. Own
// page (docs above the wifi-audit code used to live here as a subtab) —
// it works across both capture tools, so it doesn't belong under just one
// of them. See /crack-station in web-admin-server.ts.
//
// Plain JS, no build step — same pattern as wardrive.js/gps.js (each
// standalone admin page loads i18n.js + its own script, not app.js).
"use strict";

const el = (id) => document.getElementById(id);

// ---- Shared small helpers (local copies — this page doesn't load app.js) ----

async function apiFetch(input, init) {
  const res = await fetch(input, init);
  if (res.status === 401) window.location.href = "/login";
  return res;
}

async function wdApi(path, body) {
  const res = await apiFetch(`/api/wardrive/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

function toast(message, kind = "info") {
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  const node = document.createElement("div");
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));
  setTimeout(() => {
    node.classList.remove("show");
    setTimeout(() => node.remove(), 300);
  }, 3200);
}

const wdError = el("wd-error");
function t(key, fallback) {
  return window.AkbalI18n ? AkbalI18n.t(key) : fallback;
}

// Local-locale date/time (browser's own timezone/format — not hardcoded).
function wdFormatDateTime(ms) {
  if (typeof ms !== "number") return "—";
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  } catch {
    return new Date(ms).toLocaleString();
  }
}

// ---- Header (same /api/status pipeline as wardrive.js/gps.js) ----

function initHeader() {
  void loadStatus();
  setInterval(() => void loadStatus(), 60000);
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
    const sText = (id, text) => { const n = el(id); if (n) n.textContent = text; };
    sText("stat-cpu", sys ? `${sys.cpuPercent}%` : "—");
    sText("stat-ram", sys ? `${Math.round(sys.ram.percent)}%` : "—");
    sText("stat-disk", sys ? `${Math.round(sys.disk.percent)}%` : "—");
    sText("hdr-model", data.model || "—");
    sText("hdr-model-full", data.model || "—");
    sText("hdr-wifi", data.wifi?.connected ? data.wifi.ssid : "sin wifi");
    el("hdr-online-dot")?.classList.add("online");
  } catch { /* transient — keep last-known values on screen */ }
}

initHeader();

// ---- Crack Station: persistent handshake inventory + crack controls ----
// Backend merges Wifi Audit's per-session session.json inventory with
// Wardrive's SQLite handshakes table (same ~/wardrive-sessions root, two
// capture tools) — see handshakeInventory() in wifi-audit/service.ts.

let wdCrackCache = []; // HandshakeEntry[] (wifi-audit + wardrive, merged server-side)
// Deep link from the wifi-audit celebrate modal (?bssid=...): highlight +
// scroll to that row on first render only.
let wdHighlightBssid = new URLSearchParams(window.location.search).get("bssid");

function wdOriginBadge(source) {
  const isWardrive = source === "wardrive";
  const label = isWardrive ? t("crackstation.origin_wardrive", "Wardrive") : t("crackstation.origin_wifiaudit", "Wifi Audit");
  return `<span class="wd-verify-badge none">${escapeHtml(label)}</span>`;
}

// ---- Column sort (browser-side, instant — same pattern as the Auditoría
// table in app.js: click a header to sort by it, click again to flip). ----

const wdCrackSort = { key: null, dir: "desc" };

function wdSortedCrackItems() {
  const { key, dir } = wdCrackSort;
  if (!key) return wdCrackCache;
  const mul = dir === "asc" ? 1 : -1;
  return [...wdCrackCache].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const aMissing = av === null || av === undefined || av === "";
    const bMissing = bv === null || bv === undefined || bv === "";
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1; // missing values always sort last
    if (bMissing) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * mul;
    return String(av).localeCompare(String(bv), "es", { numeric: true }) * mul;
  });
}

function wdInitCrackSort() {
  document.querySelectorAll("#wd-crack-block .wd-crack-table th[data-sort]").forEach((th) => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (wdCrackSort.key === key) {
        wdCrackSort.dir = wdCrackSort.dir === "asc" ? "desc" : "asc";
      } else {
        wdCrackSort.key = key;
        wdCrackSort.dir = "desc"; // first click: newest/strongest first
      }
      wdRenderCrackStation();
    });
  });
}

// Inventory tick: fetch + render.
async function wdTickCrackStation() {
  try {
    const res = await fetch("/api/wardrive/handshakes");
    if (!res.ok) return;
    const data = await res.json();
    wdCrackCache = data.items || [];
    wdRenderCrackStation();
    await wdRenderMaskRun();
  } catch { /* non-fatal */ }
}

function wdRenderCrackStation() {
  const body = el("wd-crack-body");
  const status = el("wd-crack-status");
  if (!body) return;
  const items = wdSortedCrackItems();
  if (status) {
    status.textContent = items.length
      ? `${items.length} handshake(s) en el inventario`
      : "Sin handshakes aún — auditá una red en Wifi Audit o salí a manejar con Wardrive";
  }
  // Sort arrows on the active column header (▲/▼), same convention as the
  // Auditoría table.
  document.querySelectorAll("#wd-crack-block .wd-crack-table th[data-sort]").forEach((th) => {
    const active = th.dataset.sort === wdCrackSort.key;
    const base = th.dataset.label || th.textContent.replace(/ [▲▼]$/, "");
    th.dataset.label = base;
    th.textContent = active ? `${base} ${wdCrackSort.dir === "asc" ? "▲" : "▼"}` : base;
  });
  if (items.length === 0) {
    body.innerHTML = '<tr><td colspan="9" class="muted">Aún no hay handshakes capturados.</td></tr>';
    return;
  }
  const capOf = (it) => (it.capFile ? `${it.sessionId}/${it.capFile}` : "");
  body.innerHTML = items
    .map((it) => {
      const capPath = capOf(it);
      const crackButtons = [];
      if (!it.password) {
        crackButtons.push(
          `<button class="wd-crack-dict" data-bssid="${it.bssid}" data-cap="${escapeHtml(capPath)}" data-session="${it.sessionId}"
             title="Ataque de diccionario (rockyou) contra este handshake">dictionary attack</button>`,
        );
        crackButtons.push(
          `<button class="wd-crack-mask" data-bssid="${it.bssid}" data-ssid="${escapeHtml(it.ssid || "")}"
             data-cap="${escapeHtml(capPath)}" title="Fuerza bruta con máscara (p.ej. @@@@+MAC)">máscara…</button>`,
        );
      }
      const gps = it.lat != null && it.lon != null
        ? `<button class="wd-gps-btn" data-lat="${it.lat}" data-lon="${it.lon}" data-ssid="${escapeHtml(it.ssid || it.bssid)}"
             title="Ver en el mapa">📍 ${it.lat.toFixed(4)}, ${it.lon.toFixed(4)}</button>`
        : "—";
      const rowClass = it.bssid === wdHighlightBssid ? "wd-crack-row-highlight" : "";
      return `<tr class="${rowClass}" data-bssid="${it.bssid}" data-ssid="${escapeHtml(it.ssid || "")}"
                  data-session="${it.sessionId}" data-cap="${escapeHtml(capPath)}">
        <td class="wd-ssid">${it.live ? '<span class="demo-badge" style="background:rgba(80,255,120,.12);color:#34d351;">EN VIVO</span> ' : ""}${escapeHtml(it.ssid || "(oculta)")}</td>
        <td style="font-family: ui-monospace, monospace; font-size: 11px;">${escapeHtml(it.bssid)}</td>
        <td>${wdOriginBadge(it.source)}</td>
        <td class="muted" style="font-size:11px; white-space:nowrap;">${escapeHtml(wdFormatDateTime(it.capturedAt))}</td>
        <td>${gps}</td>
        <td>${it.hasHandshake ? '<span class="wd-verify-badge ok">✓ .cap</span>' : "—"}</td>
        <td>${it.password ? `<span class="wd-verify-badge ok" style="max-width:180px; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(it.password)}</span>` : "—"}</td>
        <td><div class="wd-action-group">${it.password ? '<span class="muted">✓</span>' : crackButtons.join("")}</div></td>
        <td><button class="wd-crack-files-btn" data-session="${escapeHtml(it.sessionId)}">${escapeHtml(t("crackstation.files_btn", "Ver archivos"))}</button></td>
      </tr>`;
    })
    .join("");
  if (wdHighlightBssid) {
    const row = body.querySelector(`tr[data-bssid="${CSS.escape(wdHighlightBssid)}"]`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
    wdHighlightBssid = null; // only on first render after landing here
  }
}

// ---- File browser: same /api/wardrive/files endpoints the Sessions
// subtab uses (path-traversal-checked, shared ~/wardrive-sessions root —
// works for a Wifi Audit dated folder AND a Wardrive drive-* folder). Shown
// in a modal (not inline in the page flow) so it doesn't push the table
// and mask panel down every time it's opened. ----

async function wdOpenCrackFiles(sessionId) {
  const modal = el("wd-crack-files-modal");
  const filesTitle = el("wd-crack-files-title");
  const filesBody = el("wd-crack-files-body");
  if (!modal || !filesTitle || !filesBody) return;
  try {
    const res = await fetch(`/api/wardrive/files?path=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return;
    const data = await res.json();
    filesTitle.textContent = `${t("crackstation.files_title", "Archivos")} — ${sessionId}`;
    filesBody.innerHTML = (data.items || [])
      .map((it) => {
        const size = it.size > 1024 * 1024 ? `${(it.size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(it.size / 1024)} KB`;
        const dl = `/api/wardrive/files/download?path=${encodeURIComponent(it.path)}`;
        return `<tr>
          <td>${escapeHtml(it.name)}</td>
          <td>${size}</td>
          <td><button class="wd-preview-btn" data-path="${escapeHtml(it.path)}" data-name="${escapeHtml(it.name)}">${escapeHtml(t("crackstation.preview_btn", "Ver"))}</button></td>
          <td><a href="${dl}" download="${escapeHtml(it.name)}"><button class="wd-download-btn">${escapeHtml(t("crackstation.download_btn", "Bajar"))}</button></a></td>
        </tr>`;
      })
      .join("");
    modal.classList.remove("hidden");
  } catch { /* non-fatal */ }
}

el("wd-crack-files-close")?.addEventListener("click", () => {
  el("wd-crack-files-modal")?.classList.add("hidden");
});

function wdShowPreview(name, data) {
  const modal = el("wd-preview-modal");
  const title = el("wd-preview-title");
  const body = el("wd-preview-body");
  if (!modal || !title || !body) return;
  title.textContent = name;
  let html = "";
  if (data.note) html += `<div class="wd-preview-note">${escapeHtml(data.note)}</div>`;
  html += `<pre class="wd-preview-content">${escapeHtml(data.content)}</pre>`;
  body.innerHTML = html;
  modal.classList.remove("hidden");
}

el("wd-crack-files-body")?.addEventListener("click", async (ev) => {
  const btn = ev.target.closest(".wd-preview-btn");
  if (!btn) return;
  try {
    const res = await fetch(`/api/wardrive/files/preview?path=${encodeURIComponent(btn.dataset.path)}`);
    if (!res.ok) return;
    const data = await res.json();
    wdShowPreview(btn.dataset.name, data);
  } catch { /* non-fatal */ }
});

el("wd-preview-close")?.addEventListener("click", () => {
  el("wd-preview-modal")?.classList.add("hidden");
});

// ---- Capture-location map (GPS column) — Leaflet, same OSM tiles as
// gps.js/wardrive.js. Only Wardrive rows carry a coordinate (Wifi Audit is
// stationary lab capture). One map instance, re-centered per click. ----

let wdCrackMap = null;
let wdCrackMapMarker = null;

function wdOpenCrackMap(lat, lon, label) {
  const modal = el("wd-crack-map-modal");
  const title = el("wd-crack-map-title");
  const mapEl = el("wd-crack-map");
  if (!modal || !mapEl) return;
  if (title) title.textContent = label ? `${t("crackstation.map_title", "Ubicación de la captura")} — ${label}` : t("crackstation.map_title", "Ubicación de la captura");
  modal.classList.remove("hidden");
  if (typeof L === "undefined") return; // vendor/leaflet failed to load — modal still shows the title
  if (!wdCrackMap) {
    wdCrackMap = L.map(mapEl, { zoomControl: true, attributionControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      subdomains: "abc",
      maxZoom: 19,
      crossOrigin: true,
    }).addTo(wdCrackMap);
  }
  wdCrackMap.setView([lat, lon], 16);
  if (wdCrackMapMarker) {
    wdCrackMapMarker.setLatLng([lat, lon]);
  } else {
    const icon = L.divIcon({
      className: "wd-crack-map-pin",
      html: '<div style="width:16px;height:16px;border-radius:50%;background:#50ff78;border:2px solid #0b0d0f;box-shadow:0 0 0 4px rgba(80,255,120,.25);"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    wdCrackMapMarker = L.marker([lat, lon], { icon }).addTo(wdCrackMap);
  }
  // The map div is 0×0 while its modal is hidden — Leaflet needs a
  // recalculation once it's actually visible, or tiles render blank/offset.
  setTimeout(() => wdCrackMap.invalidateSize(), 60);
}

el("wd-crack-map-close")?.addEventListener("click", () => {
  el("wd-crack-map-modal")?.classList.add("hidden");
});

// Launch points: Crack Station rows (dictionary attack / mask / archivos / mapa).
el("wd-crack-body")?.addEventListener("click", async (ev) => {
  const dictBtn = ev.target.closest(".wd-crack-dict");
  if (dictBtn) {
    const res = await wdApi("dict/start", { bssid: dictBtn.dataset.bssid, cap: dictBtn.dataset.cap });
    if (res?.error) {
      if (wdError) wdError.textContent = res.error;
      return;
    }
    toast("Ataque de diccionario lanzado", "success");
    wdWatchDict();
    el("wd-dict-panel")?.scrollIntoView({ block: "start", behavior: "smooth" });
    void wdTickCrackStation();
    return;
  }
  const maskBtn = ev.target.closest(".wd-crack-mask");
  if (maskBtn) {
    wdArmMaskLaunch(maskBtn.dataset.bssid, maskBtn.dataset.ssid, maskBtn.dataset.cap);
    el("wd-mask-panel")?.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  const filesBtn = ev.target.closest(".wd-crack-files-btn");
  if (filesBtn) {
    void wdOpenCrackFiles(filesBtn.dataset.session);
    return;
  }
  const gpsBtn = ev.target.closest(".wd-gps-btn");
  if (gpsBtn) wdOpenCrackMap(parseFloat(gpsBtn.dataset.lat), parseFloat(gpsBtn.dataset.lon), gpsBtn.dataset.ssid);
});

el("wd-crack-refresh")?.addEventListener("click", () => void wdTickCrackStation());

// ---- Dictionary attack (rockyou) progress ----
// aircrack-ng itself has to run server-side (it needs the .cap bytes and
// does real crypto), so the server is the only source of truth for
// {tried, total, fps}. But updating that number requires parsing aircrack's
// live stdout on the Pi, so polling it every few hundred ms would cost CPU
// the Pi doesn't have to spare. Instead: sync the real numbers from the
// server every few seconds, then EXTRAPOLATE the percentage in the browser
// every 250ms using the last known rate (tried + fps × elapsed) — the bar
// looks smooth and responsive while almost all of that work happens here,
// not on the server.
let wdDictBssid = null;
let wdDictSync = null; // { tried, total, fps, running, result, syncedAtMs }
let wdDictPollTimer = null; // server sync, only while a crack is running
let wdDictAnimTimer = null; // local interpolation, cheap DOM update

function wdDictEstimatedTried() {
  if (!wdDictSync) return 0;
  if (!wdDictSync.running) return wdDictSync.tried;
  const elapsedSec = (performance.now() - wdDictSync.syncedAtMs) / 1000;
  const total = wdDictSync.total || Infinity;
  return Math.min(total, wdDictSync.tried + wdDictSync.fps * elapsedSec);
}

function wdRenderDictBar() {
  const box = el("wd-dict-run");
  const status = el("wd-dict-run-status");
  if (!box) return;
  if (!wdDictSync) {
    box.innerHTML = "";
    if (status) status.textContent = "";
    return;
  }
  const total = wdDictSync.total || 0;
  const tried = wdDictEstimatedTried();
  const pct = total > 0 ? Math.min(100, (tried / total) * 100) : 0;
  const ssid = wdCrackCache.find((i) => i.bssid === wdDictBssid)?.ssid || wdDictBssid || "";
  const resultMsg = wdDictSync.result
    ? wdDictSync.result.matched
      ? `<span class="wd-verify-badge ok">✓ ENCONTRADA — ${escapeHtml(wdDictSync.result.output?.match(/KEY FOUND!\s*\[\s*(.*?)\s*\]/)?.[1] || "")}</span>`
      : wdDictSync.result.verdict === "handshake_wrong_password"
        ? '<span class="wd-verify-badge wrong">Diccionario agotado — sin match</span>'
        : `<span class="wd-verify-badge err">${escapeHtml(wdDictSync.result.output || "cancelado")}</span>`
    : "";
  box.innerHTML = `
    <div class="wd-dict-head">
      <span>dictionary attack (rockyou) · <strong>${escapeHtml(ssid)}</strong></span>
      <span style="display:inline-flex; gap:6px;">
        ${wdDictSync.running ? '<button class="wd-dict-stop">Cancelar</button>' : ""}
        ${!wdDictSync.running ? '<button class="wd-dict-clear">✕</button>' : ""}
      </span>
    </div>
    <div class="wd-dict-bar"><div class="wd-dict-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
    <div class="wd-dict-meta muted">${Math.round(tried).toLocaleString()} / ${total.toLocaleString()} claves · ${(wdDictSync.fps || 0).toFixed(0)} pass/s · ${wdDictSync.running ? "corriendo..." : wdDictSync.result ? "terminado" : "cancelado"}</div>
    <div class="wd-dict-result">${resultMsg}</div>
  `;
}

async function wdSyncDictStatus() {
  try {
    const res = await fetch("/api/wardrive/dict/status");
    if (!res.ok) return;
    const data = await res.json();
    if (!data?.state) {
      wdDictSync = null;
    } else {
      wdDictBssid = data.bssid;
      wdDictSync = {
        tried: data.state.progress.tried,
        total: data.state.progress.total,
        fps: data.state.progress.fps,
        running: data.state.running,
        result: data.state.result,
        syncedAtMs: performance.now(),
      };
    }
    wdRenderDictBar();
    if (!wdDictSync?.running && wdDictPollTimer) {
      clearInterval(wdDictPollTimer);
      wdDictPollTimer = null;
    }
  } catch { /* non-fatal */ }
}

// Called on launch, and once at boot to recover an in-flight run after a
// page reload. Idempotent — safe to call repeatedly.
function wdWatchDict() {
  void wdSyncDictStatus();
  if (!wdDictPollTimer) {
    wdDictPollTimer = setInterval(() => {
      if (!document.hidden) void wdSyncDictStatus();
    }, 4000);
  }
  if (!wdDictAnimTimer) {
    wdDictAnimTimer = setInterval(() => {
      if (!document.hidden) wdRenderDictBar();
    }, 250);
  }
}

el("wd-dict-run")?.addEventListener("click", async (ev) => {
  if (ev.target.closest(".wd-dict-clear")) {
    await apiFetch("/api/wardrive/dict/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    wdDictSync = null;
    wdRenderDictBar();
    return;
  }
  if (!ev.target.closest(".wd-dict-stop")) return;
  await apiFetch("/api/wardrive/dict/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  void wdSyncDictStatus();
});

// ---- Mask brute force ----

let wdMaskArmed = null; // { bssid, ssid, cap } preselected from a row
let wdCrackTimer = null; // mask-run polling while a mask attack is running

function wdArmMaskLaunch(bssid, ssid, cap) {
  wdMaskArmed = { bssid, ssid, cap };
}

// Pattern → readable total ("38.4M claves"); same syntax as the backend
// (@ dígito, # minúscula, $ hex, resto literal).
function wdMaskTotalPreview(pattern) {
  let total = 1;
  for (const ch of pattern) {
    if (ch === "@") total *= 10;
    else if (ch === "#") total *= 26;
    else if (ch === "$") total *= 16;
  }
  return total;
}

function wdHumanKeys(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G claves`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M claves`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K claves`;
  return `${n} claves`;
}

async function wdRenderMaskPresets() {
  const wrap = el("wd-mask-presets");
  if (!wrap) return;
  let presets = [];
  try {
    const res = await fetch("/api/wardrive/mask/status");
    if (res.ok) presets = (await res.json()).presets || [];
  } catch { return; }
  wrap.innerHTML = presets
    .map((m) => {
      return `<div class="wd-mask-preset" data-id="${m.id}">
        <div class="wd-mask-preset-head">
          <strong>${escapeHtml(m.name)}</strong>
          ${m.id.startsWith("builtin-") ? '<span class="wd-verify-badge none">fábrica</span>' : '<button class="wd-mask-del" data-id="' + m.id + '" title="Borrar máscara">🗑</button>'}
        </div>
        <div class="wd-mask-preset-pattern"><code>${escapeHtml(m.pattern)}${m.autoMacSuffix ? "<em>+MAC4</em>" : ""}</code>
          <span class="muted">· ${wdHumanKeys(wdMaskTotalPreview(m.pattern + (m.autoMacSuffix ? "$$$$" : "")))}${m.autoMacSuffix ? " · +sufijo MAC" : ""}</span></div>
        <div class="wd-mask-preset-desc">${escapeHtml(m.description)}</div>
        <div class="wd-mask-actions">
          <input type="text" class="wd-mask-target-input" placeholder="BSSID del objetivo (AA:BB:…)" data-preset="${m.id}" />
          <button class="wd-mask-launch" data-id="${m.id}">Lanzar ataque</button>
        </div>
      </div>`;
    })
    .join("");
}

el("wd-mask-presets")?.addEventListener("click", async (ev) => {
  const delBtn = ev.target.closest(".wd-mask-del");
  if (delBtn) {
    await apiFetch("/api/wardrive/mask/presets/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: delBtn.dataset.id }),
    });
    void wdRenderMaskPresets();
    return;
  }
  const launchBtn = ev.target.closest(".wd-mask-launch");
  if (!launchBtn) return;
  const wrap = launchBtn.closest(".wd-mask-preset");
  const bssid = (wrap.querySelector(".wd-mask-target-input")?.value || "").trim().toUpperCase();
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(bssid)) {
    el("wd-mask-msg").textContent = "Escribe el BSSID del objetivo (formato AA:BB:CC:DD:EE:FF)";
    return;
  }
  const presetId = launchBtn.dataset.id;
  const armed = wdMaskArmed;
  wdMaskArmed = null;
  wdMaskLaunch(presetId, null, bssid, armed?.cap, armed?.autoMacSuffix);
});

el("wd-mask-save")?.addEventListener("click", async () => {
  const msg = el("wd-mask-msg");
  const name = el("wd-mask-name")?.value?.trim() || "";
  const pattern = el("wd-mask-pattern")?.value?.trim() || "";
  const description = el("wd-mask-description")?.value?.trim() || "";
  const autoMacSuffix = el("wd-mask-mac")?.checked === true;
  if (!name || !pattern) {
    msg.textContent = "Nombre y patrón requeridos";
    return;
  }
  try {
    const res = await apiFetch("/api/wardrive/mask/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, pattern, description, autoMacSuffix }),
    });
    const data = await res.json();
    msg.textContent = data?.ok ? "Máscara guardada" : data?.error || "No se pudo guardar";
    if (data?.ok) {
      el("wd-mask-name").value = "";
      el("wd-mask-pattern").value = "";
      el("wd-mask-description").value = "";
      el("wd-mask-mac").checked = false;
      void wdRenderMaskPresets();
    }
  } catch {
    msg.textContent = "Error de red";
  }
});

async function wdMaskLaunch(presetId, pattern, bssid, cap, autoMacSuffixBaked) {
  const status = el("wd-mask-run-status");
  if (status) status.textContent = "Lanzando attack de máscara...";
  try {
    const res = await apiFetch("/api/wardrive/mask/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        presetId
          ? { bssid, presetId, cap }
          : { bssid, pattern, autoMacSuffix: autoMacSuffixBaked === true, cap },
      ),
    });
    const data = await res.json();
    if (!data?.ok) {
      if (status) status.textContent = data?.error || "No se pudo lanzar";
      return;
    }
    if (status) status.textContent = "";
    // No subtab to gate on anymore — this whole page IS Crack Station;
    // just skip the tick while the browser tab is in the background.
    wdCrackTimer = wdCrackTimer || setInterval(() => {
      if (!document.hidden) void wdRenderMaskRun();
    }, 3000);
    void wdRenderMaskRun();
  } catch (err) {
    if (status) status.textContent = err.message || "Error de red";
  }
}

// Launch directly from a row's "máscara…" button → render "launch with
// custom pattern against <ssid>" panel.
async function wdRenderMaskRun() {
  const runBox = el("wd-mask-run");
  const status = el("wd-mask-run-status");
  if (!runBox) return;
  let data = null;
  try {
    const res = await fetch("/api/wardrive/mask/status");
    if (res.ok) data = await res.json();
  } catch { return; }
  // Presets list may have changed server-side; render fresh.
  void wdRenderMaskPresets();
  if (!data?.state || (!data.state.running && !data.state.done)) {
    runBox.innerHTML = "";
    if (status && wdMaskArmed) {
      status.textContent = `Objetivo preseleccionado: ${wdMaskArmed.ssid || wdMaskArmed.bssid}`;
    } else if (status) {
      status.textContent = "";
    }
    return;
  }
  const { state } = data;
  const p = state.progress;
  const pct = p.total > 0 ? Math.min(100, (p.tried / p.total) * 100) : 0;
  const ssid = state.bssid
    ? wdCrackCache.find((i) => i.bssid === state.bssid)?.ssid || state.bssid
    : "";
  const resultMsg = state.result
    ? state.result.matched
      ? `<span class="wd-verify-badge ok">✓ ENCONTRADA — ${escapeHtml(state.result.output?.match(/KEY FOUND!\s*\[\s*(.*?)\s*\]/)?.[1] || "")}</span>`
      : state.result.verdict === "handshake_wrong_password"
        ? '<span class="wd-verify-badge wrong">Máscara agotada — sin match</span>'
        : `<span class="wd-verify-badge err">${escapeHtml(state.result.output || "cancelado")}</span>`
    : "";
  runBox.innerHTML = `
    <div class="wd-dict-head">
      <span>Máscara <code>${escapeHtml(state.pattern)}</code> · <strong>${escapeHtml(ssid)}</strong></span>
      <span style="display:inline-flex; gap:6px;">
        ${state.running ? '<button class="wd-mask-stop">Cancelar</button>' : ""}
        ${!state.running ? '<button class="wd-mask-clear">✕</button>' : ""}
      </span>
    </div>
    <div class="wd-dict-bar"><div class="wd-dict-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
    <div class="wd-dict-meta muted">${p.tried.toLocaleString()} / ${p.total.toLocaleString()} claves · ${(p.fps || 0).toFixed(0)} pass/s · ${p.elapsedSec}s ${state.running ? "· corriendo..." : state.result ? "· terminado" : "· cancelado"}</div>
    <div class="wd-dict-result">${resultMsg}</div>
  `;
}

el("wd-mask-run")?.addEventListener("click", async (ev) => {
  if (ev.target.closest(".wd-mask-clear")) {
    await apiFetch("/api/wardrive/mask/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    void wdRenderMaskRun();
    return;
  }
  if (!ev.target.closest(".wd-mask-stop")) return;
  await apiFetch("/api/wardrive/mask/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  void wdRenderMaskRun();
});

// ---- Boot ----

wdInitCrackSort();
wdWatchDict(); // recovers an in-flight dictionary attack after a reload
void wdTickCrackStation();
setInterval(() => {
  if (!document.hidden) void wdTickCrackStation();
}, 5000);
