// Notification bell — shared across every admin page's topbar. The ONE
// notification surface in the app (per explicit feedback: device-problem
// alerts — "2 dispositivos faltantes" — show up HERE, not as alert text in
// the AKBAL OK status panel). Two sources merged into one list:
//  - Dictionary-crack lifecycle (Crack Station): start/in-progress/finish,
//    backed by GET /api/wardrive/dict/events (in-memory log on the server,
//    see WardriveService.dictEventLog in wifi-audit/service.ts). Each item
//    links straight to Crack Station.
//  - Missing-device alerts (Wi-Fi/GPS/HackRF), pushed in by topbar.js via
//    the "akbal:problems-changed" event (same /api/status + /api/gps/summary
//    + /api/aircraft poll that drives the AKBAL OK panel — not fetched
//    twice). Each item links to the page where you'd fix it.
// Every item can be dismissed individually (✕) or all at once; dismissals
// are remembered in localStorage (per-viewer only, see artifact-capabilities
// convention — never a server write). A dismissed problem reappears if it
// clears and then recurs (new occurrence), since that's worth flagging
// again; a dismissed crack event stays gone (ids are one-shot per attempt).
"use strict";

(function () {
  const POLL_MS = 6000;
  const DISMISSED_KEY = "akbalBellDismissed";
  let crackEvents = [];
  let problems = [];
  let open = false;

  const t = (key, fallback, vars) => (window.AkbalI18n ? window.AkbalI18n.t(key, vars) : null) || fallback;

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = String(s ?? "");
    return div.innerHTML;
  }

  function fmtTime(ms) {
    if (!ms) return "—";
    try {
      const locale = window.AkbalI18n?.getLocale() === "en" ? "en-US" : "es-MX";
      return new Date(ms).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch {
      return "—";
    }
  }

  function getDismissed() {
    try {
      return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]"));
    } catch {
      return new Set();
    }
  }
  function setDismissed(set) {
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set]));
    } catch { /* private browsing or blocked storage — non-fatal */ }
  }
  function dismiss(id) {
    const d = getDismissed();
    d.add(id);
    setDismissed(d);
    render();
  }
  function dismissAll() {
    const d = getDismissed();
    for (const item of mergedItems()) d.add(item.id);
    setDismissed(d);
    render();
  }
  // A dismissed PROBLEM un-dismisses itself once the underlying issue is no
  // longer present — if it comes back later, that's a fresh occurrence.
  // Crack events never auto-clear (ids are unique per attempt already).
  function pruneResolvedProblems() {
    const d = getDismissed();
    const activeIds = new Set(problems.map((p) => p.id));
    let changed = false;
    for (const id of [...d]) {
      if (id.startsWith("problem:") && !activeIds.has(id)) {
        d.delete(id);
        changed = true;
      }
    }
    if (changed) setDismissed(d);
  }

  function statusIcon(ev) {
    if (ev.status === "running") return "⏳";
    if (ev.status === "success") return "🏴‍☠️";
    if (ev.status === "nomatch") return "✗";
    return "⚠";
  }
  function statusLabel(ev) {
    if (ev.status === "running") return t("notify.status_running", "En proceso");
    if (ev.status === "success") return t("notify.status_found", "Encontrada");
    if (ev.status === "nomatch") return t("notify.status_nomatch", "Sin match");
    return t("notify.status_error", "Error");
  }

  function mergedItems() {
    const crackItems = crackEvents.map((ev) => ({
      id: ev.id,
      kind: "crack",
      icon: statusIcon(ev),
      title: ev.ssid || ev.bssid,
      status: statusLabel(ev),
      statusClass: ev.status,
      meta: `${escapeHtml(ev.wordlist)} · ${t("notify.started", "inicio")} ${fmtTime(ev.startedAt)}${ev.endedAt ? ` · ${t("notify.ended", "fin")} ${fmtTime(ev.endedAt)}` : ""}`,
      href: `/crack-station?bssid=${encodeURIComponent(ev.bssid)}`,
      ts: ev.endedAt || ev.startedAt,
    }));
    const problemItems = problems.map((p) => ({
      id: p.id,
      kind: "problem",
      icon: "⚠",
      title: p.message,
      status: "",
      statusClass: "warn",
      meta: "",
      href: p.href,
      ts: Date.now(),
    }));
    return [...problemItems, ...crackItems].sort((a, b) => b.ts - a.ts);
  }

  function lastSeen() {
    try {
      return Number(localStorage.getItem("wdBellLastSeen") || 0);
    } catch {
      return 0;
    }
  }
  function markSeen() {
    try {
      localStorage.setItem("wdBellLastSeen", String(Date.now()));
    } catch { /* non-fatal */ }
  }

  function render() {
    const dot = document.getElementById("wd-bell-dot");
    const list = document.getElementById("wd-bell-list");
    if (!list) return;
    pruneResolvedProblems();
    const dismissed = getDismissed();
    const items = mergedItems().filter((it) => !dismissed.has(it.id));

    const running = crackEvents.filter((e) => e.status === "running").length;
    const seenAt = lastSeen();
    const unseen = items.some((it) => it.ts > seenAt) || problems.length > 0;
    if (dot) {
      dot.classList.toggle("hidden", !(running > 0 || unseen));
      dot.classList.toggle("running", running > 0);
    }

    const clearAllBtn = document.getElementById("wd-bell-clear-all");
    if (clearAllBtn) clearAllBtn.classList.toggle("hidden", items.length === 0);

    if (!items.length) {
      list.innerHTML = `<div class="wd-bell-empty muted">${escapeHtml(t("notify.empty", "Sin notificaciones."))}</div>`;
      return;
    }
    list.innerHTML = items
      .map((it) => {
        const body = `
          <div class="wd-bell-item-head">
            <span class="wd-bell-item-icon">${it.icon}</span>
            <span class="wd-bell-item-ssid">${escapeHtml(it.title)}</span>
            ${it.status ? `<span class="wd-bell-item-status">${escapeHtml(it.status)}</span>` : ""}
          </div>
          ${it.meta ? `<div class="wd-bell-item-meta muted">${it.meta}</div>` : ""}`;
        const content = it.href
          ? `<a class="wd-bell-item-link" href="${escapeHtml(it.href)}">${body}</a>`
          : `<div class="wd-bell-item-link">${body}</div>`;
        return `
      <div class="wd-bell-item ${escapeHtml(it.statusClass)}" data-nid="${escapeHtml(it.id)}">
        <button type="button" class="wd-bell-item-dismiss" title="${escapeHtml(t("notify.dismiss", "Descartar"))}" aria-label="${escapeHtml(t("notify.dismiss", "Descartar"))}">✕</button>
        ${content}
      </div>`;
      })
      .join("");
  }

  async function pollCrackEvents() {
    try {
      const res = await fetch("/api/wardrive/dict/events");
      if (!res.ok) return;
      const data = await res.json();
      crackEvents = data.events || [];
      render();
    } catch { /* non-fatal */ }
  }

  function build() {
    const host = document.querySelector(".hdr-right");
    if (!host || document.getElementById("wd-bell")) return;
    const wrap = document.createElement("div");
    wrap.className = "wd-bell-wrap";
    wrap.innerHTML = `
      <button id="wd-bell" class="wd-bell" type="button" title="${escapeAttr(t("notify.title", "Notificaciones"))}" aria-label="${escapeAttr(t("notify.title", "Notificaciones"))}">
        🔔<span id="wd-bell-dot" class="wd-bell-dot hidden"></span>
      </button>
      <div id="wd-bell-dropdown" class="wd-bell-dropdown hidden">
        <div class="wd-bell-dropdown-head">
          <span class="wd-bell-dropdown-title">${escapeAttr(t("notify.title", "Notificaciones"))}</span>
          <button type="button" id="wd-bell-clear-all" class="wd-bell-clear-all hidden">${escapeAttr(t("notify.clear_all", "Borrar todas"))}</button>
        </div>
        <div id="wd-bell-list" class="wd-bell-list"></div>
      </div>`;
    host.insertBefore(wrap, host.firstChild);
    document.getElementById("wd-bell").addEventListener("click", (ev) => {
      ev.stopPropagation();
      open = !open;
      document.getElementById("wd-bell-dropdown")?.classList.toggle("hidden", !open);
      if (open) {
        markSeen();
        render();
      }
    });
    document.getElementById("wd-bell-clear-all").addEventListener("click", (ev) => {
      ev.stopPropagation();
      dismissAll();
    });
    document.getElementById("wd-bell-list").addEventListener("click", (ev) => {
      const dismissBtn = ev.target.closest(".wd-bell-item-dismiss");
      if (!dismissBtn) return;
      ev.stopPropagation();
      ev.preventDefault();
      dismiss(dismissBtn.closest(".wd-bell-item")?.dataset.nid);
    });
    document.addEventListener("click", (ev) => {
      if (open && !ev.target.closest(".wd-bell-wrap")) {
        open = false;
        document.getElementById("wd-bell-dropdown")?.classList.add("hidden");
      }
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && open) {
        open = false;
        document.getElementById("wd-bell-dropdown")?.classList.add("hidden");
      }
    });
    document.addEventListener("akbal:problems-changed", (ev) => {
      problems = ev.detail?.problems || [];
      render();
    });
    document.addEventListener("akbal:locale-changed", render);
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  function init() {
    build();
    void pollCrackEvents();
    setInterval(() => {
      if (!document.hidden) void pollCrackEvents();
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
