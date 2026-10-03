// One list for the aircraft radar's left column: live aircraft and the 24-hour
// zone captures, merged and ordered by when each was last seen, newest first.
// Zone rows come from /api/aircraft/zone (refreshed every 30 s); live rows are
// pushed in by aircraft-radar.js on every snapshot via window.AircraftZone.

const cardsEl = document.getElementById("ar-zone-cards");

const REFRESH_MS = 30_000;
let zoneRows = [];
let liveRows = [];

const formatDateTime = (ms) =>
  new Date(ms).toLocaleString("es-MX", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const label = (row) => row.callsign?.trim() || row.registration || row.icao;

function cell(text, cls) {
  const el = document.createElement("span");
  if (cls) el.className = cls;
  el.textContent = String(text);
  return el;
}

function buildCard(row, live) {
  const card = document.createElement("div");
  card.className = "ar-card ar-zone-card" + (live ? " ar-live" : "");
  card.dataset.icao = row.icao;

  const top = document.createElement("div");
  top.className = "ar-card-top";
  top.append(cell(label(row), "ar-flight"), cell(row.registration || row.icao, "ar-reg"));

  const seen = document.createElement("div");
  seen.className = "ar-zone-seen";
  seen.textContent = `${live ? "en vivo · " : ""}visto: ${formatDateTime(row.timestamp)}`;

  const metrics = document.createElement("div");
  metrics.className = "ar-card-metrics";
  metrics.append(
    cell(row.altitude != null ? `${row.altitude} ft` : "—"),
    cell(row.speed != null ? `${row.speed} kt` : "—"),
  );
  card.append(top, seen, metrics);

  if (row.sightings && row.sightings.length) {
    const count = document.createElement("div");
    count.className = "ar-zone-count";
    count.textContent = `${row.sightings.length} captura(s) en 24 h`;
    const table = document.createElement("table");
    table.className = "ar-zone-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const title of ["Fecha y hora", "Altitud (ft)", "Velocidad (kt)", "Distancia (km)"]) {
      const th = document.createElement("th");
      th.textContent = title;
      headRow.append(th);
    }
    head.append(headRow);
    const body = document.createElement("tbody");
    for (const s of row.sightings) {
      const tr = document.createElement("tr");
      const distance = s.distance_km != null ? s.distance_km.toFixed(1) : "—";
      for (const value of [formatDateTime(s.timestamp), s.altitude ?? "—", s.speed ?? "—", distance]) {
        const td = document.createElement("td");
        td.textContent = String(value);
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(head, body);
    card.append(count, table);
  }
  return card;
}

// Live aircraft in the same row shape as the zone rows. A live aircraft without
// a last-seen time cannot be ordered, so it is left out of the list.
const liveAsRow = (a) => ({
  icao: a.icao,
  callsign: a.callsign,
  registration: a.registration,
  timestamp: a.lastSeen,
  altitude: a.altitudeFt ?? null,
  speed: a.speedKt ?? null,
  sightings: [],
});

// One card per aircraft. When an aircraft is both live and in the zone, the
// newer last-seen time wins, and the zone captures stay in its card.
function mergedRows() {
  const byIcao = new Map();
  for (const z of zoneRows) byIcao.set(z.icao, { ...z, live: false });
  for (const a of liveRows) {
    if (typeof a.lastSeen !== "number") continue;
    const row = liveAsRow(a);
    const prev = byIcao.get(row.icao);
    if (!prev) {
      byIcao.set(row.icao, { ...row, live: true });
    } else if (row.timestamp > prev.timestamp) {
      byIcao.set(row.icao, { ...prev, ...row, sightings: prev.sightings, live: true });
    } else {
      prev.live = true;
    }
  }
  return [...byIcao.values()].sort((a, b) => b.timestamp - a.timestamp);
}

function renderAll() {
  cardsEl.innerHTML = "";
  for (const row of mergedRows()) cardsEl.append(buildCard(row, row.live));
}

async function refreshZone() {
  try {
    const res = await fetch("/api/aircraft/zone");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    zoneRows = await res.json();
    renderAll();
  } catch (err) {
    console.warn("[aircraft-zone] refresh failed:", err);
  }
}

window.AircraftZone = {
  // Called by aircraft-radar.js on every live snapshot.
  setLive(aircraft) {
    liveRows = Array.isArray(aircraft) ? aircraft : [];
    renderAll();
  },
};

refreshZone();
setInterval(refreshZone, REFRESH_MS);
