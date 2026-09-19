// Akbal web admin — chat with the local Ollama models, manage wifi. Plain
// JS, no build step (this is served as-is from app/web/admin/, see
// device/web-admin-server.ts) — matches how web/whisplay-display/ is done.

const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const chatCancel = document.getElementById("chat-cancel");
const modelSelect = document.getElementById("model-select");
const statusPill = document.getElementById("status-pill");
const avatar = document.getElementById("avatar");
const batteryIndicator = document.getElementById("battery-indicator");
const batteryIcon = document.getElementById("battery-icon");
const batteryPct = document.getElementById("battery-pct");
const statCpu = document.getElementById("stat-cpu");
const statRam = document.getElementById("stat-ram");
const statDisk = document.getElementById("stat-disk");
const logoutBtn = document.getElementById("logout-btn");
const modelLoadIndicator = document.getElementById("model-load-indicator");
const unloadModelBtn = document.getElementById("unload-model-btn");
const audioOutputSelect = document.getElementById("audio-output-select");
const audioOutputRefreshBtn = document.getElementById("audio-output-refresh");
const btPairedList = document.getElementById("bt-paired-list");
const btScanBtn = document.getElementById("bt-scan-btn");
const btScanStatus = document.getElementById("bt-scan-status");
const btFoundList = document.getElementById("bt-found-list");

logoutBtn.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/login";
});

// The session cookie can expire (or the server can restart, which throws
// away the in-memory signing key — see web-admin-server.ts) while this
// page is still open; a 401 on any API call means "log in again", not a
// transient error.
async function apiFetch(input, init) {
  const res = await fetch(input, init);
  if (res.status === 401) {
    window.location.href = "/login";
  }
  return res;
}

let history = [];
let sending = false;
let activeController = null;

function setSendingUi(isSending) {
  sending = isSending;
  chatSend.disabled = isSending;
  chatCancel.classList.toggle("hidden", !isSending);
}

// Same still/talking GIFs the physical screen animates between — see
// docs/display-ui.md. Toggling the <img> src (not just hiding/showing)
// restarts the animation from frame 0 each time, which is what we want.
// Kept separate from setSendingUi: the avatar should keep "thinking" (idle
// gif) while waiting for the model's first token, and only switch to
// "talking" once text is actually printing on screen.
function setAvatarTalking(isTalking) {
  avatar.src = isTalking ? "/avatar/talking.gif" : "/avatar/standing.gif";
}

function updateBatteryIndicator(battery) {
  if (!battery || !battery.connected) {
    batteryPct.textContent = "—";
    batteryIcon.textContent = "🔋";
    batteryIndicator.classList.remove("low", "charging");
    return;
  }
  batteryPct.textContent = `${battery.level}%`;
  batteryIcon.textContent = battery.charging ? "⚡" : "🔋";
  batteryIndicator.classList.toggle("low", battery.level <= 15 && !battery.charging);
  batteryIndicator.classList.toggle("charging", Boolean(battery.charging));
}

function updateSystemStats(system) {
  if (!system) {
    statCpu.textContent = "—";
    statRam.textContent = "—";
    statDisk.textContent = "—";
    statCpu.classList.remove("warn");
    statRam.classList.remove("warn");
    statDisk.classList.remove("warn");
    return;
  }
  statCpu.textContent = `${system.cpuPercent}%`;
  statRam.textContent = `${system.ram.percent}%`;
  statDisk.textContent = `${system.disk.percent}%`;
  statCpu.classList.toggle("warn", system.cpuPercent >= 85);
  statRam.classList.toggle("warn", system.ram.percent >= 85);
  statDisk.classList.toggle("warn", system.disk.percent >= 90);
}

function addMessage(role, text) {
  const empty = document.getElementById("chat-empty");
  if (empty) empty.classList.add("hidden");
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  // System notices (audio/wifi/bluetooth/backup/model/file actions) also surface
  // as a toast so there's feedback outside the Chat view.
  if (role === "system" && typeof toast === "function" && text) {
    const t = text.toLowerCase();
    let kind = "info";
    if (/error|no se pudo|falló|inválid/.test(t)) kind = "error";
    else if (/activ|conect|creado|restaur|elimin|vinculad|guardad|expuls|liberad|listo/.test(t)) kind = "success";
    toast(text, kind);
  }
  return el;
}

async function loadStatus() {
  try {
    const res = await apiFetch("/api/status");
    const data = await res.json();
    const wifiLabel = data.wifi?.connected ? data.wifi.ssid : "sin wifi";
    statusPill.textContent = `${data.model} · ${wifiLabel}`;
    // Compact header summary + system popover.
    setText("hdr-model", data.model || "—");
    setText("hdr-model-full", data.model || "—");
    setText("hdr-wifi", wifiLabel);
    const onlineDot = document.getElementById("hdr-online-dot");
    if (onlineDot) onlineDot.classList.add("online");
    updateBatteryIndicator(data.battery);
    updateSystemStats(data.system);
    modelLoadIndicator.textContent = data.modelLoaded ? "Cargado" : "Descargado";
    modelLoadIndicator.classList.toggle("loaded", Boolean(data.modelLoaded));
    modelLoadIndicator.classList.toggle("ok", Boolean(data.modelLoaded));
    if (data.audioOutput && audioOutputSelect.value !== data.audioOutput) {
      audioOutputSelect.value = data.audioOutput;
    }
    updateSettingsOverview(data);
  } catch {
    statusPill.textContent = "sin conexión con el dispositivo";
    const onlineDot = document.getElementById("hdr-online-dot");
    if (onlineDot) onlineDot.classList.remove("online");
    setText("hdr-model", "sin conexión");
  }
}

// ---- Header system popover ----
(function () {
  const toggle = document.getElementById("sys-toggle");
  const pop = document.getElementById("sys-popover");
  if (!toggle || !pop) return;
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!pop.contains(e.target) && e.target !== toggle) pop.classList.add("hidden");
  });
})();

// ---- Toasts ----
function toast(message, kind = "info") {
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setBar(id, percent) {
  const el = document.getElementById(id);
  if (!el) return;
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  el.style.width = `${p}%`;
  el.classList.toggle("warn", p >= 85);
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

// Fill the redesigned Configuración cards (General/IA/Almacenamiento/Sistema)
// from the /api/status payload.
function updateSettingsOverview(data) {
  const sys = data.system;
  setText("ov-model", data.model || "—");
  setText("ov-wifi", data.wifi?.connected ? data.wifi.ssid : "sin wifi");
  setText("ov-battery", data.battery?.connected ? `${data.battery.level}%` : "—");
  setText("ia-model-name", data.model || "—");
  if (sys) {
    setText("ia-ram", `${formatBytes(sys.ram.usedBytes)} / ${formatBytes(sys.ram.totalBytes)} (${sys.ram.percent}%)`);
    setBar("ia-ram-bar", sys.ram.percent);
    setText("disk-usage", `${formatBytes(sys.disk.usedBytes)} / ${formatBytes(sys.disk.totalBytes)} (${sys.disk.percent}%)`);
    setBar("disk-bar", sys.disk.percent);
    setText("sys-cpu", `${sys.cpuPercent}%`);
    setBar("sys-cpu-bar", sys.cpuPercent);
    setText("sys-ram", `${sys.ram.percent}%`);
    setBar("sys-ram-bar", sys.ram.percent);
  }
}

unloadModelBtn.addEventListener("click", async () => {
  unloadModelBtn.disabled = true;
  try {
    const res = await fetch("/api/models/unload", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      addMessage("system", "Modelo liberado de la memoria de la Pi.");
    } else {
      addMessage("system", `No se pudo liberar el modelo: ${data.error || ""}`);
    }
  } catch (err) {
    addMessage("system", `Error liberando el modelo: ${err.message}`);
  } finally {
    unloadModelBtn.disabled = false;
    void loadStatus();
  }
});

async function loadModels() {
  try {
    const res = await fetch("/api/models");
    const models = await res.json();
    const statusRes = await fetch("/api/status");
    const status = await statusRes.json();
    modelSelect.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = m.name;
      if (m.name === status.model) opt.selected = true;
      modelSelect.appendChild(opt);
    }
  } catch {
    addMessage("system", "No se pudieron cargar los modelos.");
  }
}

modelSelect.addEventListener("change", async () => {
  const tag = modelSelect.value;
  addMessage("system", `Cambiando a ${tag}...`);
  try {
    const res = await fetch("/api/models/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag }),
    });
    const data = await res.json();
    if (data.ok) {
      addMessage("system", `Modelo activo: ${data.model}`);
      history = [];
      void loadStatus();
    } else {
      addMessage("system", `No se pudo cambiar de modelo: ${data.error || ""}`);
    }
  } catch (err) {
    addMessage("system", `Error cambiando de modelo: ${err.message}`);
  }
});

// Populate the speaker dropdown + the paired-speakers list (with a "delete"
// button each) from the live options. Called on boot, when the Settings tab
// opens, and via the ↻ button.
async function loadAudioOutputs() {
  try {
    const res = await apiFetch("/api/audio-output/options");
    const data = await res.json();
    if (!Array.isArray(data.options)) return;
    audioOutputSelect.innerHTML = "";
    const paired = [];
    for (const opt of data.options) {
      const el = document.createElement("option");
      el.value = opt.key;
      el.textContent = opt.connected && opt.key !== "hat" ? `${opt.label} (conectada)` : opt.label;
      audioOutputSelect.appendChild(el);
      if (opt.key.startsWith("bt:")) paired.push(opt);
    }
    if (data.active) audioOutputSelect.value = data.active;
    renderPairedList(paired);

    // Active-device summary card + General overview.
    const activeOpt = data.options.find((o) => o.key === data.active) || data.options[0];
    const activeName = activeOpt ? activeOpt.label : "Bocina de la Pi";
    setText("audio-active-name", activeName);
    setText("ov-audio", activeName);
    const stateEl = document.getElementById("audio-active-state");
    if (stateEl) {
      const isBt = activeOpt && activeOpt.key.startsWith("bt:");
      stateEl.textContent = isBt ? (activeOpt.connected ? "Conectada" : "Desconectada") : "Activa";
      stateEl.classList.toggle("ok", !isBt || Boolean(activeOpt.connected));
    }
  } catch {
    /* leave the fallback "Bocina de la Pi" option in place */
  }
}

