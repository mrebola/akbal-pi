import { LLMTool, ToolReturnTag } from "../type";
import { getAircraftRadarSnapshot, getAircraftByIcao } from "../services/adsb/service";
import { getRecentHistory, getHistoryForIcao } from "../services/adsb/history";
import { Aircraft } from "../services/adsb/types";

// Aircraft Radar agent tools (docs/aircraft-radar.md) — lets the LLM answer
// natural-language questions about nearby air traffic. Same shape as the
// other src/config/*.ts tool modules (see local-memory.ts, web-search.ts):
// an array of LLMTool built up conditionally, exported via addXTools().
export const aircraftRadarTools: LLMTool[] = [];

const enabled = (process.env.ADSB_ENABLED || "true").toLowerCase() !== "false";

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function compass(deg: number): string {
  return COMPASS[Math.round(deg / 45) % 8];
}

function describe(aircraft: Aircraft): string {
  const name = aircraft.callsign || aircraft.icao;
  const identity = [aircraft.registration, aircraft.manufacturer, aircraft.model]
    .filter(Boolean)
    .join(" ");
  // Prefer the operating airline (from the callsign route lookup) over the
  // airframe's registered owner — they can differ on a leased/chartered
  // aircraft, and the airline is what a spoken answer actually means by
  // "¿de qué aerolínea es?".
  const operatorName = aircraft.airline || aircraft.operator;
  const operator = operatorName ? ` de ${operatorName}` : "";
  const route =
    aircraft.origin && aircraft.destination ? `${aircraft.origin} → ${aircraft.destination}` : "ruta desconocida";
  const distance =
    aircraft.distanceKm === null
      ? "sin fix GPS de Akbal, no se puede calcular distancia"
      : `${aircraft.distanceKm.toFixed(1)}km al ${compass(aircraft.bearingDeg ?? 0)}`;
  const alt = aircraft.altitudeFt !== null ? `${aircraft.altitudeFt}ft` : "altitud desconocida";
  const speed = aircraft.speedKt !== null ? `${aircraft.speedKt}kt` : "velocidad desconocida";
  return `${name}${identity ? ` (${identity}${operator})` : operator}, ${route}, ${alt}, ${speed}, ${distance}, ICAO ${aircraft.icao}`;
}

function matchesQuery(aircraft: Aircraft, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return [aircraft.icao, aircraft.callsign, aircraft.registration, aircraft.airline, aircraft.operator, aircraft.model]
    .filter((v): v is string => Boolean(v))
    .some((v) => v.toLowerCase().includes(q));
}

if (enabled) {
  aircraftRadarTools.push(
    {
      type: "function",
      function: {
        name: "getNearbyAircraft",
        description:
          "List aircraft currently detected by Akbal's ADS-B receiver (HackRF), sorted by distance. Use for questions like '¿qué aviones están pasando?' or '¿qué aviones hay cerca?'.",
        parameters: {},
      },
      func: async () => {
        const snapshot = getAircraftRadarSnapshot();
        if (snapshot.aircraft.length === 0) {
          return `${ToolReturnTag.Success}No hay aeronaves detectadas en este momento.`;
        }
        const demoNote = snapshot.demo ? " (modo demo, datos sintéticos)" : "";
        const lines = snapshot.aircraft.map((a) => `- ${describe(a)}`).join("\n");
        return `${ToolReturnTag.Success}${snapshot.aircraft.length} aeronave(s) detectada(s)${demoNote}:\n${lines}`;
      },
    },
    {
      type: "function",
      function: {
        name: "getNearestAircraft",
        description:
          "Get the single closest aircraft to Akbal right now, with distance and bearing. Use for '¿qué avión está más cerca?'.",
        parameters: {},
      },
      func: async () => {
        const snapshot = getAircraftRadarSnapshot();
        const nearest = snapshot.aircraft.find((a) => a.distanceKm !== null) || snapshot.aircraft[0];
        if (!nearest) return `${ToolReturnTag.Success}No hay aeronaves detectadas en este momento.`;
        return `${ToolReturnTag.Success}${describe(nearest)}`;
      },
    },
    {
      type: "function",
      function: {
        name: "getAircraftDetails",
        description:
          "Find one currently-tracked aircraft by ICAO24 hex code, callsign, registration, or operator/airline name (partial match, e.g. 'Volaris' or '0D1005'). Returns its route, altitude, speed, distance and bearing. Use for '¿de dónde viene ese Volaris?', '¿a dónde va?', '¿a qué distancia está el avión 0D1005?'. If the route can't be resolved, say so as 'Route unknown' — never guess an origin or destination.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "ICAO24 hex, callsign, registration, or operator/airline name to search for",
            },
          },
          required: ["query"],
        },
      },
      func: async (params: { query: string }) => {
        const snapshot = getAircraftRadarSnapshot();
        const direct = getAircraftByIcao(params.query);
        const match = direct || snapshot.aircraft.find((a) => matchesQuery(a, params.query));
        if (!match) {
          return `${ToolReturnTag.Error}No se encontró ninguna aeronave que coincida con "${params.query}" entre las detectadas actualmente.`;
        }
        return `${ToolReturnTag.Success}${describe(match)}`;
      },
    },
    {
      type: "function",
      function: {
        name: "getAircraftHistory",
        description:
          "List aircraft seen by Akbal's ADS-B receiver in the last N minutes (persisted history, includes aircraft no longer in range). Optionally filter by ICAO24. Use for '¿qué aviones pasaron en los últimos 30 minutos?'.",
        parameters: {
          type: "object",
          properties: {
            minutes: {
              type: "number",
              description: "How many minutes back to look (default 30)",
            },
            icao: {
              type: "string",
              description: "Optional ICAO24 hex code to filter history to a single aircraft",
            },
          },
        },
      },
      func: async (params: { minutes?: number; icao?: string }) => {
        const minutes = params.minutes && params.minutes > 0 ? params.minutes : 30;
        const rows = params.icao ? getHistoryForIcao(params.icao) : getRecentHistory(Date.now() - minutes * 60_000);
        if (rows.length === 0) {
          return `${ToolReturnTag.Success}No se registraron aeronaves en los últimos ${minutes} minuto(s).`;
        }
        const seen = new Map<string, (typeof rows)[number]>();
        for (const row of rows) if (!seen.has(row.icao)) seen.set(row.icao, row); // most recent per icao (rows are DESC)
        const lines = [...seen.values()]
          .map((r) => `- ${r.callsign || r.icao} (${r.icao}) · ${new Date(r.timestamp).toLocaleTimeString("es-MX")}`)
          .join("\n");
        return `${ToolReturnTag.Success}${seen.size} aeronave(s) distinta(s) en los últimos ${minutes} minuto(s):\n${lines}`;
      },
    },
  );
}

export const addAircraftRadarTools = (tools: LLMTool[]): void => {
  if (aircraftRadarTools.length > 0) {
    console.log(
      `[AircraftRadar] Adding ${aircraftRadarTools.length} tool(s): ${aircraftRadarTools
        .map((tool) => tool.function.name)
        .join(", ")}`,
    );
    tools.push(...aircraftRadarTools);
  }
};
