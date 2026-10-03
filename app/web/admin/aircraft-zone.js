// Zone cards for the aircraft radar page: one card per aircraft captured inside
// the zone around Akbal in the last 24 hours, newest first. Each card carries
// its own captures (date, time, altitude, speed). The server is the source of
// truth; this only renders what /api/aircraft/zone returns.

const cardsEl = document.getElementById("ar-zone-cards");

const REFRESH_MS = 30_000;

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

function buildCard(row) {
  const card = document.createElement("div");
  card.className = "ar-card ar-zone-card";
  card.dataset.icao = row.icao;

  const top = document.createElement("div");
  top.className = "ar-card-top";
  top.append(cell(label(row), "ar-flight"), cell(row.registration || row.icao, "ar-reg"));

  const seen = document.createElement("div");
  seen.className = "ar-zone-seen";
  seen.textContent = `visto: ${formatDateTime(row.timestamp)}`;

  const metrics = document.createElement("div");
  metrics.className = "ar-card-metrics";
  metrics.append(
    cell(row.altitude != null ? `${row.altitude} ft` : "—"),
    cell(row.speed != null ? `${row.speed} kt` : "—"),
  );

  const count = document.createElement("div");
  count.className = "ar-zone-count";
  count.textContent = `${row.sightings.length} captura(s) en 24 h`;

  const table = document.createElement("table");
  table.className = "ar-zone-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const title of ["Fecha y hora", "Altitud (ft)", "Velocidad (kt)"]) {
    const th = document.createElement("th");
    th.textContent = title;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const s of row.sightings) {
    const tr = document.createElement("tr");
    for (const value of [formatDateTime(s.timestamp), s.altitude ?? "—", s.speed ?? "—"]) {
      const td = document.createElement("td");
      td.textContent = String(value);
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);

  card.append(top, seen, metrics, count, table);
  return card;
}

function renderCards(rows) {
  cardsEl.innerHTML = "";
  for (const row of rows) cardsEl.append(buildCard(row));
}

async function refresh() {
  try {
    const res = await fetch("/api/aircraft/zone");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderCards(await res.json());
  } catch (err) {
    console.warn("[aircraft-zone] refresh failed:", err);
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