function renderPairedList(paired) {
  if (!btPairedList) return;
  btPairedList.innerHTML = "";
  if (!paired.length) {
    const li = document.createElement("li");
    li.className = "cfg-empty";
    li.textContent = "No hay dispositivos vinculados.";
    btPairedList.appendChild(li);
    return;
  }
  for (const opt of paired) {
    const mac = opt.key.slice(3);
    const li = document.createElement("li");

    const left = document.createElement("div");
    left.className = "cfg-item-left";
    const name = document.createElement("span");
    name.className = "cfg-item-name";
    name.textContent = opt.label;
    const meta = document.createElement("span");
    meta.className = "cfg-item-meta";
    meta.textContent = opt.connected ? "Conectada" : "Vinculada";
    left.appendChild(name);
    left.appendChild(meta);

    // ••• menu -> Desvincular
    const actions = document.createElement("div");
    actions.className = "cfg-item-actions";
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "cfg-menu-btn";
    menuBtn.textContent = "•••";
    menuBtn.setAttribute("aria-label", "Opciones");
    const menu = document.createElement("div");
    menu.className = "cfg-menu hidden";
    const unlink = document.createElement("button");
    unlink.type = "button";
    unlink.className = "danger";
    unlink.textContent = "Desvincular";
    unlink.addEventListener("click", () => {
      menu.classList.add("hidden");
      void removeBtSpeaker(mac, opt.label, menuBtn);
    });
    menu.appendChild(unlink);
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllCfgMenus(menu);
      menu.classList.toggle("hidden");
    });
    actions.appendChild(menuBtn);
    actions.appendChild(menu);

    li.appendChild(left);
    li.appendChild(actions);
    btPairedList.appendChild(li);
  }
}

function closeAllCfgMenus(except) {
  for (const m of document.querySelectorAll(".cfg-menu")) {
    if (m !== except) m.classList.add("hidden");
  }
}
document.addEventListener("click", () => closeAllCfgMenus(null));

async function removeBtSpeaker(mac, label, btn) {
  btn.disabled = true;
  try {
    const res = await apiFetch("/api/bluetooth/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mac }),
    });
    const data = await res.json();
    if (data.ok) {
      addMessage("system", `Bocina eliminada: ${label}.`);
    } else {
      addMessage("system", `No se pudo eliminar ${label}: ${data.error || ""}`);
    }
  } catch (err) {
    addMessage("system", `Error eliminando ${label}: ${err.message}`);
  } finally {
    await loadAudioOutputs();
    void loadStatus();
  }
}

// Scan for nearby speakers and render each with an "Emparejar" button.
async function scanBtSpeakers() {
  if (!btScanBtn) return;
  btScanBtn.disabled = true;
  btScanStatus.textContent = "Buscando dispositivos cercanos...";
  btFoundList.innerHTML = "";
  try {
    const res = await apiFetch("/api/bluetooth/scan");
    const data = await res.json();
    const speakers = Array.isArray(data.speakers) ? data.speakers : [];
    if (!speakers.length) {
      btScanStatus.textContent = "No se encontraron dispositivos. Pon la bocina en modo emparejamiento e intenta de nuevo.";
      return;
    }
    btScanStatus.textContent = `${speakers.length} dispositivo(s) encontrado(s).`;
    for (const sp of speakers) {
      const li = document.createElement("li");
      const left = document.createElement("div");
      left.className = "cfg-item-left";
      const name = document.createElement("span");
      name.className = "cfg-item-name";
      name.textContent = sp.name;
      left.appendChild(name);
      const pairBtn = document.createElement("button");
      pairBtn.type = "button";
      pairBtn.className = "cfg-btn cfg-btn-accent";
      pairBtn.textContent = "Vincular";
      pairBtn.addEventListener("click", () => void pairBtSpeaker(sp.mac, sp.name, pairBtn));
      li.appendChild(left);
      li.appendChild(pairBtn);
      btFoundList.appendChild(li);
    }
  } catch (err) {
    btScanStatus.textContent = `Error al buscar: ${err.message}`;
  } finally {
    btScanBtn.disabled = false;
  }
}

async function pairBtSpeaker(mac, name, btn) {
  btn.disabled = true;
  btn.textContent = "Vinculando...";
  try {
    const res = await apiFetch("/api/bluetooth/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mac }),
    });
    const data = await res.json();
    if (data.ok) {
      addMessage("system", `Dispositivo vinculado y activado: ${name}.`);
      btFoundList.innerHTML = "";
      btScanStatus.textContent = "";
      await loadAudioOutputs();
      void loadStatus();
    } else {
      addMessage("system", `No se pudo emparejar ${name}: ${data.error || ""}`);
      btn.disabled = false;
      btn.textContent = "Vincular";
    }
  } catch (err) {
    addMessage("system", `Error emparejando ${name}: ${err.message}`);
    btn.disabled = false;
    btn.textContent = "Vincular";
  }
}

audioOutputRefreshBtn?.addEventListener("click", () => void loadAudioOutputs());
btScanBtn?.addEventListener("click", () => void scanBtSpeakers());

audioOutputSelect.addEventListener("change", async () => {
  const target = audioOutputSelect.value;
  const label = audioOutputSelect.options[audioOutputSelect.selectedIndex]?.textContent || target;
  const isBt = target.startsWith("bt:");
  audioOutputSelect.disabled = true;
  if (isBt) addMessage("system", `Conectando ${label}...`);
  try {
    const res = await apiFetch("/api/audio-output/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });
    const data = await res.json();
    if (data.ok) {
      addMessage("system", `Audio activo: ${label}.`);
      await loadAudioOutputs();
      void loadStatus();
    } else {
      addMessage("system", `No se pudo cambiar la salida de audio: ${data.error || ""}`);
      await loadAudioOutputs();
    }
  } catch (err) {
    addMessage("system", `Error cambiando la salida de audio: ${err.message}`);
  } finally {
    audioOutputSelect.disabled = false;
  }
});

async function sendMessage(text) {
  history.push({ role: "user", content: text });
  addMessage("user", text);
  const assistantEl = addMessage("assistant", "");
  // AbortController wired to the Cancelar button (below) and to the
  // fetch's `signal` — aborting closes the connection to the server, which
  // (see device/web-admin-server.ts) closes *its* connection to Ollama in
  // turn, actually stopping the generation instead of leaving it running
  // unread. See docs/web-ui.md for the incident this fixed.
  const controller = new AbortController();
  activeController = controller;
  setSendingUi(true);
  let fullText = "";
  let hasStartedTalking = false;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history, model: modelSelect.value }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      throw new Error(errText || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.message?.content) {
            if (!hasStartedTalking) {
              hasStartedTalking = true;
              setAvatarTalking(true);
            }
            fullText += chunk.message.content;
            assistantEl.textContent = fullText;
            chatLog.scrollTop = chatLog.scrollHeight;
          }
        } catch {
          // ignore a partial/malformed line
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      assistantEl.textContent = fullText ? `${fullText}\n\n(cancelado)` : "(cancelado)";
    } else {
      assistantEl.textContent = `(error: ${err.message})`;
      assistantEl.classList.add("system");
    }
  } finally {
    activeController = null;
    setSendingUi(false);
    setAvatarTalking(false);
  }
  if (fullText) {
    // Keep even a cancelled partial reply in history — a follow-up message
    // still has the (truncated) context of what was already said.
    history.push({ role: "assistant", content: fullText });
  }
}

