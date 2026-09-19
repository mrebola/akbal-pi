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
  } catch {
    statusPill.textContent = "sin conexión con el dispositivo";
  }
}

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

for (const btn of document.querySelectorAll(".tab-btn")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".tab-btn")) b.classList.remove("active");
    for (const p of document.querySelectorAll(".tab-panel")) p.classList.remove("active");
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "wifi") void refreshWifi();
  });
}

// ---- Wifi ----

const wifiCurrentSsid = document.getElementById("wifi-current-ssid");
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

async function refreshWifi() {
  try {
    const statusRes = await fetch("/api/wifi/status");
    const status = await statusRes.json();
    wifiCurrentSsid.textContent = status.connected ? status.ssid : "Sin conexión";
  } catch {
    wifiCurrentSsid.textContent = "—";
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

// ---- Boot ----

void loadStatus();
void loadModels();
// Battery (and the rest of /api/status) refreshes on its own — no manual
// reload needed to see the % move.
setInterval(() => void loadStatus(), 60000);
