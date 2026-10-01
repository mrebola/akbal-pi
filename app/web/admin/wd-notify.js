// Notification bell — shared across every admin page's topbar. For now its
// only job is the dictionary-crack lifecycle (Crack Station): when a run
// starts, when one is in progress, and when it finishes, each with start
// and end timestamps. Self-contained (no app.js dependency) so it can be
// dropped into any standalone page just by adding a <script> tag, same
// pattern as i18n.js. Backed by GET /api/wardrive/dict/events (in-memory
// log on the server, see WardriveService.dictEventLog in wifi-audit/service.ts).
"use strict";

(function () {
  const POLL_MS = 6000;
  let events = [];
  let open = false;

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = String(s ?? "");
    return div.innerHTML;
  }

  function fmtTime(ms) {
    if (!ms) return "—";
    try {
      return new Date(ms).toLocaleString("es-MX", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch {
      return "—";
    }
  }

  function statusIcon(ev) {
    if (ev.status === "running") return "⏳";
    if (ev.status === "success") return "🏴‍☠️";
    if (ev.status === "nomatch") return "✗";
    return "⚠";
  }

  function statusLabel(ev) {
    if (ev.status === "running") return "En proceso";
    if (ev.status === "success") return "Encontrada";
    if (ev.status === "nomatch") return "Sin match";
    return "Error";
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
    } catch { /* private browsing or blocked storage — non-fatal */ }
  }

  function render() {
    const dot = document.getElementById("wd-bell-dot");
    const list = document.getElementById("wd-bell-list");
    if (!list) return;
    const running = events.filter((e) => e.status === "running").length;
    const seenAt = lastSeen();
    const unseen = events.some((e) => (e.endedAt || e.startedAt) > seenAt);
    if (dot) {
      dot.classList.toggle("hidden", !(running > 0 || unseen));
      dot.classList.toggle("running", running > 0);
    }
    if (!events.length) {
      list.innerHTML = '<div class="wd-bell-empty muted">Sin actividad de cracking todavía.</div>';
      return;
    }
    list.innerHTML = events
      .map(
        (ev) => `
      <div class="wd-bell-item ${escapeHtml(ev.status)}">
        <div class="wd-bell-item-head">
          <span class="wd-bell-item-icon">${statusIcon(ev)}</span>
          <span class="wd-bell-item-ssid">${escapeHtml(ev.ssid || ev.bssid)}</span>
          <span class="wd-bell-item-status">${statusLabel(ev)}</span>
        </div>
        <div class="wd-bell-item-meta muted">
          ${escapeHtml(ev.wordlist)} · inicio ${fmtTime(ev.startedAt)}${ev.endedAt ? ` · fin ${fmtTime(ev.endedAt)}` : ""}
        </div>
      </div>`,
      )
      .join("");
  }

  async function poll() {
    try {
      const res = await fetch("/api/wardrive/dict/events");
      if (!res.ok) return;
      const data = await res.json();
      events = data.events || [];
      render();
    } catch { /* non-fatal */ }
  }

  function build() {
    const host = document.querySelector(".hdr-right");
    if (!host || document.getElementById("wd-bell")) return;
    const wrap = document.createElement("div");
    wrap.className = "wd-bell-wrap";
    wrap.innerHTML = `
      <button id="wd-bell" class="wd-bell" type="button" title="Notificaciones de cracking" aria-label="Notificaciones">
        🔔<span id="wd-bell-dot" class="wd-bell-dot hidden"></span>
      </button>
      <div id="wd-bell-dropdown" class="wd-bell-dropdown hidden">
        <div class="wd-bell-dropdown-title">Cracking — actividad reciente</div>
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
    document.addEventListener("click", (ev) => {
      if (open && !ev.target.closest(".wd-bell-wrap")) {
        open = false;
        document.getElementById("wd-bell-dropdown")?.classList.add("hidden");
      }
    });
  }

  function init() {
    build();
    void poll();
    setInterval(() => {
      if (!document.hidden) void poll();
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