chatCancel.addEventListener("click", () => {
  activeController?.abort();
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || sending) return;
  chatInput.value = "";
  chatInput.style.height = "auto";
  void sendMessage(text);
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 160)}px`;
});

// ---- Tabs ----

// Exposed as a URL hash (#chat/#wifi/#usb) so links from other pages
// (WIFIRADAR's topbar, see wifiradar.html) land on the right tab instead
// of always defaulting to Chat.
function activateTab(tabName) {
  const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  if (!btn) return;
  for (const b of document.querySelectorAll(".tab-btn")) b.classList.remove("active");
  for (const p of document.querySelectorAll(".tab-panel")) p.classList.remove("active");
  btn.classList.add("active");
  document.getElementById(`tab-${tabName}`).classList.add("active");
  if (tabName === "wifi") void refreshWifi();
  if (tabName === "settings") void refreshSettings();
  if (tabName === "music") startMusicUI();
  else stopMusicPolling();
  if (tabName === "usb") ensureUsbFileManager();
}

for (const btn of document.querySelectorAll(".tab-btn")) {
  btn.addEventListener("click", () => {
    window.location.hash = btn.dataset.tab;
    activateTab(btn.dataset.tab);
  });
}

const initialTab = window.location.hash.replace("#", "");
if (initialTab) activateTab(initialTab);

// ---- Wifi ----

const wifiCurrentSsid = document.getElementById("wifi-current-ssid");
const wifiCurrentActions = document.getElementById("wifi-current-actions");
const wifiCurrentShowPasswordBtn = document.getElementById("wifi-current-show-password");
const wifiCurrentForgetBtn = document.getElementById("wifi-current-forget");
const wifiCurrentPasswordEl = document.getElementById("wifi-current-password");
const wifiScanBtn = document.getElementById("wifi-scan-btn");
const wifiScanStatus = document.getElementById("wifi-scan-status");
const wifiList = document.getElementById("wifi-list");
const wifiSavedList = document.getElementById("wifi-saved-list");
const modal = document.getElementById("wifi-connect-modal");
const modalTitle = document.getElementById("wifi-connect-title");
const modalPassword = document.getElementById("wifi-connect-password");
const modalError = document.getElementById("wifi-connect-error");

let pendingSsid = null;

function openConnectModal(ssid) {
  pendingSsid = ssid;
  modalTitle.textContent = `Conectar a "${ssid}"`;
  modalPassword.value = "";
  modalError.textContent = "";
  modal.classList.remove("hidden");
  modalPassword.focus();
}

function closeConnectModal() {
  modal.classList.add("hidden");
  pendingSsid = null;
}

document.getElementById("wifi-connect-cancel").addEventListener("click", closeConnectModal);

document.getElementById("wifi-connect-confirm").addEventListener("click", async () => {
  if (!pendingSsid) return;
  modalError.textContent = "Conectando...";
  try {
    const res = await fetch("/api/wifi/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssid: pendingSsid, password: modalPassword.value || undefined }),
    });
    const data = await res.json();
    if (data.ok) {
      closeConnectModal();
      void refreshWifi();
      void loadStatus();
    } else {
      modalError.textContent = data.error || "No se pudo conectar.";
    }
  } catch (err) {
    modalError.textContent = err.message;
  }
});

function renderWifiItem(net, { saved }) {
  const li = document.createElement("li");
  li.className = "wifi-item";

  const left = document.createElement("div");
  const name = document.createElement("div");
  name.className = "wifi-item-name";
  name.innerHTML = `${net.active ? '<span class="active-dot">●</span>' : ""}${net.ssid}${net.isEmergency ? '<span class="tag">wifi emergencia</span>' : ""}`;
  const meta = document.createElement("div");
  meta.className = "wifi-item-meta";
  meta.textContent = net.active
    ? "Conectada ahora"
    : [
        net.isEmergency ? "Ya tenés la contraseña" : net.secure ? "Con contraseña" : "Abierta",
        net.saved ? "guardada" : null,
        net.signal ? `${net.signal}%` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  left.appendChild(name);
  left.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "wifi-item-actions";
  if (!net.active) {
    const connectBtn = document.createElement("button");
    connectBtn.textContent = "Conectar";
    connectBtn.addEventListener("click", () => {
      // Emergency network already has its password on the device (see
      // docs/wifi.md) — no modal, no typing it again.
      if (net.isEmergency) {
        void (async () => {
          const res = await fetch("/api/wifi/connect-emergency", { method: "POST" });
          const data = await res.json();
          if (data.ok) {
            void refreshWifi();
            void loadStatus();
          } else {
            modalError.textContent = data.error || "No se pudo conectar a la red de emergencia.";
          }
        })();
        return;
      }
      if (net.saved || !net.secure) {
        void (async () => {
          const res = await fetch("/api/wifi/connect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ssid: net.ssid }),
          });
          const data = await res.json();
          if (data.ok) {
            void refreshWifi();
            void loadStatus();
          } else {
            openConnectModal(net.ssid);
            modalError.textContent = data.error || "No se pudo conectar sin contraseña.";
          }
        })();
      } else {
        openConnectModal(net.ssid);
      }
    });
    actions.appendChild(connectBtn);
  }
  if (saved) {
    const forgetBtn = document.createElement("button");
    forgetBtn.className = "secondary";
    forgetBtn.textContent = "Olvidar";
    forgetBtn.addEventListener("click", async () => {
      await fetch("/api/wifi/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: net.ssid }),
      });
      void refreshWifi();
    });
    actions.appendChild(forgetBtn);
  }

  li.appendChild(left);
  li.appendChild(actions);
  return li;
}

let currentConnectedSsid = null;

async function refreshWifi() {
  wifiCurrentPasswordEl.classList.add("hidden");
  wifiCurrentPasswordEl.textContent = "";
  try {
    const statusRes = await fetch("/api/wifi/status");
    const status = await statusRes.json();
    currentConnectedSsid = status.connected ? status.ssid : null;
    wifiCurrentSsid.textContent = currentConnectedSsid || "Sin conexión";
    wifiCurrentActions.classList.toggle("hidden", !currentConnectedSsid);
  } catch {
    currentConnectedSsid = null;
    wifiCurrentSsid.textContent = "—";
    wifiCurrentActions.classList.add("hidden");
  }

  wifiScanStatus.textContent = "Buscando...";
  wifiList.innerHTML = "";
  wifiSavedList.innerHTML = "";
  try {
    const res = await fetch("/api/wifi/scan");
    const networks = await res.json();
    wifiScanStatus.textContent = `${networks.length} redes encontradas`;
    for (const net of networks) {
      if (net.saved) {
        wifiSavedList.appendChild(renderWifiItem(net, { saved: true }));
      } else {
        wifiList.appendChild(renderWifiItem(net, { saved: false }));
      }
    }
    if (wifiSavedList.children.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "Ninguna guardada está al alcance ahora.";
      wifiSavedList.appendChild(li);
    }
  } catch (err) {
    wifiScanStatus.textContent = `Error buscando redes: ${err.message}`;
  }
  void loadRfSpectrum();
}

wifiScanBtn.addEventListener("click", () => void refreshWifi());

wifiCurrentShowPasswordBtn.addEventListener("click", async () => {
  if (!currentConnectedSsid) return;
  wifiCurrentPasswordEl.classList.remove("hidden");
  wifiCurrentPasswordEl.textContent = "Buscando...";
  try {
    const res = await fetch(`/api/wifi/password?${new URLSearchParams({ ssid: currentConnectedSsid })}`);
    const data = await res.json();
    if (!data.ok) {
      wifiCurrentPasswordEl.textContent = data.error || "No se pudo obtener la contraseña.";
    } else if (!data.recoverable) {
      wifiCurrentPasswordEl.textContent = data.error || "No se puede recuperar la contraseña.";
    } else {
      wifiCurrentPasswordEl.textContent = data.password;
    }
  } catch (err) {
    wifiCurrentPasswordEl.textContent = `Error: ${err.message}`;
  }
});

wifiCurrentForgetBtn.addEventListener("click", async () => {
  if (!currentConnectedSsid) return;
  if (!window.confirm(`¿Olvidar la red "${currentConnectedSsid}"? Se va a desconectar.`)) return;
  await fetch("/api/wifi/forget", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ssid: currentConnectedSsid }),
  });
  void refreshWifi();
  void loadStatus();
});

// ---- RF analysis panel ----
// Per-BSSID signal breakdown (not deduped by SSID, unlike the list above —
// see scanWifiNetworksDetailed) with an estimated dBm, distance, and a
// channel/strength spectrum chart, so it's visible at a glance which
// nearby APs would actually make a stable connection.

function classifyRfStrength(signalPercent) {
  if (signalPercent >= 60) return "strong";
  if (signalPercent >= 30) return "mid";
  return "weak";
}

function rfStrengthColor(cls) {
  if (cls === "strong") return "#50ff78";
  if (cls === "mid") return "#ffd166";
  return "#ff6b6b";
}

function drawRfSpectrum(networks) {
  const canvas = document.getElementById("rf-spectrum");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  if (networks.length === 0) {
    ctx.fillStyle = "#3a5a46";
    ctx.font = "12px monospace";
    ctx.fillText("sin datos", 12, h / 2);
    return;
  }

  const marginLeft = 34;
  const marginBottom = 16;
  const marginTop = 10;
  const plotW = w - marginLeft - 10;
  const plotH = h - marginBottom - marginTop;

  // dBm gridlines, -30 (very close) down to -100 (barely there)
  ctx.strokeStyle = "#12241a";
  ctx.fillStyle = "#3a5a46";
  ctx.font = "9px monospace";
  for (let dbm = -30; dbm >= -100; dbm -= 10) {
    const y = marginTop + plotH * (1 - (dbm + 100) / 70);
    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(w - 10, y);
    ctx.stroke();
    ctx.fillText(`${dbm}`, 2, y + 3);
  }

  const channels = [...new Set(networks.map((n) => n.channel))].sort((a, b) => a - b);
  const slotW = plotW / channels.length;
  const byChannel = new Map();
  for (const n of networks) {
    if (!byChannel.has(n.channel)) byChannel.set(n.channel, []);
    byChannel.get(n.channel).push(n);
  }

  channels.forEach((ch, i) => {
    const group = byChannel.get(ch);
    const barW = Math.max(4, Math.min(16, slotW / group.length - 3));
    const groupW = group.length * (barW + 3);
    const slotX = marginLeft + i * slotW + (slotW - groupW) / 2;
    group.forEach((n, j) => {
      const normalized = Math.max(0, Math.min(1, (n.signalDbm + 100) / 70));
      const barH = normalized * plotH;
      const x = slotX + j * (barW + 3);
      const y = marginTop + plotH - barH;
      const color = rfStrengthColor(classifyRfStrength(n.signalPercent));
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 5;
      ctx.fillRect(x, y, barW, barH);
      ctx.shadowBlur = 0;
    });
    ctx.fillStyle = "#5a7a68";
    ctx.font = "9px monospace";
    ctx.fillText(`${ch}`, marginLeft + i * slotW + slotW / 2 - 6, h - 4);
  });
}

function renderRfTable(networks) {
  const tbody = document.getElementById("rf-table-body");
  tbody.innerHTML = "";
  if (networks.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "muted";
    td.textContent = "Sin redes detectadas.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const n of networks) {
    const cls = classifyRfStrength(n.signalPercent);
    const tr = document.createElement("tr");
    const cells = [
      { text: `${n.ssid}${n.active ? " ●" : ""}`, className: "rf-ssid" },
      { text: n.bssid, className: "rf-bssid" },
      { text: String(n.channel) },
      { text: String(n.signalDbm), className: `rf-${cls}` },
      { text: `~${n.distanceMeters}m` },
      { text: n.security },
    ];
    for (const cell of cells) {
      const td = document.createElement("td");
      if (cell.className) td.className = cell.className;
      td.textContent = cell.text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

async function loadRfSpectrum() {
  const status = document.getElementById("rf-scan-status");
  status.textContent = "Escaneando...";
  try {
    const res = await fetch("/api/wifi/scan-detailed");
    const networks = await res.json();
    drawRfSpectrum(networks);
    renderRfTable(networks);
    status.textContent = `${networks.length} punto(s) de acceso detectados`;
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
}

// ---- USB ----

const usbDevicesList = document.getElementById("usb-devices-list");
const usbWifiList = document.getElementById("usb-wifi-list");
const usbVolumesList = document.getElementById("usb-volumes-list");
const usbScanBtn = document.getElementById("usb-scan-btn");
const usbScanStatus = document.getElementById("usb-scan-status");
const usbBrowser = document.getElementById("usb-browser");
const usbBrowserClose = document.getElementById("usb-browser-close");
const usbBreadcrumb = document.getElementById("usb-breadcrumb");
const usbFileList = document.getElementById("usb-file-list");
const imagePreviewModal = document.getElementById("image-preview-modal");
const imagePreviewImg = document.getElementById("image-preview-img");
const imagePreviewClose = document.getElementById("image-preview-close");

let browsingVolume = null;
let browsingPath = "";

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp)$/i;

async function loadUsbDevices() {
  usbDevicesList.innerHTML = "";
  try {
    const res = await fetch("/api/usb/devices");
    const devices = await res.json();
    if (devices.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "Nada conectado por USB ahora mismo.";
      usbDevicesList.appendChild(li);
      return;
    }
    for (const d of devices) {
      const li = document.createElement("li");
      const label = document.createElement("div");
      label.textContent = d.description || d.id;
      const meta = document.createElement("div");
      meta.className = "usb-item-meta";
      meta.textContent = `Bus ${d.bus} · ${d.id}`;
      li.appendChild(label);
      li.appendChild(meta);
      usbDevicesList.appendChild(li);
    }
  } catch (err) {
    usbDevicesList.innerHTML = `<li class="muted">Error: ${err.message}</li>`;
  }
}

async function loadUsbVolumes() {
  usbVolumesList.innerHTML = "";
  try {
    const res = await fetch("/api/usb/volumes");
    const volumes = await res.json();
    if (volumes.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "No hay almacenamiento USB conectado.";
      usbVolumesList.appendChild(li);
      return;
    }
    for (const v of volumes) {
      const li = document.createElement("li");
      const label = document.createElement("div");
      label.textContent = `${v.label} (${v.sizeLabel})`;
      const meta = document.createElement("div");
      meta.className = "usb-item-meta";
      meta.textContent = v.mounted ? v.mountPath : "Sin montar";
      const openBtn = document.createElement("button");
      openBtn.textContent = "Abrir";
      openBtn.addEventListener("click", () => void openUsbVolume(v.name));
      const left = document.createElement("div");
      left.appendChild(label);
      left.appendChild(meta);
      li.appendChild(left);
      li.appendChild(openBtn);
      usbVolumesList.appendChild(li);
    }
  } catch (err) {
    usbVolumesList.innerHTML = `<li class="muted">Error: ${err.message}</li>`;
  }
}

async function loadUsbWifiAdapters() {
  usbWifiList.innerHTML = "";
  try {
    const res = await fetch("/api/usb/wifi-adapters");
    const adapters = await res.json();
    if (adapters.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "Ningún adaptador WiFi USB conectado.";
      usbWifiList.appendChild(li);
      return;
    }
    for (const a of adapters) {
      const li = document.createElement("li");
      const label = document.createElement("div");
      label.textContent = a.iface;
      const meta = document.createElement("div");
      meta.className = "usb-item-meta";
      meta.textContent = `Chipset: ${a.chipset}`;
      li.appendChild(label);
      li.appendChild(meta);
      usbWifiList.appendChild(li);
    }
  } catch (err) {
    usbWifiList.innerHTML = `<li class="muted">Error: ${err.message}</li>`;
  }
}

async function scanUsb() {
  usbScanStatus.textContent = "Buscando...";
  await Promise.all([loadUsbDevices(), loadUsbVolumes(), loadUsbWifiAdapters()]);
  usbScanStatus.textContent = `Actualizado ${new Date().toLocaleTimeString()}`;
}

usbScanBtn.addEventListener("click", () => void scanUsb());

async function openUsbVolume(volumeName) {
  const mountRes = await fetch("/api/usb/mount", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ volume: volumeName }),
  });
  const mountData = await mountRes.json();
  if (!mountData.ok) {
    alert(mountData.error || "No se pudo montar el volumen.");
    return;
  }
  browsingVolume = volumeName;
  browsingPath = "";
  usbBrowser.classList.remove("hidden");
  void loadUsbFiles();
}

function renderBreadcrumb() {
  usbBreadcrumb.innerHTML = "";
  const parts = browsingPath ? browsingPath.split("/").filter(Boolean) : [];
  const rootCrumb = document.createElement("span");
  rootCrumb.className = "crumb";
  rootCrumb.textContent = "/";
  rootCrumb.addEventListener("click", () => {
    browsingPath = "";
    void loadUsbFiles();
  });
  usbBreadcrumb.appendChild(rootCrumb);
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const crumb = document.createElement("span");
    crumb.className = "crumb";
    crumb.textContent = part;
    const target = acc;
    crumb.addEventListener("click", () => {
      browsingPath = target;
      void loadUsbFiles();
    });
    usbBreadcrumb.appendChild(crumb);
  }
}

async function loadUsbFiles() {
  renderBreadcrumb();
  usbFileList.innerHTML = "<li class=\"muted\">Cargando...</li>";
  try {
    const params = new URLSearchParams({ volume: browsingVolume, path: browsingPath });
    const res = await fetch(`/api/usb/files?${params}`);
    const data = await res.json();
    usbFileList.innerHTML = "";
    if (!data.ok) {
      usbFileList.innerHTML = `<li class="muted">${data.error || "Error"}</li>`;
      return;
    }
    if (data.entries.length === 0) {
      usbFileList.innerHTML = "<li class=\"muted\">Carpeta vacía.</li>";
      return;
    }
    for (const entry of data.entries) {
      const li = document.createElement("li");
      const nameEl = document.createElement("div");
      nameEl.className = "usb-file-name";
      nameEl.textContent = `${entry.isDir ? "📁" : "📄"} ${entry.name}`;
      const sizeEl = document.createElement("div");
      sizeEl.className = "usb-file-size";
      sizeEl.textContent = entry.isDir ? "" : formatBytes(entry.size);
      li.appendChild(nameEl);
      li.appendChild(sizeEl);
      li.addEventListener("click", () => {
        const entryPath = browsingPath ? `${browsingPath}/${entry.name}` : entry.name;
        if (entry.isDir) {
          browsingPath = entryPath;
          void loadUsbFiles();
          return;
        }
        const fileUrl = `/api/usb/file?${new URLSearchParams({ volume: browsingVolume, path: entryPath })}`;
        if (IMAGE_EXT_RE.test(entry.name)) {
          imagePreviewImg.src = fileUrl;
          imagePreviewModal.classList.remove("hidden");
        } else {
          window.location.href = fileUrl;
        }
      });
      usbFileList.appendChild(li);
    }
  } catch (err) {
    usbFileList.innerHTML = `<li class="muted">Error: ${err.message}</li>`;
  }
}

usbBrowserClose.addEventListener("click", () => {
  usbBrowser.classList.add("hidden");
  browsingVolume = null;
  browsingPath = "";
});

imagePreviewClose.addEventListener("click", () => {
  imagePreviewModal.classList.add("hidden");
  imagePreviewImg.src = "";
});

for (const btn of document.querySelectorAll(".tab-btn")) {
  if (btn.dataset.tab === "usb") {
    btn.addEventListener("click", () => void scanUsb());
  }
}

// ---- Settings (⚙️ tab: audio output, model RAM, USB safe-eject) ----

const settingsUsbEjectList = document.getElementById("settings-usb-eject-list");
const settingsUsbRefreshBtn = document.getElementById("settings-usb-refresh-btn");
const settingsUsbStatus = document.getElementById("settings-usb-status");

async function loadSettingsUsbVolumes() {
  settingsUsbEjectList.innerHTML = "";
  try {
    const res = await fetch("/api/usb/volumes");
    const volumes = await res.json();
    if (volumes.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "No hay almacenamiento USB conectado.";
      settingsUsbEjectList.appendChild(li);
      return;
    }
    for (const v of volumes) {
      const li = document.createElement("li");
      const label = document.createElement("div");
      label.textContent = `${v.label} (${v.sizeLabel})`;
      const meta = document.createElement("div");
      meta.className = "usb-item-meta";
      meta.textContent = v.mounted ? v.mountPath : "Ya se puede desconectar";
      const left = document.createElement("div");
      left.appendChild(label);
      left.appendChild(meta);
      const ejectBtn = document.createElement("button");
      ejectBtn.className = "secondary";
      ejectBtn.textContent = "Expulsar";
      ejectBtn.disabled = !v.mounted;
      ejectBtn.addEventListener("click", () => void ejectUsbVolume(v.name, ejectBtn));
      li.appendChild(left);
      li.appendChild(ejectBtn);
      settingsUsbEjectList.appendChild(li);
    }
  } catch (err) {
    settingsUsbEjectList.innerHTML = `<li class="muted">Error: ${err.message}</li>`;
  }
}

async function ejectUsbVolume(volumeName, btn) {
  btn.disabled = true;
  settingsUsbStatus.textContent = "Expulsando...";
  try {
    const res = await fetch("/api/usb/eject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volume: volumeName }),
    });
    const data = await res.json();
    settingsUsbStatus.textContent = data.ok
      ? "Ya se puede desconectar con seguridad."
      : `Error: ${data.error || ""}`;
  } catch (err) {
    settingsUsbStatus.textContent = `Error: ${err.message}`;
  } finally {
    void loadSettingsUsbVolumes();
  }
}

settingsUsbRefreshBtn.addEventListener("click", () => void loadSettingsUsbVolumes());

// ---- Configuración: navegación interna (General/Audio/IA/Almacenamiento/Sistema) ----
const cfgNav = document.getElementById("cfg-nav");
if (cfgNav) {
  cfgNav.addEventListener("click", (e) => {
    const btn = e.target.closest(".cfg-nav-btn");
    if (!btn) return;
    const key = btn.dataset.cfg;
    for (const b of cfgNav.querySelectorAll(".cfg-nav-btn")) b.classList.toggle("active", b === btn);
    for (const p of document.querySelectorAll(".cfg-panel")) {
      p.classList.toggle("active", p.dataset.cfgPanel === key);
    }
    if (key === "audio") void loadAudioOutputs();
    else if (key === "ia") void loadIaModels();
    else if (key === "almacenamiento") {
      void loadSettingsUsbVolumes();
      ensureSettingsFileManager();
    }
    else if (key === "sistema") void loadBackups();
  });
}

const cfgStorageRefresh = document.getElementById("cfg-storage-refresh");
cfgStorageRefresh?.addEventListener("click", () => {
  void loadStatus();
});

// ---- IA: selector de modelo (espeja el de Chat, misma API) ----
const iaModelSelect = document.getElementById("ia-model-select");
async function loadIaModels() {
  if (!iaModelSelect) return;
  try {
    const [modelsRes, statusRes] = await Promise.all([fetch("/api/models"), fetch("/api/status")]);
    const models = await modelsRes.json();
    const status = await statusRes.json();
    iaModelSelect.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = m.name;
      if (m.name === status.model) opt.selected = true;
      iaModelSelect.appendChild(opt);
    }
  } catch {
    /* dejar vacío */
  }
}
iaModelSelect?.addEventListener("change", async () => {
  const tag = iaModelSelect.value;
  addMessage("system", `Cambiando a ${tag}...`);
  try {
    const res = await fetch("/api/models/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag }),
    });
    const data = await res.json();
    if (data.ok) {
      addMessage("system", `Modelo activo: ${data.model}`);
      history = [];
      if (modelSelect) modelSelect.value = data.model;
      void loadStatus();
    } else {
      addMessage("system", `No se pudo cambiar el modelo: ${data.error || ""}`);
    }
  } catch (err) {
    addMessage("system", `Error cambiando el modelo: ${err.message}`);
  }
});

// ---- Respaldo (config en la microSD, nunca en el repo) ----
const backupCreateBtn = document.getElementById("backup-create-btn");
const backupStatus = document.getElementById("backup-status");
const backupList = document.getElementById("backup-list");

function backupDateLabel(mtime) {
  try {
    return new Date(mtime).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "";
  }
}

async function loadBackups() {
  if (!backupList) return;
  backupList.innerHTML = "";
  try {
    const res = await apiFetch("/api/backup/list");
    const data = await res.json();
    const backups = Array.isArray(data.backups) ? data.backups : [];
    if (!backups.length) {
      const li = document.createElement("li");
      li.className = "cfg-empty";
      li.textContent = "No hay respaldos todavía.";
      backupList.appendChild(li);
      return;
    }
    for (const b of backups) {
      const li = document.createElement("li");
      const left = document.createElement("div");
      left.className = "cfg-item-left";
      const name = document.createElement("span");
      name.className = "cfg-item-name";
      name.textContent = backupDateLabel(b.mtime);
      const meta = document.createElement("span");
      meta.className = "cfg-item-meta";
      meta.textContent = `${formatBytes(b.size)} · ${b.name}`;
      left.appendChild(name);
      left.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "cfg-item-actions";
      const dl = document.createElement("a");
      dl.className = "cfg-icon-btn";
      dl.textContent = "↓";
      dl.title = "Descargar";
      dl.href = `/api/backup/download?name=${encodeURIComponent(b.name)}`;
      dl.setAttribute("download", b.name);

      const menuBtn = document.createElement("button");
      menuBtn.type = "button";
      menuBtn.className = "cfg-menu-btn";
      menuBtn.textContent = "•••";
      const menu = document.createElement("div");
      menu.className = "cfg-menu hidden";
      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "Restaurar";
      restore.addEventListener("click", () => {
        menu.classList.add("hidden");
        void restoreBackup(b.name);
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "danger";
      del.textContent = "Eliminar";
      del.addEventListener("click", () => {
        menu.classList.add("hidden");
        void deleteBackup(b.name);
      });
      menu.appendChild(restore);
      menu.appendChild(del);
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeAllCfgMenus(menu);
        menu.classList.toggle("hidden");
      });
      actions.appendChild(dl);
      actions.appendChild(menuBtn);
      actions.appendChild(menu);

      li.appendChild(left);
      li.appendChild(actions);
      backupList.appendChild(li);
    }
  } catch (err) {
    backupList.innerHTML = `<li class="cfg-empty">Error: ${err.message}</li>`;
  }
}

backupCreateBtn?.addEventListener("click", async () => {
  backupCreateBtn.disabled = true;
  if (backupStatus) backupStatus.textContent = "Creando respaldo...";
  try {
    const res = await apiFetch("/api/backup/create", { method: "POST" });
    const data = await res.json();
    if (backupStatus) {
      backupStatus.textContent = data.ok ? "Respaldo creado." : `Error: ${data.error || ""}`;
    }
  } catch (err) {
    if (backupStatus) backupStatus.textContent = `Error: ${err.message}`;
  } finally {
    backupCreateBtn.disabled = false;
    void loadBackups();
  }
});

async function restoreBackup(name) {
  if (backupStatus) backupStatus.textContent = "Restaurando...";
  try {
    const res = await apiFetch("/api/backup/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (backupStatus) {
      backupStatus.textContent = data.ok
        ? "Configuración restaurada. Reinicia el servicio de akbal para aplicarla."
        : `Error: ${data.error || ""}`;
    }
    addMessage(
      "system",
      data.ok
        ? "Respaldo restaurado. Se guardó una copia de seguridad de la configuración anterior. Reinicia el servicio para aplicar."
        : `No se pudo restaurar: ${data.error || ""}`,
    );
  } catch (err) {
    if (backupStatus) backupStatus.textContent = `Error: ${err.message}`;
  } finally {
    void loadBackups();
  }
}

async function deleteBackup(name) {
  try {
    const res = await apiFetch("/api/backup/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (backupStatus) {
      backupStatus.textContent = data.ok ? "Respaldo eliminado." : `Error: ${data.error || ""}`;
    }
  } catch (err) {
    if (backupStatus) backupStatus.textContent = `Error: ${err.message}`;
  } finally {
    void loadBackups();
  }
}

async function refreshSettings() {
  settingsUsbStatus.textContent = "";
  await Promise.all([
    loadStatus(),
    loadSettingsUsbVolumes(),
    loadAudioOutputs(),
    loadIaModels(),
    loadBackups(),
    loadAp(),
  ]);
}

// ---- Boot ----

void loadStatus();
void loadAudioOutputs();
void loadModels();
// Battery (and the rest of /api/status) refreshes on its own — no manual
// reload needed to see the % move.
setInterval(() => void loadStatus(), 60000);

// ---- Wardriving (tab-wardrive) ----
// UI only — attack authorization lives server-side in the service's
// allowlist (src/wardrive/service.ts). This tab mirrors /api/wardrive/*
// state: enter/exit mode, per-target attack buttons (only for allowlisted
// BSSIDs), "attack all authorized", global cancel, and live session
// progress. Handshake files are never fetched here — they stay in the
// device's ~/wardrive-sessions/.

const wdModeBanner = document.getElementById("wd-mode-banner");
const wdBannerTitle = wdModeBanner.querySelector(".wd-banner-title");
const wdIface = document.getElementById("wd-iface");
const wdBannerStatus = document.getElementById("wd-banner-status");
const wdEnterBtn = document.getElementById("wd-enter-btn");
const wdExitBtn = document.getElementById("wd-exit-btn");
const wdError = document.getElementById("wd-error");
const wdScanBtn = document.getElementById("wd-scan-btn");
const wdPauseBtn = document.getElementById("wd-pause-btn");
const wdAttackAllBtn = document.getElementById("wd-attack-all-btn");
const wdCancelBtn = document.getElementById("wd-cancel-btn");
const wdAttackStatus = document.getElementById("wd-attack-status");
const wdTableBody = document.getElementById("wd-table-body");
const wdSessionId = document.getElementById("wd-session-id");
const wdSessionList = document.getElementById("wd-session-list");

let wdStatus = null;
let wdTimer = null;
// Pausa de escaneo: congela la tabla (deja de pedir /status a 2Hz) para que
// las filas no se re-ordenen/muevan mientras elegís la red a auditar. El
// estado real (ataques, sesión) sigue alcanzable: un refresh manual refresca
// una vez sin retomar el polling.
let wdPaused = false;

async function wdApi(path, body) {
  const res = await apiFetch(`/api/wardrive/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function wdDbmClass(rssi) {
  if (rssi >= -55) return "wd-strong";
  if (rssi >= -75) return "wd-mid";
  return "wd-weak";
}

