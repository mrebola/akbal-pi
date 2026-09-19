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
    statCpu.textContent = "CPU —";
    statRam.textContent = "RAM —";
    statDisk.textContent = "Disco —";
    statCpu.classList.remove("warn");
    statRam.classList.remove("warn");
    statDisk.classList.remove("warn");
    return;
  }
  statCpu.textContent = `CPU ${system.cpuPercent}%`;
  statRam.textContent = `RAM ${system.ram.percent}%`;
  statDisk.textContent = `Disco ${system.disk.percent}%`;
  statCpu.classList.toggle("warn", system.cpuPercent >= 85);
  statRam.classList.toggle("warn", system.ram.percent >= 85);
  statDisk.classList.toggle("warn", system.disk.percent >= 90);
}

function addMessage(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

async function loadStatus() {
  try {
    const res = await apiFetch("/api/status");
    const data = await res.json();
    const wifiLabel = data.wifi?.connected ? data.wifi.ssid : "sin wifi";
    statusPill.textContent = `${data.model} · ${wifiLabel}`;
    updateBatteryIndicator(data.battery);
    updateSystemStats(data.system);
    modelLoadIndicator.textContent = data.modelLoaded ? "cargado" : "descargado";
    modelLoadIndicator.classList.toggle("loaded", Boolean(data.modelLoaded));
    if (data.audioOutput && audioOutputSelect.value !== data.audioOutput) {
      audioOutputSelect.value = data.audioOutput;
    }
  } catch {
    statusPill.textContent = "sin conexión con el dispositivo";
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

// Populate the speaker dropdown from the live list (HAT + paired Bluetooth
// speakers). Called on boot, when the Settings tab opens, and via the ↻ button.
async function loadAudioOutputs() {
  try {
    const res = await apiFetch("/api/audio-output/options");
    const data = await res.json();
    if (!Array.isArray(data.options)) return;
    audioOutputSelect.innerHTML = "";
    for (const opt of data.options) {
      const el = document.createElement("option");
      el.value = opt.key;
      el.textContent = opt.connected && opt.key !== "hat" ? `${opt.label} (conectada)` : opt.label;
      audioOutputSelect.appendChild(el);
    }
    if (data.active) audioOutputSelect.value = data.active;
  } catch {
    /* leave the fallback "Bocina de la Pi" option in place */
  }
}

audioOutputRefreshBtn?.addEventListener("click", () => void loadAudioOutputs());

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

async function refreshSettings() {
  settingsUsbStatus.textContent = "";
  await Promise.all([loadStatus(), loadSettingsUsbVolumes(), loadAudioOutputs()]);
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
