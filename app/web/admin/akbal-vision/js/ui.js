import { buildReport, LEGEND } from "./report.js";

// Pure: decides boot overlay text + whether to hide it (Hito 1).
export function bootView(steps, done = false) {
  const allOk = steps.every((s) => s.ok);
  const line = (s) => `${s.label.padEnd(12, ".")} ${s.ok ? "OK" : done ? "FAIL" : "…"}`;
  let footer = "";
  if (allOk) footer = "\n\nLOCAL PROCESSING ENABLED\nSYSTEM READY";
  else if (done) footer = `\n\nSYSTEM ERROR\n${steps.filter((s) => !s.ok).map((s) => s.label).join(", ")} — revisa EVENT LOG`;
  return { text: "AKBAL VISION\n\n" + steps.map(line).join("\n") + footer, hidden: allOk };
}

const pad = (n) => String(n).padStart(2, "0");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tr = (key, fallback) => {
  const v = typeof window !== "undefined" && window.AkbalI18n ? window.AkbalI18n.t(key) : null;
  return v && v !== key ? v : fallback;
};
const clockText = () => {
  const d = new Date();
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function createUI({ root, bus, config, camera }) {
  root.innerHTML = `
    <header class="av-topline">
      <span class="av-brand">AKBAL VISION</span>
      <span class="av-live">● LIVE</span>
      <span class="av-cam">CAM-01</span>
      <time class="av-clock" id="av-clock"></time>
    </header>
    <section class="av-expediente" id="av-expediente"></section>
    <div class="av-labels" id="av-labels"></div>
    <div class="av-legend" id="av-legend">${esc(LEGEND)}</div>
    <section class="av-controls" id="av-settings">
      <label><span data-i18n="akbalvision.camera">CÁMARA</span> <select id="av-cam"></select></label>
      <label><span data-i18n="akbalvision.mode">MODO</span> <select id="av-mode"><option>HIGH</option><option>BALANCED</option><option>LOW</option></select></label>
      <label><input type="checkbox" id="av-debug-toggle"> <span data-i18n="akbalvision.debug">DEBUG</span></label>
      <button id="av-full" data-i18n="akbalvision.fullscreen">FULLSCREEN</button>
    </section>
    <section class="av-log"><h2 data-i18n="akbalvision.event_log">EVENT LOG</h2><ul id="av-log-list"></ul></section>
    <div class="av-acquired hidden" id="av-acquired"></div>
    <pre class="av-boot" id="av-boot"></pre>`;

  if (typeof window !== "undefined" && window.AkbalI18n) {
    window.AkbalI18n.applyTranslations(root);
    window.AkbalI18n.ready?.then(() => window.AkbalI18n.applyTranslations(root));
  }

  const logList = root.querySelector("#av-log-list");
  const lines = [];
  root.querySelector("#av-mode").value = config.mode;
  root.querySelector("#av-debug-toggle").checked = config.debug;
  root.querySelector("#av-mode").addEventListener("change", (e) => { config.setMode(e.target.value); location.reload(); });
  root.querySelector("#av-cam").addEventListener("change", (e) => camera.start(e.target.value));
  root.querySelector("#av-debug-toggle").addEventListener("change", (e) => config.setDebug(e.target.checked));
  root.querySelector("#av-full").addEventListener("click", () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  const row = (r) => `<div class="av-row"><span class="av-k">${esc(r.label)}</span><span class="av-v">${esc(r.value)}${r.confidence != null ? ` <em>${Math.round(r.confidence * 100)}% EST.</em>` : ""}</span></div>`;

  return {
    boot(steps, done = false) {
      const v = bootView(steps, done);
      const el = root.querySelector("#av-boot");
      el.textContent = v.text;
      el.classList.toggle("av-boot-error", done && !v.hidden);
      if (v.hidden) setTimeout(() => el.classList.add("hidden"), 800);
      else el.classList.remove("hidden");
    },
    setClock() { root.querySelector("#av-clock").textContent = clockText(); },
    renderTarget(snapshot, perf) {
      const p = snapshot.subjects[snapshot.primaryId];
      const el = root.querySelector("#av-expediente");
      const sys = `
        <h3>SYSTEM METRICS</h3>
        ${row({ label: "CAMERA", value: `${perf?.cameraFps ?? 0} FPS` })}
        ${row({ label: "VISION", value: `${perf?.visionFps ?? 0} FPS` })}
        ${row({ label: "RENDER", value: `${perf?.renderFps ?? 0} FPS` })}
        ${row({ label: "INFERENCE", value: `${perf?.inferenceMs ?? 0} ms` })}
        ${row({ label: "FACES", value: String(perf?.faces ?? 0) })}
        ${row({ label: "RESOLUTION", value: perf?.resolution || "—" })}`;
      const privacy = `<h3>PRIVACY</h3><div class="av-priv">LOCAL PROCESSING<br>NO VIDEO UPLOAD<br>NO IMAGE STORAGE</div>`;
      if (!p) {
        el.innerHTML = `<h2>AKBAL VISION</h2><div class="av-id muted">NO SUBJECT</div>${sys}${privacy}`;
        return;
      }
      const rep = buildReport(p);
      el.innerHTML = `
        <h2>AKBAL VISION</h2>
        <h3>TRACK RECORD</h3><div class="av-id">${esc(p.id)}</div>
        <h3>MEASURED</h3>${rep.measured.map(row).join("")}
        <h3>PROBABILISTIC ANALYSIS</h3>${rep.estimated.map(row).join("")}
        ${sys}${privacy}`;
    },
    renderLabels(snapshot, metrics) {
      const container = root.querySelector("#av-labels");
      const seen = new Set();
      for (const s of Object.values(snapshot.subjects)) {
        if (s.isPrimary) continue;
        seen.add(s.id);
        let el = container.querySelector(`[data-id="${s.id}"]`);
        if (!el) { el = document.createElement("div"); el.className = "av-flabel"; el.dataset.id = s.id; container.appendChild(el); }
        const t = metrics.map(s.bbox);
        el.style.transform = `translate(${t.x}px, ${t.y}px)`;
        const secs = Math.floor((s.visibleForMs || 0) / 1000);
        el.textContent = `${s.id} · TRACK ${s.trackQuality ?? 0}% · ${s.gaze || "UNKNOWN"} · Y${Math.round(s.pose?.yaw ?? 0)}° · ${pad(Math.floor(secs / 60))}:${pad(secs % 60)}`;
      }
      for (const el of [...container.children]) if (!seen.has(el.dataset.id)) el.remove();
    },
    flashAcquired(text) {
      const el = root.querySelector("#av-acquired");
      el.textContent = text;
      el.classList.remove("hidden");
      el.classList.remove("av-flash");
      void el.offsetWidth; // restart the CSS animation
      el.classList.add("av-flash");
      setTimeout(() => el.classList.add("hidden"), 1300);
    },
    logEvent(text) {
      lines.push(`${pad(new Date().getHours())}:${pad(new Date().getMinutes())}:${pad(new Date().getSeconds())} ${text}`);
      while (lines.length > 20) lines.shift();
      logList.innerHTML = lines.map((l) => `<li>${esc(l)}</li>`).join("");
    },
    setDevices(list) {
      const sel = root.querySelector("#av-cam");
      sel.innerHTML = list.map((d) => `<option value="${esc(d.deviceId)}">${esc(d.label)}</option>`).join("");
      if (config.cameraId) sel.value = config.cameraId;
    },
    debugEnabled() { return config.debug; },
  };
}