function wdRender() {
  if (!wdStatus) return;
  const on = wdStatus.mode !== "inactive";
  const attacking = wdStatus.mode === "attacking";
  wdBannerTitle.classList.toggle("on", on);
  wdIface.textContent = wdStatus.iface ? `· ${wdStatus.iface.toUpperCase()}` : "";
  wdBannerStatus.textContent = on
    ? `Activo — LLM ${wdStatus.modelsUnloaded ? "descargado de RAM" : "en RAM"} · ${wdStatus.allowlist.length} objetivo(s) autorizado(s)` + (wdPaused ? " · ESCANEO EN PAUSA" : "")
    : "Inactivo — la Pi funciona como Akbal normal";
  wdEnterBtn.classList.toggle("hidden", on);
  wdExitBtn.classList.toggle("hidden", !on);
  wdScanBtn.classList.toggle("hidden", !on);
  wdPauseBtn.classList.toggle("hidden", !on);
  wdPauseBtn.textContent = wdPaused ? "Reanudar escaneo" : "Pausar escaneo";
  wdPauseBtn.classList.toggle("wd-paused", wdPaused);
  wdAttackAllBtn.classList.toggle("hidden", !on || attacking);
  wdCancelBtn.classList.toggle("hidden", !attacking);
  wdAttackStatus.textContent = attacking
    ? `Atacando ${wdStatus.session?.currentBssid || "..."}`
    : on
      ? ""
      : "";
  wdSessionId.textContent = wdStatus.session ? `· ${wdStatus.session.id}` : "";
  if (wdError.textContent && wdStatus.error) wdError.textContent = wdStatus.error;

  // Session captures list
  wdSessionList.innerHTML = "";
  if (wdStatus.session) {
    for (const t of wdStatus.session.targets) {
      const li = document.createElement("li");
      const files = t.files.map((f) => f.split("/").pop()).join(", ") || "—";
      li.innerHTML = `<span class="wd-status-badge wd-status-${t.status}">${t.status}</span>` +
        `<span>${t.ssid || t.bssid}</span>` +
        `<span class="wd-files">${t.method || ""} ${files}</span>`;
      wdSessionList.appendChild(li);
    }
    if (wdStatus.session.targets.length === 0) {
      wdSessionList.innerHTML = '<li class="muted">Sin objetivos aún</li>';
    }
  }

  // Air targets table — authorized targets pinned at the top (fixed
  // ordering by BSSID among themselves so re-scan doesn't shuffle them),
  // then the rest by signal strength.
  wdTableBody.innerHTML = "";
  if (!on) {
    wdTableBody.innerHTML = '<tr><td colspan="7" class="muted">Modo inactivo — entra al modo wardriving para escanear</td></tr>';
    return;
  }
  const allTargets = [...(wdStatus.targets || [])];
  const pinned = allTargets
    .filter((t) => t.inAllowlist)
    .sort((a, b) => a.bssid.localeCompare(b.bssid));
  const rest = allTargets
    .filter((t) => !t.inAllowlist)
    .sort((a, b) => b.rssi - a.rssi);
  const ordered = [...pinned, ...rest];
  if (ordered.length === 0) {
    wdTableBody.innerHTML = '<tr><td colspan="7" class="muted">Escaneando el aire...</td></tr>';
    return;
  }
  for (const t of ordered) {
    const tr = document.createElement("tr");
    const sessTarget = wdStatus.session?.targets.find((s) => s.bssid === t.bssid);
    const badge = sessTarget
      ? `<span class="wd-status-badge wd-status-${sessTarget.status}">${sessTarget.status}${sessTarget.method ? "·" + sessTarget.method : ""}</span>`
      : '<span class="wd-status-badge">—</span>';
    const auth = t.inAllowlist;
    const pin = auth ? '<span class="wd-pin" title="Autorizado — fijo arriba">📌</span> ' : "";
    const actions = auth
      ? (attacking
          ? "—"
          : `<button data-act="attack" data-bssid="${t.bssid}">Hack</button>` +
            `<button data-act="disallow" data-bssid="${t.bssid}" class="secondary">Quitar</button>`)
      : `<button data-act="allow" data-bssid="${t.bssid}">Autorizar</button>`;
    tr.innerHTML =
      `<td class="wd-ssid">${pin}${escapeHtml(t.ssid || "(oculta)")}</td>` +
      `<td class="wd-bssid">${t.bssid}</td>` +
      `<td>${t.channel}</td>` +
      `<td class="${wdDbmClass(t.rssi)}">${t.rssi}</td>` +
      `<td>${t.security}</td>` +
      `<td>${badge}</td>` +
      `<td>${actions}</td>`;
    wdTableBody.appendChild(tr);
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

wdTableBody.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (!btn) return;
  const bssid = btn.dataset.bssid;
  const act = btn.dataset.act;
  wdError.textContent = "";
  if (act === "allow") {
    const res = await wdApi("allowlist", { bssid });
    if (res?.error) wdError.textContent = res.error;
    void wdRefresh();
  } else if (act === "disallow") {
    const res = await wdApi("allowlist/remove", { bssid });
    if (res?.error) wdError.textContent = res.error;
    void wdRefresh();
  } else if (act === "attack") {
    const res = await wdApi("attack/one", { bssid });
    if (res?.error) wdError.textContent = res.error;
    void wdRefresh();
  }
});

