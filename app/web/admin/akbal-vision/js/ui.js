// Pure: decides boot overlay text + whether to hide it. Once booting is `done`,
// a failed step renders a legible SYSTEM ERROR instead of a frozen spinner
// (the overlay is opaque and full-screen, so a hang would hide the EVENT LOG).
export function bootView(steps, done = false) {
  const allOk = steps.every((s) => s.ok);
  const line = (s) => `${s.label.padEnd(12, ".")} ${s.ok ? "OK" : done ? "FAIL" : "…"}`;
  let footer = "";
  if (allOk) footer = "\n\nLOCAL PROCESSING ENABLED\nSYSTEM READY";
  else if (done) footer = `\n\nSYSTEM ERROR\n${steps.filter((s) => !s.ok).map((s) => s.label).join(", ")} — revisa EVENT LOG`;
  return { text: "AKBAL VISION\n\n" + steps.map(line).join("\n") + footer, hidden: allOk };
}

const pad = (n) => String(n).padStart(2, "0");
const clock = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const fmtVisible = (ms) => { const s = Math.floor(ms / 1000); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };

export function createUI({ root, bus, config, camera }) {
  root.innerHTML = `
    <section class="av-panel av-target" id="av-target"></section>
    <section class="av-panel av-log"><h2>EVENT LOG</h2><ul id="av-log-list"></ul></section>
    <section class="av-panel av-settings" id="av-settings">
      <h2>AKBAL VISION</h2>
      <label>CÁMARA <select id="av-cam"></select></label>
      <label>MODO <select id="av-mode">
        <option>HIGH</option><option>BALANCED</option><option>LOW</option></select></label>
      <label><input type="checkbox" id="av-debug-toggle"> DEBUG</label>
      <button id="av-full">FULLSCREEN</button>
      <p class="av-privacy">LOCAL PROCESSING · NO VIDEO UPLOAD</p>
    </section>
    <section class="av-panel av-debug-stats hidden" id="av-debug-stats"></section>
    <pre class="av-boot" id="av-boot"></pre>`;

  const logList = root.querySelector("#av-log-list");
  const lines = [];
  root.querySelector("#av-mode").value = config.mode;
  root.querySelector("#av-debug-toggle").checked = config.debug;

  root.querySelector("#av-mode").addEventListener("change", (e) => { config.setMode(e.target.value); location.reload(); });
  root.querySelector("#av-cam").addEventListener("change", (e) => camera.start(e.target.value));
  root.querySelector("#av-debug-toggle").addEventListener("change", (e) => {
    config.setDebug(e.target.checked);
    root.querySelector("#av-debug-stats").classList.toggle("hidden", !e.target.checked);
  });
  root.querySelector("#av-full").addEventListener("click", () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  return {
    boot(steps, done = false) {
      const v = bootView(steps, done);
      const el = root.querySelector("#av-boot");
      el.textContent = v.text;
      el.classList.toggle("av-boot-error", done && !v.hidden);
      if (v.hidden) setTimeout(() => el.classList.add("hidden"), 800);
      else el.classList.remove("hidden");
    },
    renderTarget(snapshot) {
      const p = snapshot.subjects[snapshot.primaryId];
      const el = root.querySelector("#av-target");
      if (!p) { el.innerHTML = `<h2>TARGET</h2><p class="muted">NO SUBJECT</p>`; return; }
      el.innerHTML = `<h2>TARGET</h2>
        <div class="av-id">${p.id}</div>
        <dl>
          <dt>STATUS</dt><dd>TRACKING</dd>
          <dt>CONFIDENCE</dt><dd>${(p.confidence * 100).toFixed(1)}%</dd>
          <dt>VISIBLE</dt><dd>${fmtVisible(p.visibleForMs)}</dd>
          <dt>ORIENTATION</dt><dd class="muted">${p.orientation}</dd>
          <dt>EYE CONTACT</dt><dd class="muted">${p.eyeContact}</dd>
          <dt>MOTION</dt><dd class="muted">${p.motion}</dd>
        </dl>`;
    },
    logEvent(text) {
      lines.push(`${clock()} ${text}`);
      while (lines.length > 20) lines.shift();
      logList.innerHTML = lines.map((l) => `<li>${l}</li>`).join("");
    },
    setDevices(list) {
      const sel = root.querySelector("#av-cam");
      sel.innerHTML = list.map((d) => `<option value="${d.deviceId}">${d.label}</option>`).join("");
      if (config.cameraId) sel.value = config.cameraId;
    },
    setDebug(stats) {
      root.querySelector("#av-debug-stats").textContent =
        `CAMERA ${stats.cameraFps} FPS\nVISION ${stats.visionFps} FPS\nRENDER ${stats.renderFps} FPS\nINFERENCE ${stats.inferenceMs} ms\nFACES ${stats.faces}`;
    },
  };
}
