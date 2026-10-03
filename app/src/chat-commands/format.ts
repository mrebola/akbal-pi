// Row shapes the formatters read. The sources (sources.ts) build them from the
// services; formatters never call a service themselves.
export type AircraftRow = {
  icao: string;
  callsign: string | null;
  registration: string | null;
  timestamp: number;
  altitude: number | null;
  speed: number | null;
};
export type AccessPointRow = {
  ssid: string | null;
  channel: number | null;
  rssi: number | null;
  security: string | null;
  clients: number | null;
};
export type GnssRow = { hasFix: boolean; satellitesUsed: number | null; hdop: number | null };
export type WardriveRow = { active: boolean; distanceM: number | null; networks: number | null; handshakes: number | null };
export type SystemRow = { radarMode: string; gpsFix: boolean; clock: string; memUsedPct: number };

const seenAt = (ms: number): string =>
  new Date(ms).toLocaleString("es-MX", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export const formatAircraft = (rows: AircraftRow[]): string => {
  if (rows.length === 0) return "Sin aviones en la zona en las últimas 24 h.";
  const head = `✈ ${rows.length} avión${rows.length === 1 ? "" : "es"} en la zona (24 h)`;
  const lines = rows.map((r) => {
    const name = r.callsign?.trim() || r.registration || r.icao;
    const alt = r.altitude != null ? `${r.altitude} ft` : "— ft";
    const spd = r.speed != null ? `${r.speed} kt` : "— kt";
    return `${name} · visto ${seenAt(r.timestamp)} · ${alt} · ${spd}`;
  });
  return [head, ...lines].join("\n");
};

export const formatWifi = (aps: AccessPointRow[], query: string): string => {
  if (aps.length === 0) return query ? `No se encontró ninguna red llamada "${query}".` : "No hay redes detectadas.";
  return aps
    .map((a) => {
      const name = a.ssid || "(sin SSID)";
      const ch = a.channel != null ? `canal ${a.channel}` : "canal —";
      const sig = a.rssi != null ? `${a.rssi} dBm` : "— dBm";
      const sec = a.security || "—";
      const cli = a.clients != null ? `${a.clients} cliente${a.clients === 1 ? "" : "s"}` : "— clientes";
      return `${name} · ${ch} · ${sig} · ${sec} · ${cli}`;
    })
    .join("\n");
};

export const formatGnss = (g: GnssRow | null): string => {
  if (!g) return "GPS sin datos.";
  if (!g.hasFix) return "GPS sin fix.";
  const sats = g.satellitesUsed != null ? `${g.satellitesUsed} satélites` : "satélites —";
  const hdop = g.hdop != null ? `HDOP ${g.hdop}` : "HDOP —";
  return `GPS con fix · ${sats} · ${hdop}`;
};

export const formatWardrive = (w: WardriveRow | null): string => {
  if (!w) return "Wardrive sin datos.";
  const state = w.active ? "activo" : "inactivo";
  const dist = w.distanceM != null ? `${(w.distanceM / 1000).toFixed(1)} km` : "— km";
  return `Wardrive ${state} · ${dist} · ${w.networks ?? "—"} redes · ${w.handshakes ?? "—"} handshakes`;
};

export const formatSystem = (s: SystemRow): string =>
  [`Radar: ${s.radarMode}`, `GPS: ${s.gpsFix ? "con fix" : "sin fix"}`, `Reloj: ${s.clock}`, `Memoria usada: ${s.memUsedPct}%`].join("\n");

// Tools without a structured source answer with their own text, unchanged.
export const formatGeneric = (text: string): string => text;