wdEnterBtn.addEventListener("click", async () => {
  wdError.textContent = "";
  const res = await wdApi("enter");
  if (res?.error) wdError.textContent = res.error;
  void wdRefresh();
});

wdExitBtn.addEventListener("click", async () => {
  wdError.textContent = "";
  const res = await wdApi("exit");
  if (res?.error) wdError.textContent = res.error;
  void wdRefresh();
});

wdScanBtn.addEventListener("click", () => void wdRefresh(true));

// Pausa de escaneo: congela el polling para que la tabla no cambie mientras
// elegís la red a auditar. El modo/ataques siguen funcionando igual.
wdPauseBtn.addEventListener("click", () => {
  wdPaused = !wdPaused;
  wdRender();
  void wdRefreshOnce();
});

wdAttackAllBtn.addEventListener("click", async () => {
  wdError.textContent = "";
  const bssids = (wdStatus.targets || [])
    .filter((t) => t.inAllowlist)
    .map((t) => t.bssid);
  if (bssids.length === 0) {
    wdError.textContent = "No hay objetivos autorizados visibles";
    return;
  }
  const res = await wdApi("attack/many", { bssids });
  if (res?.error) wdError.textContent = res.error;
  void wdRefresh();
});

wdCancelBtn.addEventListener("click", async () => {
  await wdApi("attack/cancel");
  void wdRefresh();
});

