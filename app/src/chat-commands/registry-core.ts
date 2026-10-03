export type ReadOnlyCommand = { alias: string; toolName: string; description: string };

// Explicit Spanish aliases for each read-only function. A function missing from
// this map still gets a command, named from its function name.
export const READ_ONLY_ALIASES: Record<string, string> = {
  getNearbyAircraft: "aviones",
  getNearestAircraft: "avion-cercano",
  getAircraftDetails: "avion",
  getAircraftHistory: "historial-avion",
  getWifiRadarStatus: "wifi",
  getWifiConnectionStatus: "conexion-wifi",
  getGnssStatus: "gps",
  getWardriveDriveStatus: "wardrive",
  getWifiAuditStatus: "auditoria",
  listCapturedHandshakes: "handshakes",
};

// Spanish descriptions shown by /help. The function descriptions are written
// for the model in English; the chat user reads these instead.
export const READ_ONLY_DESCRIPTIONS: Record<string, string> = {
  getNearbyAircraft: "aviones en la zona de 24 h, con su última vista",
  getNearestAircraft: "el avión más cercano a Akbal ahora mismo",
  getAircraftDetails: "datos de un avión por ICAO, matrícula o aerolínea",
  getAircraftHistory: "aviones vistos en los últimos minutos",
  getWifiRadarStatus: "redes WiFi cercanas del radar; con nombre, busca esa red",
  getWifiConnectionStatus: "a qué red WiFi está conectada la Pi",
  getGnssStatus: "estado del GPS: fix y satélites",
  getWardriveDriveStatus: "estado de la sesión de wardriving",
  getWifiAuditStatus: "estado de la auditoría WiFi del laboratorio",
  listCapturedHandshakes: "handshakes capturados hasta ahora",
};

// Actions stay out of the chat commands in this version (see the spec).
const ACTION_FUNCTIONS = new Set(["scanNearbyWifiNetworks"]);

const kebab = (name: string): string =>
  name
    .replace(/^get/, "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();

// Two functions landing on the same alias is a configuration error: it throws
// instead of picking one silently.
export const buildCommandRegistry = (
  descriptors: { name: string; description: string }[],
  aliases: Record<string, string> = READ_ONLY_ALIASES,
): ReadOnlyCommand[] => {
  const seen = new Map<string, string>();
  const out: ReadOnlyCommand[] = [];
  for (const d of descriptors) {
    if (ACTION_FUNCTIONS.has(d.name)) continue;
    const alias = (aliases[d.name] || kebab(d.name)).toLowerCase();
    const previous = seen.get(alias);
    if (previous) throw new Error(`alias "${alias}" ya está en uso por ${previous}`);
    seen.set(alias, d.name);
    out.push({ alias, toolName: d.name, description: READ_ONLY_DESCRIPTIONS[d.name] || d.description });
  }
  return out;
};

export const findCommand = (registry: ReadOnlyCommand[], name: string): ReadOnlyCommand | null => {
  const wanted = name.toLowerCase();
  return registry.find((c) => c.alias === wanted) || null;
};
