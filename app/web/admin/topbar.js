// Shared topbar/navigation — single implementation for all 6 admin pages
// (replaces 6 near-identical copies of: hamburger+drawer, the system
// popover, and the /api/status polling that fed it). Each page keeps only
// a bare `<header class="topbar" id="topbar" data-page="...">` plus — if it
// has page-specific controls (LIVE/DEMO, a view toggle, the dongle picker)
// — a `<div id="page-toolbar-controls">` holding that EXACT existing
// markup unchanged (same ids/classes), which this script relocates into
// the new contextual toolbar row it builds. The page's own script keeps
// wiring those controls exactly as before — this file only owns layout,
// navigation chrome and the (new) AKBAL OK status panel.
//
// Must run AFTER i18n.js and BEFORE the page's own script (and before
// wd-notify.js, which looks up `.hdr-right` once at load): app.js's
// `.tab-btn` click-wiring and gps.js/wardrive.js/wifiradar.js's
// `--header-height` measurement both read the DOM this script builds, ssin
// esperar DOMContentLoaded — todo corre sync al cargar el script.
"use strict";

(function () {
  const DRAWER_BREAKPOINT = 900; // ≤ this width: hamburger + drawer, nav/lang/bell/AKBAL OK live inside it

  const header = document.getElementById("topbar");
  if (!header) return;
  const page = header.dataset.page || ""; // "chat" (= index.html, the app shell) | "wardrive" | "wifiradar" | "gps" | "aircraft-radar" | "crack-station" | "about"
  const isShell = page === "chat";

  // ---- Nav structure — same destinations as the old flat 9-item list,
  // just grouped. "panel" items only exist as in-page tab-panels on the
  // shell (index.html); everywhere else they're a hash-link back to it.
  // "page" items are real standalone pages; on their own page they render
  // as the current, non-clickable item (same as the old markup did). ----
  const NAV = [
    { kind: "panel", id: "chat", labelKey: "topbar.tab_chat", fallback: "IA Local" },
    {
      kind: "group", id: "recon", labelKey: "topbar.nav_recon", fallback: "Recon",
      children: [
        { kind: "page", id: "wifiradar", href: "/wifiradar", labelKey: "topbar.tab_wifiradar", titleKey: "topbar.tab_wifiradar_title", fallback: "Radar Wi-Fi" },
        { kind: "page", id: "aircraft-radar", href: "/aircraft-radar", labelKey: "topbar.tab_aircraft", titleKey: "topbar.tab_aircraft_title", fallback: "Radar de Aviones" },
        { kind: "page", id: "gps", href: "/gps", labelKey: "topbar.tab_gps", titleKey: "topbar.tab_gps_title", fallback: "GPS" },
      ],
    },
    {
      kind: "group", id: "wifi", labelKey: "topbar.nav_wifi", fallback: "Wi-Fi",
      children: [
        { kind: "panel", id: "wifi-audit", labelKey: "topbar.tab_wifiaudit", fallback: "Wifi Audit" },
        { kind: "page", id: "wardrive", href: "/wardrive", labelKey: "topbar.tab_wardrive", titleKey: "topbar.tab_wardrive_title", fallback: "Wardrive" },
        { kind: "page", id: "crack-station", href: "/crack-station", labelKey: "topbar.tab_crackstation", titleKey: "topbar.tab_crackstation_title", fallback: "Crack Station" },
      ],
    },
    {
      kind: "group", id: "games", labelKey: "topbar.nav_games", fallback: "Juegos",
      children: [
        { kind: "page", id: "doom", href: "/doom", labelKey: "topbar.tab_doom", titleKey: "topbar.tab_doom_title", fallback: "DOOM" },
      ],
    },
    { kind: "panel", id: "music", labelKey: "topbar.tab_music", fallback: "Jukebox" },
    { kind: "panel", id: "settings", labelKey: "topbar.tab_settings", fallback: "Ajustes" },
    { kind: "page", id: "about", href: "/about", labelKey: "topbar.tab_about", titleKey: "topbar.tab_about_title", fallback: "Acerca de" },
  ];

  const t = (key, fallback, vars) => (window.AkbalI18n ? window.AkbalI18n.t(key, vars) : null) || fallback;

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  // ---- Leaf item (same classes/attrs the old markup used — app.js's
  // `.tab-btn` click-wiring and i18n.js both key off these, unchanged). ----
  function renderLeaf(item) {
    const label = t(item.labelKey, item.fallback);
    if (item.kind === "panel") {
      if (isShell) {
        return `<button type="button" class="tab-btn" data-tab="${item.id}" data-i18n="${item.labelKey}" role="menuitem">${label}</button>`;
      }
      return `<a href="/#${item.id}" class="tab-link" data-i18n="${item.labelKey}" role="menuitem">${label}</a>`;
    }
    // kind === "page"
    if (page === item.id) {
      return `<span class="tab-link active" data-i18n="${item.labelKey}" aria-current="page">${label}</span>`;
    }
    const titleAttr = item.titleKey ? ` title="${escapeAttr(t(item.titleKey, ""))}" data-i18n-title="${item.titleKey}"` : "";
    return `<a href="${item.href}" class="tab-link" data-i18n="${item.labelKey}"${titleAttr} role="menuitem">${label}</a>`;
  }

  function groupHasActiveChild(group) {
    return group.children.some((c) => c.kind === "page" && c.id === page);
  }

  // ---- Desktop: flat items inline, groups as click-to-open dropdowns ----
  function renderDesktopNav() {
    return NAV.map((item) => {
      if (item.kind !== "group") return renderLeaf(item);
      const active = groupHasActiveChild(item) ? " active" : "";
      const label = t(item.labelKey, item.fallback);
      return `
        <div class="nav-group" data-group="${item.id}">
          <button type="button" class="tab-btn nav-group-trigger${active}" aria-haspopup="true" aria-expanded="false" data-i18n="${item.labelKey}">${label} <span class="nav-caret">▾</span></button>
          <div class="nav-dropdown" role="menu">
            ${item.children.map(renderLeaf).join("")}
          </div>
        </div>`;
    }).join("");
  }

  // ---- Mobile/tablet drawer: flat items + accordions for the 2 groups ----
  function renderDrawerNav() {
    return NAV.map((item) => {
      if (item.kind !== "group") return `<div class="drawer-item">${renderLeaf(item)}</div>`;
      const label = t(item.labelKey, item.fallback);
      const open = groupHasActiveChild(item) ? " open" : "";
      return `
        <div class="drawer-accordion${open}" data-group="${item.id}">
          <button type="button" class="drawer-accordion-trigger" aria-expanded="${open ? "true" : "false"}">
            <span data-i18n="${item.labelKey}">${label}</span><span class="nav-caret">▾</span>
          </button>
          <div class="drawer-accordion-body">
            ${item.children.map(renderLeaf).join("")}
          </div>
        </div>`;
    }).join("");
  }

  // ---- hdr-right (lang dropdown + bell mount + AKBAL OK) — same markup
  // regardless of desktop/drawer; only its PARENT moves (see layoutHdrRight
  // below), so wd-notify.js's one-time `.hdr-right` lookup always finds it. ----
  function renderHdrRight() {
    return `
      <div class="hdr-right" id="hdr-right">
        <div class="lang-dd" id="lang-toggle" title="${escapeAttr(t("topbar.lang_title", "Idioma / Language"))}" data-i18n-title="topbar.lang_title">
          <button type="button" class="lang-dd-trigger" aria-haspopup="true" aria-expanded="false">
            <span id="lang-dd-current">ES</span> <span class="nav-caret">▾</span>
          </button>
          <div class="lang-dd-menu" role="menu">
            <button type="button" class="plx-toggle-label" data-lang="es" role="menuitem">Español</button>
            <button type="button" class="plx-toggle-label" data-lang="en" role="menuitem">English</button>
          </div>
        </div>
        <button type="button" id="sys-toggle" class="akbal-ok" title="${escapeAttr(t("topbar.system_title", "Estado del sistema"))}" data-i18n-title="topbar.system_title" aria-haspopup="true" aria-expanded="false">
          <span class="akbal-ok-dot" id="akbal-ok-dot"></span>
          <span class="akbal-ok-label" id="akbal-ok-label">AKBAL OK</span>
        </button>
        <div id="sys-popover" class="popover akbal-ok-panel hidden" role="menu">
          <div class="popover-title" data-i18n="topbar.popover_system">Sistema</div>
          <div class="metric-row"><span class="metric-key" data-i18n="topbar.model">Modelo</span><span class="metric-val mono" id="hdr-model-full">—</span></div>
          <div class="metric-row"><span class="metric-key" data-i18n="topbar.wifi">Wi-Fi</span><span class="metric-val" id="hdr-wifi">—</span></div>
          <div class="metric-row"><span class="metric-key" data-i18n="topbar.stat_gps">GPS</span><span class="metric-val" id="stat-gps">—</span></div>
          <div class="metric-row"><span class="metric-key" data-i18n="topbar.stat_hackrf">HackRF</span><span class="metric-val" id="stat-hackrf">—</span></div>
          <div class="metric-row"><span class="metric-key" data-i18n="topbar.battery_title">Batería</span><span class="metric-val mono" id="akbal-ok-battery">—</span></div>
          <div class="metric-row"><span class="metric-key" data-i18n="topbar.stat_audio">Audio</span><span class="metric-val" id="stat-audio">—</span></div>
          <div class="metric-row"><span class="metric-key" data-i18n="topbar.cpu">CPU</span><span class="metric-val mono" id="stat-cpu">—</span></div>
          <div class="metric-row"><span class="metric-key" data-i18n="topbar.ram">RAM</span><span class="metric-val mono" id="stat-ram">—</span></div>
          <div class="metric-row"><span class="metric-key" data-i18n="topbar.stat_temp">Temperatura</span><span class="metric-val mono" id="stat-temp">—</span></div>
          <div class="metric-row"><span class="metric-key" data-i18n="topbar.disk">Disco</span><span class="metric-val mono" id="stat-disk">—</span></div>
          <div class="metric-row"><span class="metric-key" data-i18n="topbar.stat_ip">IP</span><span class="metric-val mono" id="stat-ip">—</span></div>
          <div class="popover-sep"></div>
          <button id="logout-btn" type="button" class="btn btn-tertiary btn-block" title="${escapeAttr(t("topbar.logout", "Cerrar sesión"))}" data-i18n="topbar.logout" data-i18n-title="topbar.logout">Cerrar sesión</button>
        </div>
        <!-- Hidden data sinks for the elements the old per-page loadStatus()
             copies wrote to (hdr-model/battery-indicator/hdr-online-dot) —
             DELETED on purpose would NOT be safe: each page's own script
             still runs its own trimmed status refresh against these exact
             ids (see wardrive.js/gps.js/wifiradar.js/aircraft-radar.js/
             crack-station.js/app.js). Rather than touch 6 files' fetch
             logic, these stay as real (if invisible) elements so those
             writes keep landing somewhere harmless instead of throwing. -->
        <span class="sr-only" id="hdr-online-dot"></span>
        <span class="sr-only" id="hdr-model"></span>
        <span class="sr-only battery-indicator" id="battery-indicator"><span id="battery-icon"></span><span id="battery-pct"></span></span>
      </div>`;
  }

  // ---- Build ----
  const avatarSrc = document.getElementById("avatar")?.getAttribute("src") || "/avatar/standing.gif";
  header.innerHTML = `
    <div class="navbar">
      <div class="brand-group">
        <a href="/" class="brand-link" aria-label="AKBAL — inicio">
          <img id="avatar" class="avatar" src="${escapeAttr(avatarSrc)}" alt="Akbal" />
          <span class="brand">AKBAL</span>
        </a>
      </div>
      <nav class="tabs" id="main-tabs" role="menubar">${renderDesktopNav()}</nav>
      ${renderHdrRight()}
      <button type="button" id="mobile-dot" class="mobile-dot" title="${escapeAttr(t("topbar.akbal_ok", "AKBAL OK"))}" aria-label="${escapeAttr(t("topbar.akbal_ok", "AKBAL OK"))}">
        <span class="akbal-ok-dot" id="mobile-dot-indicator"></span>
      </button>
      <button type="button" id="nav-toggle" class="nav-toggle" aria-label="Menú" data-i18n-aria-label="topbar.menu_aria" aria-expanded="false" aria-controls="nav-drawer">
        <span></span><span></span><span></span>
      </button>
    </div>
    <div id="page-toolbar" class="page-toolbar hidden"></div>
    <div id="nav-backdrop" class="nav-backdrop hidden"></div>
    <div id="nav-drawer" class="nav-drawer" aria-hidden="true">
      <div class="nav-drawer-head">
        <span class="brand">AKBAL</span>
        <button type="button" id="drawer-close" class="drawer-close" aria-label="${escapeAttr(t("topbar.drawer_close", "Cerrar menú"))}" data-i18n-aria-label="topbar.drawer_close">✕</button>
      </div>
      <nav class="drawer-nav" id="drawer-nav">${renderDrawerNav()}</nav>
      <div class="drawer-hdr-right-mount" id="drawer-hdr-right-mount"></div>
    </div>`;

  // Relocate any page-specific controls (LIVE/DEMO, view toggle, dongle
  // picker...) the page's own HTML provided, exact nodes (not clones) —
  // whatever JS that page already wired against them keeps working
  // untouched, since the elements/ids never change, only their parent.
  const pageControls = document.getElementById("page-toolbar-controls");
  const toolbar = document.getElementById("page-toolbar");
  if (pageControls && pageControls.children.length) {
    toolbar.appendChild(pageControls);
    pageControls.classList.remove("hidden");
    toolbar.classList.remove("hidden");
  }

  if (window.AkbalI18n) window.AkbalI18n.applyTranslations(header);

  // ---- Drawer open/close — declared before layoutHdrRight below, which
  // calls closeDrawer() on every breakpoint crossing back into desktop. ----
  const drawer = document.getElementById("nav-drawer");
  const backdrop = document.getElementById("nav-backdrop");
  const navToggle = document.getElementById("nav-toggle");

  function closeDrawer() {
    drawer.classList.remove("open");
    backdrop.classList.add("hidden");
    drawer.setAttribute("aria-hidden", "true");
    navToggle.setAttribute("aria-expanded", "false");
    for (const acc of drawer.querySelectorAll(".drawer-accordion.open")) {
      if (!groupHasActiveChild(NAV.find((n) => n.id === acc.dataset.group) || {})) {
        acc.classList.remove("open");
        acc.querySelector(".drawer-accordion-trigger")?.setAttribute("aria-expanded", "false");
      }
    }
  }
  function openDrawer() {
    drawer.classList.add("open");
    backdrop.classList.remove("hidden");
    drawer.setAttribute("aria-hidden", "false");
    navToggle.setAttribute("aria-expanded", "true");
  }
  navToggle.addEventListener("click", () => {
    if (drawer.classList.contains("open")) closeDrawer();
    else openDrawer();
  });
  backdrop.addEventListener("click", closeDrawer);
  document.getElementById("drawer-close")?.addEventListener("click", closeDrawer);
  document.getElementById("mobile-dot")?.addEventListener("click", openPanel);

  drawer.querySelectorAll(".drawer-accordion-trigger").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const acc = trigger.closest(".drawer-accordion");
      const nowOpen = !acc.classList.contains("open");
      acc.classList.toggle("open", nowOpen);
      trigger.setAttribute("aria-expanded", String(nowOpen));
    });
  });
  // Any nav item inside the drawer (leaf tab-btn/tab-link) closes it —
  // same UX the old mobile dropdown had.
  drawer.querySelectorAll(".tab-btn, .tab-link").forEach((el) => {
    el.addEventListener("click", closeDrawer);
  });

  // ---- hdr-right lives inline in the navbar on desktop, inside the
  // drawer on mobile/tablet — same node (bell included), just re-parented
  // on breakpoint crossings so wd-notify.js's one-time lookup never needs
  // to run twice. ----
  const hdrRight = document.getElementById("hdr-right");
  const navbar = header.querySelector(".navbar");
  const drawerMount = document.getElementById("drawer-hdr-right-mount");
  const mq = window.matchMedia(`(max-width: ${DRAWER_BREAKPOINT}px)`);
  function layoutHdrRight() {
    if (mq.matches) {
      if (hdrRight.parentElement !== drawerMount) drawerMount.appendChild(hdrRight);
    } else {
      if (hdrRight.parentElement !== navbar) navbar.insertBefore(hdrRight, header.querySelector("#mobile-dot"));
      closeDrawer(); // crossing back into desktop width — the drawer doesn't apply anymore
    }
  }
  layoutHdrRight();
  (mq.addEventListener ? mq.addEventListener.bind(mq) : mq.addListener.bind(mq))("change", layoutHdrRight);

  // ---- Desktop dropdown groups: click to open, click-outside/Escape to
  // close, only one open at a time. ----
  const groups = header.querySelectorAll(".nav-group");
  function closeAllGroups(except) {
    groups.forEach((g) => {
      if (g === except) return;
      g.classList.remove("open");
      g.querySelector(".nav-group-trigger")?.setAttribute("aria-expanded", "false");
    });
  }
  groups.forEach((g) => {
    const trigger = g.querySelector(".nav-group-trigger");
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const nowOpen = !g.classList.contains("open");
      closeAllGroups();
      g.classList.toggle("open", nowOpen);
      trigger.setAttribute("aria-expanded", String(nowOpen));
    });
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".nav-group")) closeAllGroups();
  });

  // ---- Active-state tracking for the shell page's in-page panels — the
  // group trigger (Recon/Wi-Fi) highlights when the current panel is one
  // of its children, same as a "page" child already does statically. ----
  if (isShell) {
    function syncActivePanel(panelId) {
      header.querySelectorAll(".nav-group-trigger").forEach((trig) => {
        const groupId = trig.closest(".nav-group")?.dataset.group;
        const group = NAV.find((n) => n.id === groupId);
        const active = Boolean(group?.children.some((c) => c.kind === "panel" && c.id === panelId));
        trig.classList.toggle("active", active);
      });
    }
    header.querySelectorAll('.tab-btn[data-tab], .drawer-item .tab-btn[data-tab], .drawer-accordion-body .tab-btn[data-tab]').forEach((btn) => {
      btn.addEventListener("click", () => syncActivePanel(btn.dataset.tab));
    });
    window.addEventListener("hashchange", () => syncActivePanel(location.hash.replace("#", "") || "chat"));
    syncActivePanel(location.hash.replace("#", "") || "chat");
  }

  // ---- Lang dropdown (skin only — i18n.js's own #lang-toggle delegation
  // still does the actual switching via [data-lang], unchanged). ----
  const langDd = document.getElementById("lang-toggle");
  const langTrigger = langDd?.querySelector(".lang-dd-trigger");
  const langCurrent = document.getElementById("lang-dd-current");
  langTrigger?.addEventListener("click", (e) => {
    e.stopPropagation();
    const nowOpen = !langDd.classList.contains("open");
    closeAllGroups();
    langDd.classList.toggle("open", nowOpen);
    langTrigger.setAttribute("aria-expanded", String(nowOpen));
  });
  document.addEventListener("click", (e) => {
    if (langDd && !langDd.contains(e.target)) langDd.classList.remove("open");
  });
  document.addEventListener("akbal:locale-changed", (ev) => {
    if (langCurrent) langCurrent.textContent = (ev.detail?.locale || "es").toUpperCase();
    langDd?.classList.remove("open");
    void refreshPanel(); // re-translate the AKBAL OK label/panel text right away, not on the next 60s poll
  });
  if (window.AkbalI18n?.getLocale() && langCurrent) {
    langCurrent.textContent = window.AkbalI18n.getLocale().toUpperCase();
  }

  // ---- AKBAL OK panel (sys-toggle/sys-popover, same ids the old sys
  // popover used — toggle/close behavior re-implemented once here instead
  // of 6 times). Escape now closes it too (the old version never had
  // that). ----
  const sysToggle = document.getElementById("sys-toggle");
  const sysPopover = document.getElementById("sys-popover");
  function openPanel() {
    closeAllGroups();
    langDd?.classList.remove("open");
    sysPopover.classList.remove("hidden");
    sysToggle.setAttribute("aria-expanded", "true");
    void refreshPanel();
  }
  function closePanel() {
    sysPopover.classList.add("hidden");
    sysToggle.setAttribute("aria-expanded", "false");
  }
  sysToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (sysPopover.classList.contains("hidden")) openPanel();
    else closePanel();
  });
  document.addEventListener("click", (e) => {
    if (!sysPopover.contains(e.target) && e.target !== sysToggle && !e.target.closest("#mobile-dot")) closePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closePanel();
    closeDrawer();
    closeAllGroups();
    langDd?.classList.remove("open");
  });
  document.getElementById("logout-btn")?.addEventListener("click", async () => {
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch { /* ignore */ }
    window.location.href = "/login";
  });

  // ---- Panel data: model/wifi/battery already come from /api/status (same
  // shape every page already fetched independently) — GPS/HackRF/audio/
  // temp/ip are the new fields the spec asked for, combined here instead
  // of adding a bespoke aggregate endpoint. ----
  const setTxt = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  function gpsLabel(gps) {
    if (!gps || !gps.present) return t("topbar.stat_gps_none", "No detectado");
    if (gps.hasFix) return t("topbar.stat_gps_fix", "Fix · {n} sat", { n: gps.satellitesUsed ?? "—" });
    return t("topbar.stat_gps_searching", "Buscando fix...");
  }
  function hackrfLabel(snapshot) {
    if (snapshot?.hardware) return snapshot.hardware;
    if (snapshot?.demo) return t("topbar.stat_hackrf_demo", "DEMO (sin hardware)");
    return t("topbar.stat_hackrf_none", "No conectado");
  }
  function audioLabel(data) {
    const opt = (data.audioOptions || []).find((o) => o.key === data.status?.audioOutput);
    return opt?.label || data.status?.audioOutput || "—";
  }

  async function refreshPanel() {
    let status = null, gps = null, aircraft = null, audio = null;
    try {
      [status, gps, aircraft, audio] = await Promise.all([
        fetch("/api/status").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/gps/summary").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/aircraft").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/audio-output/options").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
    } catch { /* handled per-field below */ }

    const online = Boolean(status);
    document.getElementById("akbal-ok-dot")?.classList.toggle("online", online);

    setTxt("hdr-model-full", status?.model || "—");
    const wifiLabel = status?.wifi?.connected ? status.wifi.ssid : t("topbar.stat_wifi_off", "sin wifi");
    setTxt("hdr-wifi", wifiLabel);
    setTxt("stat-gps", gpsLabel(gps));
    setTxt("stat-hackrf", hackrfLabel(aircraft));
    const battery = status?.battery;
    setTxt("akbal-ok-battery", !battery || !battery.connected || battery.level == null
      ? "N/A"
      : `${battery.charging ? "⚡" : "🔋"} ${battery.level}%`);
    setTxt("stat-audio", audio ? audioLabel({ status, audioOptions: audio.options }) : "—");
    const sys = status?.system;
    setTxt("stat-cpu", sys ? `${sys.cpuPercent}%` : "—");
    setTxt("stat-ram", sys ? `${Math.round(sys.ram.percent)}%` : "—");
    setTxt("stat-disk", sys ? `${Math.round(sys.disk.percent)}%` : "—");
    setTxt("stat-temp", sys?.cpuTempC != null ? `${sys.cpuTempC.toFixed(1)}°C` : "—");
    setTxt("stat-ip", status?.ip || "—");

    // "Problems" = hardware the spec explicitly named (GPS/HackRF/Wi-Fi)
    // that's genuinely missing — not transient states like "buscando fix"
    // or a battery-less install (PiSugar is optional hardware). The worded
    // alert ("2 dispositivos faltantes") lives ONLY in the notification
    // bell now (wd-notify.js, via the akbal:problems-changed event below)
    // — this panel stays a plain status readout, and the pill itself only
    // ever says "AKBAL OK" / "sin conexión", never a problem count; the dot
    // color is the only in-place signal.
    const problems = [];
    if (status && !status.wifi?.connected) {
      problems.push({ id: "problem:wifi", message: t("topbar.problem_wifi", "Wi-Fi desconectado"), href: "/#settings" });
    }
    if (gps && !gps.present) {
      problems.push({ id: "problem:gps", message: t("topbar.problem_gps", "GPS no detectado"), href: "/gps" });
    }
    if (aircraft && !aircraft.hardware && !aircraft.demo) {
      problems.push({ id: "problem:hackrf", message: t("topbar.problem_hackrf", "HackRF no conectado"), href: "/aircraft-radar" });
    }
    document.dispatchEvent(new CustomEvent("akbal:problems-changed", { detail: { problems, online } }));

    const dot = document.getElementById("akbal-ok-dot");
    const mobileDot = document.getElementById("mobile-dot-indicator");
    const label = document.getElementById("akbal-ok-label");
    if (!online) {
      dot?.classList.remove("ok", "warn");
      mobileDot?.classList.remove("ok", "warn");
      if (label) label.textContent = t("topbar.offline", "sin conexión");
    } else if (problems.length) {
      dot?.classList.add("warn");
      dot?.classList.remove("ok");
      mobileDot?.classList.add("warn");
      mobileDot?.classList.remove("ok");
      if (label) label.textContent = t("topbar.akbal_ok", "AKBAL OK");
    } else {
      dot?.classList.add("ok");
      dot?.classList.remove("warn");
      mobileDot?.classList.add("ok");
      mobileDot?.classList.remove("warn");
      if (label) label.textContent = t("topbar.akbal_ok", "AKBAL OK");
    }
  }

  void refreshPanel();
  setInterval(() => {
    if (!document.hidden) void refreshPanel();
  }, 60000);

  window.AkbalTopbar = { openDrawer, closeDrawer, openPanel, closePanel };
})();
