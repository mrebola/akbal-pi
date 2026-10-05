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

// Compact "09/AGO/26" for the table cell (día/MES-abreviado/año) — fixed
// Spanish format regardless of browser locale, matching the rest of the
// device's UI copy. Full date+time lives in the cell's title tooltip via
// wdFormatDateTime().
const WD_MESES_ES = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
function wdFormatDateShort(ms) {
  if (typeof ms !== "number") return "—";
  const d = new Date(ms);
  const day = String(d.getDate()).padStart(2, "0");
  const mon = WD_MESES_ES[d.getMonth()];
  const yr = String(d.getFullYear()).slice(-2);
  return `${day}/${mon}/${yr}`;
}

// The hamburger/drawer, AKBAL OK panel and its /api/status poll are owned
// by topbar.js now (shared across all 6 pages) — this page has no
// page-specific header controls of its own, so there's nothing left here.

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

// ---- Subtabs (Inventario / Administrar máscaras) — same pattern as Wifi
// Audit's Auditoría/Sesiones (app.js's wdInitSubtabs): click a button,
// toggle .active on it and on the matching .wd-subtab-panel. ----

function wdActivateSubtab(target) {
  document.querySelectorAll("#wd-crack-block .wd-subtab").forEach((t) => {
    t.classList.toggle("active", t.dataset.subtab === target);
  });
  el("wd-sub-inventory")?.classList.toggle("active", target === "inventory");
  el("wd-sub-masks")?.classList.toggle("active", target === "masks");
}