async function wdRefresh(forceScan = false) {
  if (forceScan && wdStatus?.mode === "ready") {
    // A passive nudge to NetworkManager's own scan doesn't disturb the
    // monitor interface; WIFIRADAR's capture is the actual data source.
    await fetch("/api/wifi/scan-detailed").catch(() => {});
  }
  const res = await fetch("/api/wardrive/status");
  if (res.ok) {
    wdStatus = await res.json();
    wdRender();
  }
}

// One-shot refresh that ignores the pause flag (used by the pause button
// itself and by action buttons: even paused, attacks/captures should
// reflect immediately).
async function wdRefreshOnce() {
  const res = await fetch("/api/wardrive/status");
  if (res.ok) {
    wdStatus = await res.json();
    wdRender();
  }
}

// The wardrive tab polls; other tabs leave it alone (cheap GET only).
for (const btn of document.querySelectorAll(".tab-btn")) {
  if (btn.dataset.tab === "wardrive") {
    btn.addEventListener("click", () => {
      void wdRefresh();
      if (!wdTimer) wdTimer = setInterval(() => {
        if (wdPaused) return; // pausa de escaneo: no re-ordenar la tabla
        const active = document.getElementById("tab-wardrive")?.classList.contains("active");
        if (active) void wdRefresh();
      }, 2000);
    });
  }
}

// Boot into a live state if the user lands directly on #wardrive.
if (window.location.hash === "#wardrive") void wdRefresh();

// ---- Wardriving sub-tabs (Objetivos / Deauth / Archivos) ----

for (const sub of document.querySelectorAll(".wd-subtab")) {
  sub.addEventListener("click", () => {
    for (const s of document.querySelectorAll(".wd-subtab")) s.classList.remove("active");
    for (const p of document.querySelectorAll(".wd-subpanel")) p.classList.add("hidden");
    sub.classList.add("active");
    document.getElementById(`wd-subtab-${sub.dataset.wdSubtab}`).classList.remove("hidden");
    if (sub.dataset.wdSubtab === "deauth") void wdLoadDevices();
    if (sub.dataset.wdSubtab === "files") void wdLoadFiles();
  });
}

// ── Deauth sub-tab ──

const wdDevicesScanBtn = document.getElementById("wd-devices-scan-btn");
const wdDevicesStatus = document.getElementById("wd-devices-status");
const wdDevicesBody = document.getElementById("wd-devices-body");

let wdDevices = [];

async function wdLoadDevices() {
  const res = await fetch("/api/wardrive/devices");
  if (res.ok) {
    wdDevices = await res.json();
    wdRenderDevices();
  }
}

wdDevicesScanBtn.addEventListener("click", () => void wdLoadDevices());

