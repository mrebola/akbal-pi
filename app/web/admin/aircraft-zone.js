// Zone list for the aircraft radar page: aircraft captured inside the zone
// around Akbal in the last 24 hours, newest first, with the time each was
// last seen. Selecting one shows its captures, with date and time.
// The server is the source of truth; this only renders what it returns.

const list = document.getElementById("ar-zone-list");
const note = document.getElementById("ar-zone-note");
const detail = document.getElementById("ar-zone-detail");
const detailTitle = document.getElementById("ar-zone-detail-title");
const sightingsBody = document.getElementById("ar-zone-sightings");

const REFRESH_MS = 30_000;

const formatDateTime = (ms) =>
  new Date(ms).toLocaleString("es-MX", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const formatTime = (ms) =>
  new Date(ms).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });

const label = (row) => row.callsign?.trim() || row.registration || row.icao;

function renderRows(rows) {
  list.innerHTML = "";
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "ar-zone-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ar-zone-pick";
    const name = document.createElement("span");
    name.className = "ar-zone-name";
    name.textContent = label(row);
    const seen = document.createElement("span");
    seen.className = "ar-zone-seen";
    seen.textContent = `visto ${formatDateTime(row.timestamp)}`;
    btn.append(name, seen);
    btn.addEventListener("click", () => showSightings(row));
    li.append(btn);
    list.append(li);
  }
}

async function showSightings(row) {
  const res = await fetch(`/api/aircraft/sightings?icao=${encodeURIComponent(row.icao)}`);
  if (!res.ok) return;
  const rows = await res.json();
  detailTitle.textContent = `${label(row)} · ${rows.length} captura(s) en 24 h`;
  sightingsBody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    const cells = [
      formatDateTime(r.timestamp),
      r.altitude ?? "—",
      r.speed ?? "—",
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = String(value);
      tr.append(td);
    }
    sightingsBody.append(tr);
  }
  detail.classList.remove("hidden");
}

async function refresh() {
  try {
    const res = await fetch("/api/aircraft/zone");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    note.textContent = rows.length === 0
      ? "Sin aviones en la zona en las últimas 24 h. Si Akbal no tiene posición GPS ni ADSB_HOME, no hay zona."
      : `${rows.length} avión(es) en la zona. Hora local de la Pi.`;
    renderRows(rows);
  } catch {
    note.textContent = "No se pudo cargar la lista de la zona.";
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