function wdInitSubtabs() {
  document.querySelectorAll("#wd-crack-block .wd-subtab").forEach((tab) => {
    tab.addEventListener("click", () => wdActivateSubtab(tab.dataset.subtab));
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
    body.innerHTML = '<tr><td colspan="10" class="muted">Aún no hay handshakes capturados.</td></tr>';
    return;
  }
  const capOf = (it) => (it.capFile ? `${it.sessionId}/${it.capFile}` : "");
  body.innerHTML = items
    .map((it) => {
      const capPath = capOf(it);
      // While THIS handshake's own dict attack is running (or just finished),
      // it gets a clear status badge in its own "Estado" column — no %, see
      // wdRowStatusHtml(). The attack buttons make way for a short status
      // note (there's nothing to click — only one dict crack runs at a time).
      const runningHere = wdDictSync?.running && wdDictBssid === it.bssid;
      // Metadata can outlive the capture (deleted from the device): nothing
      // to crack, so no attack buttons — the row says so instead.
      const noFile = it.hasFile === false;
      let actionsHtml;
      if (it.password) {
        actionsHtml = '<span class="muted">✓</span>';
      } else if (noFile) {
        actionsHtml = '<span class="muted" style="font-size:11px;">sin archivo</span>';
      } else if (runningHere) {
        actionsHtml = '<span class="muted" style="font-size:11px;">corriendo…</span>';
      } else {
        actionsHtml = [
          `<button class="wd-crack-dict" data-wordlist="rockyou" data-bssid="${it.bssid}" data-cap="${escapeHtml(capPath)}" data-session="${it.sessionId}"
             title="Ataque de diccionario contra este handshake — rockyou.txt (~14M claves)">rockyou</button>`,
          `<button class="wd-crack-dict" data-wordlist="weakpass" data-bssid="${it.bssid}" data-cap="${escapeHtml(capPath)}" data-session="${it.sessionId}"
             title="Ataque de diccionario contra este handshake — weakpass_wifi_1 (wordlist grande, streameada desde el .gz)">weakpass</button>`,
          `<button class="wd-crack-mask" data-bssid="${it.bssid}" data-ssid="${escapeHtml(it.ssid || "")}"
             data-cap="${escapeHtml(capPath)}" title="Fuerza bruta con máscara (p.ej. @@@@+MAC)">máscara…</button>`,
        ].join("");
      }
      const statusHtml = runningHere || (wdDictBssid === it.bssid && wdDictSync?.result) ? wdRowStatusHtml() : "—";
      // GPS: just the pin — full coordinates + SSID live in the tooltip,
      // same "abbreviate + title" treatment as the date column.
      const gps = it.lat != null && it.lon != null
        ? `<button class="wd-gps-btn" data-lat="${it.lat}" data-lon="${it.lon}" data-ssid="${escapeHtml(it.ssid || it.bssid)}" data-bssid="${it.bssid}"
             title="${escapeHtml(`${it.ssid || it.bssid} — ${it.lat.toFixed(5)}, ${it.lon.toFixed(5)} — ver en el mapa`)}">📍</button>`
        : "—";
      const rowClass = it.bssid === wdHighlightBssid ? "wd-crack-row-highlight" : "";
      // Password column: ALWAYS something readable. Cracked → partial
      // (first 3 chars + …) inline; the 👁/🙈 toggles the FULL password in
      // the cell itself — no modal, one click un-masks, one click masks.
      const pwRevealed = wdPassRevealed.has(it.bssid);
      const partial = (pw) => (pw.length > 3 ? pw.slice(0, 3) + "…" : pw[0] + "…");
      const passCell = it.password
        ? `<span class="wd-pass-value mono ${pwRevealed ? "revealed" : ""}">${escapeHtml(pwRevealed ? it.password : partial(it.password))}</span>
           <button class="wd-pass-eye" data-bssid="${it.bssid}" title="${escapeHtml(t("crackstation.password_eye_title", "Mostrar/ocultar contraseña"))}">${pwRevealed ? "🙈" : "👁"}</button>`
        : noFile
          ? '<span class="muted" style="font-size:11px;">—</span>'
          : '<span class="muted" style="font-size:11px;">sin crackear</span>';
      return `<tr class="${rowClass}" data-bssid="${it.bssid}" data-ssid="${escapeHtml(it.ssid || "")}"
                  data-session="${it.sessionId}" data-cap="${escapeHtml(capPath)}">
        <td class="wd-ssid" data-label="SSID">${it.live ? '<span class="demo-badge" style="background:rgba(80,255,120,.12);color:#34d351;">EN VIVO</span> ' : ""}${escapeHtml(it.ssid || "(oculta)")}</td>
        <td data-label="MAC" style="font-family: ui-monospace, monospace; font-size: 11px;">${escapeHtml(it.bssid)}</td>
        <td data-label="Origen">${wdOriginBadge(it.source)}</td>
        <td class="muted" data-label="Fecha" style="font-size:11px; white-space:nowrap;" title="${escapeHtml(wdFormatDateTime(it.capturedAt))}">${escapeHtml(wdFormatDateShort(it.capturedAt))}</td>
        <td data-label="GPS">${gps}</td>
        <td data-label="Handshake">${noFile ? '<span class="muted" style="font-size:11px;">sin archivo</span>' : it.hasHandshake ? '<span class="wd-verify-badge ok">✓ .cap</span>' : "—"}</td>
        <td data-label="Contraseña">${passCell}</td>
        <td class="wd-row-status-cell" data-label="Estado">${statusHtml}</td>
        <td data-label="Ataques"><div class="wd-action-group">${actionsHtml}</div></td>
        <td data-label="Archivos"><button class="wd-crack-files-btn" data-session="${escapeHtml(it.sessionId)}" data-ssid="${escapeHtml(it.ssid || "")}" data-bssid="${it.bssid}" data-source="${it.source}">${escapeHtml(t("crackstation.files_btn", "Ver archivos"))}</button></td>
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

// ---- Generic delete confirmation — shared by "borrar archivo" and
// "borrar sesión completa". The confirm button is cloned on each call to
// drop the previous listener instead of stacking a new one every time
// (this one modal is reused for every delete in the page). ----

function wdConfirmDelete(message, onConfirm) {
  const modal = el("wd-confirm-modal");
  const msgEl = el("wd-confirm-message");
  const okBtn = el("wd-confirm-ok");
  if (!modal || !msgEl || !okBtn) return;
  msgEl.textContent = message;
  const freshOk = okBtn.cloneNode(true);
  okBtn.replaceWith(freshOk);
  freshOk.addEventListener("click", async () => {
    modal.classList.add("hidden");
    await onConfirm();
  }, { once: true });
  modal.classList.remove("hidden");
}

el("wd-confirm-cancel")?.addEventListener("click", () => {
  el("wd-confirm-modal")?.classList.add("hidden");
});

// ---- Files modal ----

let wdFilesCtx = null; // { sessionId, source } — the session the modal is open for

function wdIsHandshakeFile(name) {
  return /\.(cap|pcapng|hc22000)$/i.test(name);
}

function wdRenderFilesList(items) {
  const filesBody = el("wd-crack-files-body");
  if (!filesBody) return;
  const rowHtml = (it) => {
    const size = it.size > 1024 * 1024 ? `${(it.size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(it.size / 1024)} KB`;
    const dl = `/api/wardrive/files/download?path=${encodeURIComponent(it.path)}`;
    return `<tr>
      <td>${wdIsHandshakeFile(it.name) ? "🤝 " : ""}${escapeHtml(it.name)}</td>
      <td>${size}</td>
      <td><button class="wd-preview-btn" data-path="${escapeHtml(it.path)}" data-name="${escapeHtml(it.name)}">${escapeHtml(t("crackstation.preview_btn", "Ver"))}</button></td>
      <td><a href="${dl}" download="${escapeHtml(it.name)}"><button class="wd-download-btn">${escapeHtml(t("crackstation.download_btn", "Bajar"))}</button></a></td>
      <td><button class="wd-file-del" data-path="${escapeHtml(it.path)}" data-name="${escapeHtml(it.name)}" title="Borrar archivo">🗑</button></td>
    </tr>`;
  };
  // Handshake captures (.cap/.pcapng/.hc22000) first — they're what you
  // came here for — everything else (info.txt, logs, side pcaps) after.
  const handshakes = items.filter((it) => wdIsHandshakeFile(it.name));
  const others = items.filter((it) => !wdIsHandshakeFile(it.name));
  let html = "";
  if (handshakes.length) {
    html += `<tr class="wd-files-group-label"><td colspan="5">${escapeHtml(t("crackstation.files_group_handshakes", "Handshakes"))}</td></tr>`;
    html += handshakes.map(rowHtml).join("");
  }
  if (others.length) {
    html += `<tr class="wd-files-group-label"><td colspan="5">${escapeHtml(t("crackstation.files_group_other", "Otros archivos"))}</td></tr>`;
    html += others.map(rowHtml).join("");
  }
  filesBody.innerHTML = html || '<tr><td colspan="5" class="muted">—</td></tr>';
}

async function wdLoadFilesList() {
  if (!wdFilesCtx) return;
  try {
    const res = await fetch(`/api/wardrive/files?path=${encodeURIComponent(wdFilesCtx.sessionId)}`);
    if (!res.ok) return;
    const data = await res.json();
    wdRenderFilesList(data.items || []);
  } catch { /* non-fatal */ }
}

async function wdOpenCrackFiles(sessionId, ssid, bssid, source) {
  const modal = el("wd-crack-files-modal");
  const filesTitle = el("wd-crack-files-title");
  if (!modal || !filesTitle) return;
  wdFilesCtx = { sessionId, source: source === "wardrive" ? "wardrive" : "wifi-audit" };
  // SSID + MAC in the title so it's clear which handshake's files these
  // are without having to go back and check the table row.
  const label = ssid ? `${ssid} (${bssid})` : bssid || sessionId;
  filesTitle.textContent = `${t("crackstation.files_title", "Archivos")} — ${label}`;
  modal.classList.remove("hidden");
  await wdLoadFilesList();
}

el("wd-crack-files-close")?.addEventListener("click", () => {
  el("wd-crack-files-modal")?.classList.add("hidden");
});

el("wd-crack-files-delete-session")?.addEventListener("click", () => {
  if (!wdFilesCtx) return;
  const { sessionId, source } = wdFilesCtx;
  wdConfirmDelete(
    `¿Borrar la sesión completa "${sessionId}" y todos sus archivos (capturas, hashes, logs)? Esta acción no se puede deshacer.`,
    async () => {
      const endpoint = source === "wardrive" ? "/api/wardrive/drive/sessions/delete" : "/api/wardrive/sessions/delete";
      try {
        const res = await apiFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: sessionId }),
        });
        const data = await res.json().catch(() => null);
        if (data?.ok) {
          el("wd-crack-files-modal")?.classList.add("hidden");
          toast("Sesión borrada", "success");
          void wdTickCrackStation();
        } else if (wdError) {
          wdError.textContent = data?.error || "No se pudo borrar la sesión";
        }
      } catch {
        if (wdError) wdError.textContent = "Error de red borrando la sesión";
      }
    },
  );
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
  const previewBtn = ev.target.closest(".wd-preview-btn");
  if (previewBtn) {
    try {
      const res = await fetch(`/api/wardrive/files/preview?path=${encodeURIComponent(previewBtn.dataset.path)}`);
      if (!res.ok) return;
      const data = await res.json();
      wdShowPreview(previewBtn.dataset.name, data);
    } catch { /* non-fatal */ }
    return;
  }
  const delBtn = ev.target.closest(".wd-file-del");
  if (delBtn) {
    wdConfirmDelete(`¿Borrar "${delBtn.dataset.name}"? Esta acción no se puede deshacer.`, async () => {
      try {
        await apiFetch("/api/wardrive/files/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: delBtn.dataset.path }),
        });
        toast("Archivo borrado", "success");
        await wdLoadFilesList();
        void wdTickCrackStation(); // el inventario puede haber cambiado (p.ej. se borró el .cap)
      } catch {
        if (wdError) wdError.textContent = "Error de red borrando el archivo";
      }
    });
  }
});

el("wd-preview-close")?.addEventListener("click", () => {
  el("wd-preview-modal")?.classList.add("hidden");
});

// ---- Password column toggle (👁/🙈 in the Contraseña column) — click
// un-masks the full password IN the cell, click again masks it back to
// partial. No modal. Set of revealed BSSIDs resets when the inventory
// refreshes with different content. ----

const wdPassRevealed = new Set();

el("wd-crack-body")?.addEventListener("click", (ev) => {
  const eye = ev.target.closest(".wd-pass-eye");
  if (!eye) return;
  const bssid = eye.dataset.bssid;
  if (wdPassRevealed.has(bssid)) wdPassRevealed.delete(bssid);
  else wdPassRevealed.add(bssid);
  wdRenderCrackStation();
});

// ---- Capture-location map (GPS column) — Leaflet, same OSM tiles as
// gps.js/wardrive.js. Only Wardrive rows carry a coordinate (Wifi Audit is
// stationary lab capture). One map instance, re-centered per click. ----

let wdCrackMap = null;
let wdCrackMapMarker = null;
let wdCrackMapSeq = 0; // guards against a stale geocode reply overwriting a newer click

function wdOpenCrackMap(lat, lon, ssid, bssid) {
  const modal = el("wd-crack-map-modal");
  const title = el("wd-crack-map-title");
  const addressEl = el("wd-crack-map-address");
  const mapEl = el("wd-crack-map");
  if (!modal || !mapEl) return;
  if (title) title.textContent = `${ssid || "(oculta)"} — ${bssid}`;
  const seq = ++wdCrackMapSeq;
  if (addressEl) {
    addressEl.textContent = "Buscando dirección...";
    // Server-side reverse geocode (cached + throttled in geocodePoint(),
    // shares the GPS page's Nominatim budget) — best-effort, never blocks
    // the map itself.
    fetch(`/api/wardrive/geocode?lat=${lat}&lon=${lon}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (seq === wdCrackMapSeq) addressEl.textContent = data?.address || "Dirección no disponible";
      })
      .catch(() => {
        if (seq === wdCrackMapSeq) addressEl.textContent = "Dirección no disponible";
      });
  }
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

// Launch points: Crack Station rows (rockyou / weakpass / mask / archivos / mapa).
el("wd-crack-body")?.addEventListener("click", async (ev) => {
  const dictBtn = ev.target.closest(".wd-crack-dict");
  if (dictBtn) {
    const wordlist = dictBtn.dataset.wordlist === "weakpass" ? "weakpass" : "rockyou";
    const res = await wdApi("dict/start", { bssid: dictBtn.dataset.bssid, cap: dictBtn.dataset.cap, wordlist });
    if (res?.error) {
      if (wdError) wdError.textContent = res.error;
      return;
    }
    toast(`Ataque de diccionario lanzado (${wordlist})`, "success");
    wdWatchDict();
    void wdTickCrackStation();
    return;
  }
  const maskBtn = ev.target.closest(".wd-crack-mask");
  if (maskBtn) {
    void wdOpenMaskPicker(maskBtn.dataset.bssid, maskBtn.dataset.ssid, maskBtn.dataset.cap);
    return;
  }
  const filesBtn = ev.target.closest(".wd-crack-files-btn");
  if (filesBtn) {
    void wdOpenCrackFiles(filesBtn.dataset.session, filesBtn.dataset.ssid, filesBtn.dataset.bssid, filesBtn.dataset.source);
    return;
  }
  const gpsBtn = ev.target.closest(".wd-gps-btn");
  if (gpsBtn) {
    wdOpenCrackMap(parseFloat(gpsBtn.dataset.lat), parseFloat(gpsBtn.dataset.lon), gpsBtn.dataset.ssid, gpsBtn.dataset.bssid);
    return;
  }
  const statusBtn = ev.target.closest(".wd-row-status");
  if (statusBtn) wdOpenDictDetail();
});

el("wd-crack-refresh")?.addEventListener("click", () => void wdTickCrackStation());

// ---- Dictionary attack (rockyou/weakpass) status ----
// The numeric % progress was never actually useful to the user ("el
// progreso nunca ha servido") — so the table and the detail modal now only
// ever show a CLEAR state: en proceso / encontrada / sin match. No %, no
// "claves probadas". A successful crack pops a celebration modal (see
// wdMaybeCelebrateSuccess below).
let wdDictBssid = null;
let wdDictSync = null; // { tried, total, fps, running, result, wordlist, syncedAtMs }
let wdDictPollTimer = null; // server sync, only while a crack is running
let wdDictDetailTimer = null; // ticks the detail modal's elapsed time while open+running
let wdDictRunningPrev = false; // detects start/stop transitions (see wdSyncDictStatus)

// ---- Inline per-row status — the exact handshake being cracked (or that
// just finished) shows a status badge in the "Estado" column. Click it for
// the detail modal (see wdOpenDictDetail below). ----

function wdRowStatusHtml() {
  if (wdDictSync?.running) {
    return `<button class="wd-row-status running" title="Ver detalle">⏳ ${escapeHtml(t("crackstation.status_running", "En proceso"))}</button>`;
  }
  if (wdDictSync?.result) {
    return wdDictSync.result.matched
      ? `<button class="wd-row-status ok" title="Ver detalle">🏴‍☠️ ${escapeHtml(t("crackstation.status_found", "Encontrada"))}</button>`
      : `<button class="wd-row-status fail" title="Ver detalle">✗ ${escapeHtml(t("crackstation.status_notfound", "Sin match"))}</button>`;
  }
  return "—";
}

function wdRenderRowStatus() {
  if (!wdDictBssid) return;
  const row = document.querySelector(`#wd-crack-body tr[data-bssid="${CSS.escape(wdDictBssid)}"]`);
  const cell = row?.querySelector(".wd-row-status-cell");
  if (cell) cell.innerHTML = wdRowStatusHtml();
}

// ---- Dictionary attack detail modal — opened by clicking the row's status
// badge. Same clear-state principle as the table: a big banner, no %. The
// tried/total/speed line is kept as small supplementary info since it's
// accurate now, but never the headline. ----

function wdRenderDictDetail() {
  const modal = el("wd-dict-detail-modal");
  if (modal?.classList.contains("hidden")) return; // don't bother building it unless it's actually open
  const title = el("wd-dict-detail-title");
  const body = el("wd-dict-detail-body");
  if (!body) return;
  if (!wdDictSync) {
    if (title) title.textContent = t("crackstation.dict_detail_title", "Ataque de diccionario");
    body.innerHTML = '<p class="muted">No hay ningún ataque de diccionario en curso.</p>';
    return;
  }
  const ssid = wdCrackCache.find((i) => i.bssid === wdDictBssid)?.ssid || wdDictBssid || "";
  const wordlistLabel = wdDictSync.wordlist === "weakpass" ? "weakpass" : "rockyou";
  if (title) title.textContent = `dictionary attack (${wordlistLabel}) · ${ssid}`;
  const banner = wdDictSync.running
    ? `<div class="wd-verify-badge none" style="font-size:14px; padding:8px 14px;">⏳ ${escapeHtml(t("crackstation.status_running", "En proceso"))}…</div>`
    : wdDictSync.result?.matched
      ? `<div class="wd-verify-badge ok" style="font-size:14px; padding:8px 14px;">🏴‍☠️ ${escapeHtml(t("crackstation.success_title", "¡CONTRASEÑA ENCONTRADA!"))} — ${escapeHtml(wdDictSync.result.output?.match(/KEY FOUND!\s*\[\s*(.*?)\s*\]/)?.[1] || "")}</div>`
      : wdDictSync.result?.verdict === "handshake_wrong_password"
        ? `<div class="wd-verify-badge wrong" style="font-size:14px; padding:8px 14px;">✗ ${escapeHtml(t("crackstation.status_notfound", "Sin match"))} — diccionario agotado</div>`
        : `<div class="wd-verify-badge err" style="font-size:14px; padding:8px 14px;">${escapeHtml(wdDictSync.result?.output || "cancelado")}</div>`;
  const total = wdDictSync.total || 0;
  const metaLine = total > 0
    ? `${Math.round(wdDictSync.tried).toLocaleString()} / ${total.toLocaleString()} claves · ${(wdDictSync.fps || 0).toFixed(0)} pass/s`
    : `${Math.round(wdDictSync.tried).toLocaleString()} claves probadas`;
  body.innerHTML = `
    ${banner}
    <div class="muted" style="margin-top:10px; font-size:11px;">${metaLine}</div>
    <div style="margin-top:14px;">
      ${wdDictSync.running
        ? `<button class="wd-dict-stop wd-danger">${escapeHtml(t("crackstation.dict_cancel", "Cancelar"))}</button>`
        : `<button class="wd-dict-clear secondary">${escapeHtml(t("crackstation.dict_clear", "Cerrar"))}</button>`}
    </div>
  `;
}

function wdOpenDictDetail() {
  const modal = el("wd-dict-detail-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  wdRenderDictDetail();
}

el("wd-dict-detail-close")?.addEventListener("click", () => {
  el("wd-dict-detail-modal")?.classList.add("hidden");
});

el("wd-dict-detail-body")?.addEventListener("click", async (ev) => {
  if (ev.target.closest(".wd-dict-clear")) {
    await apiFetch("/api/wardrive/dict/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    wdDictSync = null;
    el("wd-dict-detail-modal")?.classList.add("hidden");
    void wdRenderCrackStation();
    return;
  }
  if (!ev.target.closest(".wd-dict-stop")) return;
  await apiFetch("/api/wardrive/dict/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  void wdSyncDictStatus();
});

// ---- Success celebration — confetti + pirate flag modal, same pattern as
// Wifi Audit's handshake-captured celebration but self-contained here
// (standalone page, no app.js). Fires once per completed crack. ----

function wdCrackConfettiOnce() {
  const canvas = el("wd-crack-success-canvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width || 400;
  canvas.height = rect.height || 260;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const colors = ["#34d351", "#fb923c", "#f5f5f5", "#60a5fa"];
  const pieces = Array.from({ length: 120 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.5,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    vy: 2.2 + Math.random() * 2.6,
    vx: -1.4 + Math.random() * 2.8,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.24,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = Date.now();
  const DURATION = 4200;
  (function frame() {
    const tt = Date.now() - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (tt > DURATION) return;
    for (const p of pieces) {
      p.y += p.vy;
      p.x += p.vx + Math.sin((tt + p.h) / 260) * 0.7;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = tt > DURATION - 800 ? Math.max(0, (DURATION - tt) / 800) : 1;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h / 2);
      ctx.fillStyle = "#1f2937";
      ctx.fillRect(-p.w / 2, 0, p.w, p.h / 2);
      ctx.restore();
    }
    requestAnimationFrame(frame);
  })();
}

function wdCelebrateCrackSuccess(bssid, wordlist, password) {
  const modal = el("wd-crack-success-modal");
  if (!modal) return;
  const ssid = wdCrackCache.find((i) => i.bssid === bssid)?.ssid || bssid || "";
  el("wd-crack-success-ssid").textContent = ssid;
  el("wd-crack-success-wordlist").textContent = `Diccionario: ${wordlist === "weakpass" ? "weakpass" : "rockyou"}`;
  el("wd-crack-success-password").textContent = password || "—";
  modal.classList.remove("hidden");
  wdCrackConfettiOnce();
}

el("wd-crack-success-close")?.addEventListener("click", () => {
  el("wd-crack-success-modal")?.classList.add("hidden");
});

async function wdSyncDictStatus() {
  try {
    const res = await fetch("/api/wardrive/dict/status");
    if (!res.ok) return;
    const data = await res.json();
    const prevBssid = wdDictBssid;
    const wasRunning = Boolean(wdDictSync?.running);
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
        wordlist: data.wordlist,
        syncedAtMs: performance.now(),
      };
    }
    // A start/stop transition means the affected row's Ataques cell needs
    // to switch between buttons and the status badge — a full table
    // re-render (cheap, it's a short list) is the simplest correct way to
    // restore the right buttons (or the ✓ password badge) once a crack
    // finishes, without hand-tracking every possible outcome here.
    const runningNow = Boolean(wdDictSync?.running);
    if (wdDictRunningPrev !== runningNow) {
      wdDictRunningPrev = runningNow;
      if (!runningNow && wasRunning && wdDictSync?.result?.matched) {
        const bssidDone = prevBssid || wdDictBssid;
        const password = wdDictSync.result.output?.match(/KEY FOUND!\s*\[\s*(.*?)\s*\]/)?.[1] || "";
        wdCelebrateCrackSuccess(bssidDone, wdDictSync.wordlist, password);
      }
      wdRenderCrackStation();
    }
    wdRenderRowStatus();
    wdRenderDictDetail(); // no-op while the modal is closed
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
  if (!wdDictDetailTimer) {
    wdDictDetailTimer = setInterval(() => {
      if (!document.hidden) wdRenderDictDetail(); // no-op while the modal is closed
    }, 1000);
  }
}

// ---- Mask brute force ----

let wdCrackTimer = null; // mask-run polling while a mask attack is running
let wdMaskPickerCtx = null; // { bssid, ssid, cap } — the handshake the picker modal is open for

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

// Shared by both the manage sub-section and the picker modal — one fetch,
// two renderers. Cached briefly on the module scope isn't worth it (the
// list is short and both call sites already run on user action, not on a
// tight loop).
async function wdFetchMaskPresets() {
  try {
    const res = await fetch("/api/wardrive/mask/status");
    if (res.ok) return (await res.json()).presets || [];
  } catch { /* non-fatal */ }
  return [];
}

// ---- Manage masks (add/edit/delete) — the collapsed sub-section ----

async function wdRenderMaskPresets() {
  const wrap = el("wd-mask-presets");
  if (!wrap) return;
  const presets = await wdFetchMaskPresets();
  wrap.innerHTML = presets
    .map((m) => {
      const isBuiltin = m.id.startsWith("builtin-");
      return `<div class="wd-mask-preset" data-id="${m.id}">
        <div class="wd-mask-preset-head">
          <strong>${escapeHtml(m.name)}</strong>
          <span style="display:inline-flex; gap:4px;">
            ${isBuiltin
              ? '<span class="wd-verify-badge none">fábrica</span>'
              : `<button class="wd-mask-edit" data-id="${m.id}" title="Editar máscara">✎</button>
                 <button class="wd-mask-del" data-id="${m.id}" title="Borrar máscara">🗑</button>`}
          </span>
        </div>
        <div class="wd-mask-preset-pattern"><code>${escapeHtml(m.pattern)}${m.autoMacSuffix ? "<em>+MAC4</em>" : ""}</code>
          <span class="muted">· ${wdHumanKeys(wdMaskTotalPreview(m.pattern + (m.autoMacSuffix ? "$$$$" : "")))}${m.autoMacSuffix ? " · +sufijo MAC" : ""}</span></div>
        <div class="wd-mask-preset-desc">${escapeHtml(m.description)}</div>
      </div>`;
    })
    .join("");
}

function wdResetMaskForm() {
  el("wd-mask-edit-id").value = "";
  el("wd-mask-name").value = "";
  el("wd-mask-pattern").value = "";
  el("wd-mask-description").value = "";
  el("wd-mask-mac").checked = false;
  el("wd-mask-msg").textContent = "";
  el("wd-mask-save").textContent = t("crackstation.mask_form_save", "Guardar máscara");
  el("wd-mask-form-title").textContent = t("crackstation.mask_new_title", "+ NUEVA MÁSCARA");
  el("wd-mask-cancel-edit")?.classList.add("hidden");
}

function wdStartMaskEdit(preset) {
  el("wd-mask-edit-id").value = preset.id;
  el("wd-mask-name").value = preset.name;
  el("wd-mask-pattern").value = preset.pattern;
  el("wd-mask-description").value = preset.description || "";
  el("wd-mask-mac").checked = preset.autoMacSuffix === true;
  el("wd-mask-msg").textContent = "";
  el("wd-mask-save").textContent = t("crackstation.mask_form_save_edit", "Guardar cambios");
  el("wd-mask-form-title").textContent = t("crackstation.mask_edit_title", "EDITAR MÁSCARA");
  el("wd-mask-cancel-edit")?.classList.remove("hidden");
  wdActivateSubtab("masks");
  el("wd-mask-new")?.scrollIntoView({ block: "center", behavior: "smooth" });
}

el("wd-mask-presets")?.addEventListener("click", async (ev) => {
  const delBtn = ev.target.closest(".wd-mask-del");
  if (delBtn) {
    await apiFetch("/api/wardrive/mask/presets/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: delBtn.dataset.id }),
    });
    // If the deleted preset was mid-edit, drop back to "new" so Save
    // doesn't try to update something that no longer exists.
    if (el("wd-mask-edit-id").value === delBtn.dataset.id) wdResetMaskForm();
    void wdRenderMaskPresets();
    return;
  }
  const editBtn = ev.target.closest(".wd-mask-edit");
  if (!editBtn) return;
  const presets = await wdFetchMaskPresets();
  const preset = presets.find((m) => m.id === editBtn.dataset.id);
  if (preset) wdStartMaskEdit(preset);
});

el("wd-mask-cancel-edit")?.addEventListener("click", wdResetMaskForm);

el("wd-mask-save")?.addEventListener("click", async () => {
  const msg = el("wd-mask-msg");
  const editId = el("wd-mask-edit-id")?.value || "";
  const name = el("wd-mask-name")?.value?.trim() || "";
  const pattern = el("wd-mask-pattern")?.value?.trim() || "";
  const description = el("wd-mask-description")?.value?.trim() || "";
  const autoMacSuffix = el("wd-mask-mac")?.checked === true;
  if (!name || !pattern) {
    msg.textContent = "Nombre y patrón requeridos";
    return;
  }
  try {
    const res = await apiFetch(editId ? "/api/wardrive/mask/presets/update" : "/api/wardrive/mask/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editId ? { id: editId, name, pattern, description, autoMacSuffix } : { name, pattern, description, autoMacSuffix }),
    });
    const data = await res.json();
    if (data?.ok) {
      wdResetMaskForm();
      void wdRenderMaskPresets();
    } else {
      msg.textContent = data?.error || "No se pudo guardar";
    }
  } catch {
    msg.textContent = "Error de red";
  }
});

// ---- Mask picker (row's "máscara…" button) — pick a mask, it launches
// immediately against that handshake. No manual BSSID entry: the row
// already gave us bssid/ssid/cap. ----

async function wdOpenMaskPicker(bssid, ssid, cap) {
  const modal = el("wd-mask-picker-modal");
  const target = el("wd-mask-picker-target");
  const list = el("wd-mask-picker-list");
  if (!modal || !target || !list) return;
  wdMaskPickerCtx = { bssid, ssid, cap };
  target.innerHTML = `SSID <strong>${escapeHtml(ssid || "(oculta)")}</strong> · MAC <strong>${escapeHtml(bssid)}</strong>`;
  const presets = await wdFetchMaskPresets();
  list.innerHTML = presets.length
    ? presets
        .map((m) => `<div class="wd-mask-preset" data-id="${m.id}">
          <div class="wd-mask-preset-head"><strong>${escapeHtml(m.name)}</strong>${m.id.startsWith("builtin-") ? '<span class="wd-verify-badge none">fábrica</span>' : ""}</div>
          <div class="wd-mask-preset-pattern"><code>${escapeHtml(m.pattern)}${m.autoMacSuffix ? "<em>+MAC4</em>" : ""}</code>
            <span class="muted">· ${wdHumanKeys(wdMaskTotalPreview(m.pattern + (m.autoMacSuffix ? "$$$$" : "")))}${m.autoMacSuffix ? " · +sufijo MAC" : ""}</span></div>
          <div class="wd-mask-preset-desc">${escapeHtml(m.description)}</div>
          <button class="wd-mask-picker-launch" data-id="${m.id}">${escapeHtml(t("crackstation.mask_picker_launch", "Lanzar contra este handshake"))}</button>
        </div>`)
        .join("")
    : `<div class="muted">${escapeHtml(t("crackstation.mask_picker_empty", 'No hay máscaras guardadas — creá una en "Administrar máscaras".'))}</div>`;
  modal.classList.remove("hidden");
}

el("wd-mask-picker-close")?.addEventListener("click", () => {
  el("wd-mask-picker-modal")?.classList.add("hidden");
});

el("wd-mask-picker-list")?.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".wd-mask-picker-launch");
  if (!btn || !wdMaskPickerCtx) return;
  const { bssid, cap } = wdMaskPickerCtx;
  el("wd-mask-picker-modal")?.classList.add("hidden");
  wdMaskLaunch(btn.dataset.id, null, bssid, cap, undefined);
  el("wd-mask-panel")?.scrollIntoView({ block: "start", behavior: "smooth" });
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

// Renders the active/last mask run (launched from the picker modal — see
// wdOpenMaskPicker/wdMaskLaunch above).
async function wdRenderMaskRun() {
  const runBox = el("wd-mask-run");
  const status = el("wd-mask-run-status");
  const section = el("wd-mask-section");
  if (!runBox) return;
  let data = null;
  try {
    const res = await fetch("/api/wardrive/mask/status");
    if (res.ok) data = await res.json();
  } catch { return; }
  if (!data?.state || (!data.state.running && !data.state.done)) {
    // Nothing to show — hide the whole section (title included) instead
    // of leaving an empty labeled box on screen.
    runBox.innerHTML = "";
    if (status) status.textContent = "";
    section?.classList.add("hidden");
    return;
  }
  section?.classList.remove("hidden");
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

wdInitSubtabs();
wdInitCrackSort();
wdWatchDict(); // recovers an in-flight dictionary attack after a reload
void wdRenderMaskPresets(); // populate "Administrar máscaras" once at load
void wdTickCrackStation();
setInterval(() => {
  if (!document.hidden) void wdTickCrackStation();
}, 5000);