function wdRenderDevices() {
  wdDevicesStatus.textContent = wdDevices.length ? `${wdDevices.length} dispositivo(s) vistos` : "";
  wdDevicesBody.innerHTML = "";
  if (wdDevices.length === 0) {
    wdDevicesBody.innerHTML = '<tr><td colspan="6" class="muted">Sin dispositivos visibles (activá modo wardriving para ver el aire)</td></tr>';
    return;
  }
  for (const d of wdDevices) {
    const tr = document.createElement("tr");
    const state = d.deauthing
      ? '<span class="wd-status-badge wd-status-running">deauth</span>'
      : d.deauthAuthorized
        ? '<span class="wd-status-badge wd-status-captured">autorizado</span>'
        : '<span class="wd-status-badge">—</span>';
    const net = d.associatedSsid
      ? `${escapeHtml(d.associatedSsid)}`
      : d.associatedBssid
        ? d.associatedBssid
        : '<span class="muted">sin asociar</span>';
    const actions = d.deauthing
      ? `<button data-act="deauth-stop" data-mac="${d.mac}">Detener</button>`
      : (d.deauthAuthorized && !d.deauthing
          ? `<button data-act="deauth" data-mac="${d.mac}">Deauth</button>` +
            `<button data-act="deauth-disallow" data-mac="${d.mac}" class="secondary">Quitar</button>`
          : `<button data-act="deauth-allow" data-mac="${d.mac}">Autorizar</button>`);
    tr.innerHTML =
      `<td class="wd-bssid">${d.mac}</td>` +
      `<td class="wd-ssid">${net}</td>` +
      `<td class="${wdDbmClass(d.rssi)}">${d.rssi}</td>` +
      `<td>${escapeHtml(d.vendor || "")}</td>` +
      `<td>${state}</td>` +
      `<td>${actions}</td>`;
    wdDevicesBody.appendChild(tr);
  }
}

wdDevicesBody.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (!btn) return;
  const mac = btn.dataset.mac;
  const act = btn.dataset.act;
  wdError.textContent = "";
  if (act === "deauth-allow") {
    await wdApi("deauth/authorize", { mac });
    void wdLoadDevices();
  } else if (act === "deauth-disallow") {
    await wdApi("deauth/deauthorize", { mac });
    void wdLoadDevices();
  } else if (act === "deauth") {
    const res = await wdApi("deauth/attack", { mac, seconds: 10 });
    if (res?.error) {
      wdError.textContent = res.error;
    }
    void wdLoadDevices();
  } else if (act === "deauth-stop") {
    await wdApi("deauth/stop", { mac });
    void wdLoadDevices();
  }
});

// ── Files sub-tab ──

const wdFilesUpBtn = document.getElementById("wd-files-up-btn");
const wdFilesPath = document.getElementById("wd-files-path");
const wdFilesRefreshBtn = document.getElementById("wd-files-refresh-btn");
const wdFilesBody = document.getElementById("wd-files-body");

let wdFilesCwd = "";

function wdFormatSize(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function wdLoadFiles() {
  const res = await fetch(`/api/wardrive/files?path=${encodeURIComponent(wdFilesCwd)}`);
  if (!res.ok) {
    wdFilesBody.innerHTML = '<tr><td colspan="3" class="muted">No se pudo listar la carpeta</td></tr>';
    return;
  }
  const data = await res.json();
  wdFilesPath.textContent = "/" + (data.path || "");
  wdFilesUpBtn.classList.toggle("hidden", !data.path);
  wdFilesBody.innerHTML = "";
  if (data.items.length === 0) {
    wdFilesBody.innerHTML = '<tr><td colspan="3" class="muted">Carpeta vacía (creá una sesión primero)</td></tr>';
    return;
  }
  for (const item of data.items) {
    const tr = document.createElement("tr");
    const nameCell = item.type === "dir"
      ? `<a href="#" class="wd-ssid" data-open="${item.path}">${escapeHtml(item.name)}/</a>`
      : `<span>${escapeHtml(item.name)}</span>`;
    const actions = item.type === "dir"
      ? `<button data-act="del" data-path="${item.path}" class="secondary">Borrar</button>`
      : `<a href="/api/wardrive/files/download?path=${encodeURIComponent(item.path)}"><button>Descargar</button></a>` +
        `<button data-act="del" data-path="${item.path}" class="secondary">Borrar</button>`;
    tr.innerHTML =
      `<td>${nameCell}</td>` +
      `<td class="wd-bssid">${item.type === "dir" ? "carpeta" : wdFormatSize(item.size)}</td>` +
      `<td>${actions}</td>`;
    wdFilesBody.appendChild(tr);
  }
}

wdFilesBody.addEventListener("click", async (ev) => {
  const open = ev.target.closest("a[data-open]");
  if (open) {
    ev.preventDefault();
    wdFilesCwd = open.dataset.open;
    void wdLoadFiles();
    return;
  }
  const btn = ev.target.closest("button[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "del") {
    if (!confirm(`¿Borrar ${btn.dataset.path}? (permanente)`)) return;
    const res = await wdApi("files/delete", { path: btn.dataset.path });
    if (res?.error) wdError.textContent = res.error;
    void wdLoadFiles();
  }
});

wdFilesUpBtn.addEventListener("click", () => {
  const parts = wdFilesCwd.split("/").filter(Boolean);
  parts.pop();
  wdFilesCwd = parts.join("/");
  void wdLoadFiles();
});

wdFilesRefreshBtn.addEventListener("click", () => void wdLoadFiles());

// ================= Reproductor de música (Cypher OST) =================
const mpTitle = document.getElementById("mp-title");
const mpSub = document.getElementById("mp-sub");
const mpFill = document.getElementById("mp-progress-fill");
const mpCur = document.getElementById("mp-cur");
const mpDur = document.getElementById("mp-dur");
const mpPlayPause = document.getElementById("mp-playpause");
const mpPrev = document.getElementById("mp-prev");
const mpNext = document.getElementById("mp-next");
const mpStop = document.getElementById("mp-stop");
const mpList = document.getElementById("mp-list");
const mpVisual = document.getElementById("mp-visual");
const mpSeek = document.getElementById("mp-seek");
const mpSeekKnob = document.getElementById("mp-seek-knob");
let musicDurationMs = 0;

let musicPollTimer = null;
let musicTracksLoaded = false;

function fmtTime(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

async function loadMusicTracks() {
  if (!mpList) return;
  try {
    const res = await apiFetch("/api/music/tracks");
    const data = await res.json();
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    mpList.innerHTML = "";
    if (!tracks.length) {
      const li = document.createElement("li");
      li.textContent = "No hay canciones en la biblioteca.";
      li.style.cursor = "default";
      mpList.appendChild(li);
    }
    for (const t of tracks) {
      const li = document.createElement("li");
      li.dataset.index = String(t.index);
      const idx = document.createElement("span");
      idx.className = "mp-idx";
      idx.textContent = String(t.index + 1).padStart(2, "0");
      const name = document.createElement("span");
      name.textContent = t.title;
      const eq = document.createElement("span");
      eq.className = "mp-eq-mini";
      eq.textContent = "♪";
      li.appendChild(idx);
      li.appendChild(name);
      li.appendChild(eq);
      li.addEventListener("click", () => void musicCmd("play", { index: t.index }));
      mpList.appendChild(li);
    }
    musicTracksLoaded = true;
    if (data.status) renderMusicStatus(data.status);
  } catch {
    /* ignore */
  }
}

function renderMusicStatus(s) {
  if (!mpTitle) return;
  const stateClass = !s.playing ? "stopped" : s.paused ? "paused" : "playing";
  if (mpVisual) mpVisual.className = `mx-visual ${stateClass}`;
  musicDurationMs = s.durationMs || 0;
  if (s.playing && s.title) {
    mpTitle.textContent = s.title;
    mpSub.textContent = `Cypher OST · ${s.index + 1}/${s.total}${s.paused ? " · en pausa" : ""}`;
  } else {
    mpTitle.textContent = "Reproductor Cypher OST";
    mpSub.textContent = s.available ? "Selecciona una pista para empezar" : "Sin biblioteca";
  }
  mpPlayPause.textContent = s.playing && !s.paused ? "❚❚" : "▶";
  const pct = s.durationMs > 0 ? Math.min(100, (s.positionMs / s.durationMs) * 100) : 0;
  if (mpFill) mpFill.style.width = `${pct}%`;
  if (mpSeekKnob) mpSeekKnob.style.left = `${pct}%`;
  if (mpCur) mpCur.textContent = fmtTime(s.positionMs);
  if (mpDur) mpDur.textContent = s.durationMs > 0 ? fmtTime(s.durationMs) : "0:00";
  for (const li of mpList ? mpList.querySelectorAll("li[data-index]") : []) {
    li.classList.toggle("active", s.playing && Number(li.dataset.index) === s.index);
  }
}

async function pollMusicStatus() {
  try {
    const res = await apiFetch("/api/music/status");
    renderMusicStatus(await res.json());
  } catch {
    /* ignore */
  }
}

async function musicCmd(cmd, body) {
  try {
    const res = await apiFetch(`/api/music/${cmd}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    renderMusicStatus(await res.json());
  } catch (err) {
    addMessage("system", `Error de música: ${err.message}`);
  }
}

function startMusicUI() {
  if (!musicTracksLoaded) void loadMusicTracks();
  else void pollMusicStatus();
  stopMusicPolling();
  musicPollTimer = setInterval(() => void pollMusicStatus(), 1000);
}
function stopMusicPolling() {
  if (musicPollTimer) {
    clearInterval(musicPollTimer);
    musicPollTimer = null;
  }
}

mpPlayPause?.addEventListener("click", () => void musicCmd("playpause"));
mpPrev?.addEventListener("click", () => void musicCmd("prev"));
mpNext?.addEventListener("click", () => void musicCmd("next"));
mpStop?.addEventListener("click", () => void musicCmd("stop"));

function seekFromEvent(clientX) {
  if (!mpSeek || musicDurationMs <= 0) return;
  const rect = mpSeek.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  if (mpFill) mpFill.style.width = `${frac * 100}%`;
  if (mpSeekKnob) mpSeekKnob.style.left = `${frac * 100}%`;
  void musicCmd("seek", { ms: Math.round(frac * musicDurationMs) });
}
let seeking = false;
mpSeek?.addEventListener("pointerdown", (e) => {
  seeking = true;
  mpSeek.setPointerCapture(e.pointerId);
  seekFromEvent(e.clientX);
});
mpSeek?.addEventListener("pointermove", (e) => {
  if (!seeking || musicDurationMs <= 0) return;
  const rect = mpSeek.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  if (mpFill) mpFill.style.width = `${frac * 100}%`;
  if (mpSeekKnob) mpSeekKnob.style.left = `${frac * 100}%`;
});
mpSeek?.addEventListener("pointerup", (e) => {
  if (!seeking) return;
  seeking = false;
  seekFromEvent(e.clientX);
});

// ================= Explorador de archivos (interno + USB) =================
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function createFileManager(container) {
  if (!container || container.dataset.mounted === "1") return;
  container.dataset.mounted = "1";
  let root = "internal";
  let cwd = "";

  const bar = document.createElement("div");
  bar.className = "fm-bar";
  const rootSel = document.createElement("select");
  const upBtn = document.createElement("button");
  upBtn.type = "button";
  upBtn.className = "cfg-btn";
  upBtn.textContent = "↑ Subir nivel";
  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "cfg-icon-btn";
  refreshBtn.textContent = "↻";
  refreshBtn.title = "Refrescar";
  const mkdirBtn = document.createElement("button");
  mkdirBtn.type = "button";
  mkdirBtn.className = "cfg-btn";
  mkdirBtn.textContent = "+ Carpeta";
  const uploadBtn = document.createElement("button");
  uploadBtn.type = "button";
  uploadBtn.className = "cfg-btn cfg-btn-accent";
  uploadBtn.textContent = "↑ Subir archivo";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.style.display = "none";
  bar.appendChild(rootSel);
  bar.appendChild(upBtn);
  bar.appendChild(mkdirBtn);
  bar.appendChild(uploadBtn);
  bar.appendChild(refreshBtn);

  const crumb = document.createElement("div");
  crumb.className = "fm-crumb";
  const status = document.createElement("div");
  status.className = "fm-progress";
  const list = document.createElement("ul");
  list.className = "fm-list";

  container.appendChild(bar);
  container.appendChild(crumb);
  container.appendChild(status);
  container.appendChild(list);
  container.appendChild(fileInput);

  async function loadRoots() {
    try {
      const res = await apiFetch("/api/storage/roots");
      const data = await res.json();
      rootSel.innerHTML = "";
      for (const r of data.roots || []) {
        const o = document.createElement("option");
        o.value = r.key;
        o.textContent = r.label;
        rootSel.appendChild(o);
      }
      if (![...rootSel.options].some((o) => o.value === root)) root = rootSel.value || "internal";
      rootSel.value = root;
    } catch {
      /* ignore */
    }
  }

  async function load() {
    crumb.textContent = `${rootSel.options[rootSel.selectedIndex]?.textContent || root} / ${cwd || ""}`;
    list.innerHTML = "";
    try {
      const res = await apiFetch(`/api/storage/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(cwd)}`);
      const data = await res.json();
      if (!data.ok) {
        list.innerHTML = `<li class="fm-empty">${data.error || "No disponible"}</li>`;
        return;
      }
      if (!data.entries.length) {
        list.innerHTML = `<li class="fm-empty">Carpeta vacía</li>`;
        return;
      }
      for (const e of data.entries) {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.className = e.isDir ? "fm-name dir" : "fm-name";
        name.textContent = (e.isDir ? "📁 " : "📄 ") + e.name;
        if (e.isDir) {
          name.addEventListener("click", () => {
            cwd = cwd ? `${cwd}/${e.name}` : e.name;
            void load();
          });
        }
        const meta = document.createElement("span");
        meta.className = "fm-meta";
        meta.textContent = e.isDir ? "" : humanSize(e.size);
        const actions = document.createElement("div");
        actions.className = "fm-actions";
        if (!e.isDir) {
          const dl = document.createElement("a");
          dl.className = "cfg-icon-btn";
          dl.textContent = "↓";
          dl.title = "Descargar";
          const rel = cwd ? `${cwd}/${e.name}` : e.name;
          dl.href = `/api/storage/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(rel)}`;
          dl.setAttribute("download", e.name);
          actions.appendChild(dl);
        }
        const del = document.createElement("button");
        del.type = "button";
        del.className = "cfg-icon-btn";
        del.textContent = "🗑";
        del.title = "Eliminar";
        del.addEventListener("click", () => void doDelete(e.name));
        actions.appendChild(del);
        li.appendChild(name);
        li.appendChild(meta);
        li.appendChild(actions);
        list.appendChild(li);
      }
    } catch (err) {
      list.innerHTML = `<li class="fm-empty">Error: ${err.message}</li>`;
    }
  }

  async function doDelete(name) {
    if (!confirm(`¿Eliminar "${name}"? Esta acción no se puede deshacer.`)) return;
    const password = prompt("Contraseña de la web para confirmar el borrado:");
    if (!password) return;
    const rel = cwd ? `${cwd}/${name}` : name;
    status.textContent = `Eliminando ${name}...`;
    try {
      const res = await apiFetch("/api/storage/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, path: rel, password }),
      });
      const data = await res.json();
      status.textContent = data.ok ? "" : `Error: ${data.error || ""}`;
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
    void load();
  }

  rootSel.addEventListener("change", () => {
    root = rootSel.value;
    cwd = "";
    void load();
  });
  upBtn.addEventListener("click", () => {
    if (!cwd) return;
    cwd = cwd.split("/").slice(0, -1).join("/");
    void load();
  });
  refreshBtn.addEventListener("click", () => void load());
  mkdirBtn.addEventListener("click", async () => {
    const name = prompt("Nombre de la nueva carpeta:");
    if (!name) return;
    try {
      const res = await apiFetch("/api/storage/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, path: cwd, name }),
      });
      const data = await res.json();
      status.textContent = data.ok ? "" : `Error: ${data.error || ""}`;
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
    void load();
  });
  uploadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    status.textContent = `Subiendo ${file.name}...`;
    try {
      const url = `/api/storage/upload?root=${encodeURIComponent(root)}&path=${encodeURIComponent(cwd)}&name=${encodeURIComponent(file.name)}`;
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      const data = await res.json();
      status.textContent = data.ok ? "" : `Error: ${data.error || ""}`;
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
    fileInput.value = "";
    void load();
  });

  (async () => {
    await loadRoots();
    await load();
  })();
}

function ensureUsbFileManager() {
  createFileManager(document.getElementById("fm-usb"));
}
function ensureSettingsFileManager() {
  createFileManager(document.getElementById("fm-settings"));
}

// ================= WiFi directo (AP / hotspot) =================
const apState = document.getElementById("ap-state");
const apEnableBtn = document.getElementById("ap-enable-btn");
const apDisableBtn = document.getElementById("ap-disable-btn");
const apDetails = document.getElementById("ap-details");
const apSsid = document.getElementById("ap-ssid");
const apPass = document.getElementById("ap-pass");
const apUrl = document.getElementById("ap-url");
const apQrWifi = document.getElementById("ap-qr-wifi");
const apQrUrl = document.getElementById("ap-qr-url");

function renderAp(data) {
  if (!apState) return;
  const active = Boolean(data.active);
  apState.textContent = active ? "Activo" : "Inactivo";
  apState.classList.toggle("ok", active);
  if (apEnableBtn) apEnableBtn.style.display = active ? "none" : "";
  if (apDisableBtn) apDisableBtn.style.display = active ? "" : "none";
  if (apDetails) apDetails.style.display = active ? "flex" : "none";
  if (active) {
    if (apSsid) apSsid.textContent = data.ssid || "—";
    if (apPass) apPass.textContent = data.password || "—";
    if (apUrl) apUrl.textContent = data.url || "—";
    if (apQrWifi && data.wifiQr) apQrWifi.src = data.wifiQr;
    if (apQrUrl && data.urlQr) apQrUrl.src = data.urlQr;
  }
}

async function loadAp() {
  try {
    const res = await apiFetch("/api/ap/status");
    renderAp(await res.json());
  } catch {
    /* ignore */
  }
}

apEnableBtn?.addEventListener("click", async () => {
  if (!confirm(
    "Vas a activar el WiFi directo de la Pi.\n\n" +
    "La Pi se DESCONECTARÁ de tu WiFi actual, así que esta página dejará de responder. " +
    "Conéctate a la red 'akbal-pi' con tu teléfono/laptop (usa el QR) y abre la dirección que se muestra.\n\n" +
    "¿Continuar?"
  )) return;
  apEnableBtn.disabled = true;
  apEnableBtn.textContent = "Activando... reconéctate al WiFi de la Pi";
  try {
    const res = await apiFetch("/api/ap/enable", { method: "POST" });
    renderAp(await res.json());
  } catch {
    // Expected: the response often never arrives because wifi drops.
    apEnableBtn.textContent = "WiFi directo activándose. Conéctate a 'akbal-pi'.";
  }
});

apDisableBtn?.addEventListener("click", async () => {
  apDisableBtn.disabled = true;
  try {
    const res = await apiFetch("/api/ap/disable", { method: "POST" });
    renderAp(await res.json());
  } catch {
    /* ignore */
  } finally {
    apDisableBtn.disabled = false;
  }
});

// ================= Wi-Fi sub-tabs (Conexión / Redes / Espectro) =================
(function () {
  const nav = document.getElementById("wifi-subtabs");
  if (!nav) return;
  nav.addEventListener("click", (e) => {
    const btn = e.target.closest(".subtab");
    if (!btn) return;
    const key = btn.dataset.wifiSub;
    for (const b of nav.querySelectorAll(".subtab")) b.classList.toggle("active", b === btn);
    for (const p of document.querySelectorAll("#tab-wifi .subpanel")) {
      p.classList.toggle("active", p.dataset.wifiPanel === key);
    }
  });
})();

// ================= Chat: sugerencias del empty state =================
(function () {
  for (const b of document.querySelectorAll(".chat-suggest")) {
    b.addEventListener("click", () => {
      const text = b.dataset.suggest;
      if (!text || typeof sending !== "undefined" && sending) return;
      void sendMessage(text);
    });
  }
})();
