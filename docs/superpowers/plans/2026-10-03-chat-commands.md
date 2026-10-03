# Comandos en el chat web — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Comandos directos en el chat web (`/aviones`, `/wifi`, `/gps`, `/wardrive`, `/estado`, `/help`, `/ask`) que responden con datos del sistema, sin pasar por el LLM, salvo `/ask`.

**Architecture:** Un analizador puro decide si el mensaje es comando, `/ask` o texto normal. Un registro puro construye un comando por cada función de solo lectura del admin, con alias explícito. Cada comando lee su fuente de datos (no el texto de la herramienta) y un formateador puro lo convierte en texto fijo. La ruta `POST /api/commands/run` ejecuta el comando y guarda el par comando/respuesta en el chat activo.

**Tech Stack:** TypeScript (ES2020, CommonJS, strict), Koa, `node:test`, JS vanilla en el admin.

**Spec:** `docs/superpowers/specs/2026-10-03-chat-commands-design.md`

## Global Constraints

- TypeScript ES2020, CommonJS, `strict`. Imports relativos dentro de `src/`.
- Archivos kebab-case. Comentarios en inglés, solo para el "por qué". Textos de usuario en español con tuteo.
- Solo lectura en esta versión: `scanNearbyWifiNetworks` y cualquier acción quedan fuera.
- Números, unidades y horas salen de los datos. El LLM no escribe cifras en los comandos.
- Verificación local: `cd app && npx tsc -p .` y `node --test dist/chat-commands/`. Nunca `npm run build` en el repo local.
- Cada tarea termina con un commit y con las pruebas de su módulo en verde.

## Review Focus

1. `/wifi <red>` con una red que no existe: debe decir que no existe, no inventar una.
2. Radar, GPS o wardrive apagado o sin datos: el comando dice "sin datos" con el motivo, no muestra cero como si fuera un dato.
3. Un comando desconocido, o uno con espacios y mayúsculas (`/Aviones `): responde con ayuda, no falla.
4. Un alias que choca con otro: el registro falla al construirse, no elige uno en silencio.
5. Un comando se escribe mientras el chat está respondiendo: no se mezcla con el stream en curso.

---

## File Structure

**Create:**
- `app/src/chat-commands/parse.ts` — clasifica el mensaje (comando, `/ask`, `/help`, texto).
- `app/src/chat-commands/parse.test.ts`
- `app/src/chat-commands/registry.ts` — alias, nombres derivados, colisiones, lista de solo lectura.
- `app/src/chat-commands/registry.test.ts`
- `app/src/chat-commands/format.ts` — formateadores puros de texto fijo.
- `app/src/chat-commands/format.test.ts`
- `app/src/chat-commands/help.ts` — texto de `/help` desde el registro.
- `app/src/chat-commands/help.test.ts`
- `app/src/chat-commands/sources.ts` — lectura de fuentes de datos (zona, radar WiFi, GPS, wardrive, sistema).
- `app/src/device/chat-commands-routes.ts` — `POST /api/commands/run`.

**Modify:**
- `app/src/config/admin-tools/registry.ts` — exportar `ADMIN_TOOL_DESCRIPTORS`.
- `app/src/device/web-admin-server.ts` — registrar la ruta nueva.
- `app/web/admin/app.js` — interceptar mensajes que empiezan con `/` antes de `sendMessage`.

---

### Task 1: Analizador de mensajes

**Files:**
- Create: `app/src/chat-commands/parse.ts`
- Test: `app/src/chat-commands/parse.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `type Parsed = { kind: "text" } | { kind: "help" } | { kind: "ask"; text: string } | { kind: "command"; name: string; args: string }` y `parseMessage(input: string): Parsed`.

- [ ] **Step 1: Escribir la prueba que falla**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessage } from "./parse";

test("plain text goes to the LLM", () => {
  assert.deepEqual(parseMessage("hola, ¿cómo estás?"), { kind: "text" });
});

test("/help is its own kind", () => {
  assert.deepEqual(parseMessage("/help"), { kind: "help" });
});

test("/ask keeps the rest of the message for the LLM", () => {
  assert.deepEqual(parseMessage("/ask ¿qué es un handshake?"), {
    kind: "ask",
    text: "¿qué es un handshake?",
  });
});

test("a command name is lowercased and its argument is trimmed", () => {
  assert.deepEqual(parseMessage("  /WiFi   akbal_lab  "), {
    kind: "command",
    name: "wifi",
    args: "akbal_lab",
  });
});

test("a command without argument has empty args", () => {
  assert.deepEqual(parseMessage("/aviones"), { kind: "command", name: "aviones", args: "" });
});

test("a lone slash is a command with no name", () => {
  assert.deepEqual(parseMessage("/"), { kind: "command", name: "", args: "" });
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run (desde `app/`): `npx tsc -p . 2>&1 | grep parse` → `Cannot find module './parse'`.

- [ ] **Step 3: Implementar**

```ts
export type Parsed =
  | { kind: "text" }
  | { kind: "help" }
  | { kind: "ask"; text: string }
  | { kind: "command"; name: string; args: string };

// A message starting with "/" is a command; everything else is for the LLM.
// /help and /ask are the two words that never reach the command registry.
export const parseMessage = (input: string): Parsed => {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { kind: "text" };
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = (head || "").toLowerCase();
  const args = rest.join(" ").trim();
  if (name === "help") return { kind: "help" };
  if (name === "ask") return { kind: "ask", text: args };
  return { kind: "command", name, args };
};
```

- [ ] **Step 4: Ejecutar pruebas**

Run: `npx tsc -p . && node --test dist/chat-commands/parse.test.js` → 6 pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/chat-commands/parse.ts app/src/chat-commands/parse.test.ts
git commit -m "feat(chat-commands): analizador de mensajes con /help, /ask y comandos"
```

---

### Task 2: Registro de comandos

**Files:**
- Modify: `app/src/config/admin-tools/registry.ts` (exportar `ADMIN_TOOL_DESCRIPTORS`)
- Create: `app/src/chat-commands/registry.ts`
- Test: `app/src/chat-commands/registry.test.ts`

**Interfaces:**
- Consumes: `AdminToolDescriptor` (`config/admin-tools/types.ts`) con `tool.function.name` y `tool.function.description`.
- Produces: `type ReadOnlyCommand = { alias: string; toolName: string; description: string }`; `READ_ONLY_ALIASES: Record<string, string>` (alias explícito por función de solo lectura); `buildCommandRegistry(descriptors: { name: string; description: string }[], aliases?: Record<string, string>): ReadOnlyCommand[]`; `findCommand(registry, name): ReadOnlyCommand | null`.

- [ ] **Step 1: Exportar los descriptores** — en `registry.ts`, cambiar `const ADMIN_TOOL_DESCRIPTORS` por `export const ADMIN_TOOL_DESCRIPTORS`.

- [ ] **Step 2: Escribir la prueba que falla**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommandRegistry, findCommand, READ_ONLY_ALIASES } from "./registry";

const fns = [
  { name: "getNearbyAircraft", description: "lista aviones" },
  { name: "getWifiRadarStatus", description: "radar wifi" },
  { name: "scanNearbyWifiNetworks", description: "escanea" },
  { name: "getGnssStatus", description: "gps" },
];

test("aliases come from the explicit map", () => {
  const reg = buildCommandRegistry(fns, { getNearbyAircraft: "aviones", getWifiRadarStatus: "wifi", getGnssStatus: "gps" });
  assert.equal(findCommand(reg, "aviones")?.toolName, "getNearbyAircraft");
});

test("a function without an alias gets a derived kebab-case name", () => {
  const reg = buildCommandRegistry([{ name: "getGnssStatus", description: "gps" }], {});
  assert.equal(findCommand(reg, "gnss-status")?.toolName, "getGnssStatus");
});

test("action functions are never registered as commands", () => {
  const reg = buildCommandRegistry(fns, {});
  assert.equal(reg.some((c) => c.toolName === "scanNearbyWifiNetworks"), false);
});

test("two functions with the same alias fail loudly", () => {
  assert.throws(
    () => buildCommandRegistry(fns, { getNearbyAircraft: "x", getWifiRadarStatus: "x" }),
    /alias "x" ya está en uso/,
  );
});

test("lookup is case-insensitive and returns null for unknown names", () => {
  const reg = buildCommandRegistry(fns, { getGnssStatus: "gps" });
  assert.equal(findCommand(reg, "GPS")?.toolName, "getGnssStatus");
  assert.equal(findCommand(reg, "nada"), null);
});

test("the shipped alias map covers every read-only function by name", () => {
  assert.equal(READ_ONLY_ALIASES.getNearbyAircraft, "aviones");
  assert.equal(READ_ONLY_ALIASES.getWifiRadarStatus, "wifi");
  assert.equal(READ_ONLY_ALIASES.getGnssStatus, "gps");
  assert.equal(READ_ONLY_ALIASES.getWardriveDriveStatus, "wardrive");
  assert.equal(READ_ONLY_ALIASES.getWifiAuditStatus, "auditoria");
  assert.equal(READ_ONLY_ALIASES.listCapturedHandshakes, "handshakes");
  assert.equal(READ_ONLY_ALIASES.getWifiConnectionStatus, "conexion-wifi");
  assert.equal(READ_ONLY_ALIASES.getNearestAircraft, "avion-cercano");
  assert.equal(READ_ONLY_ALIASES.getAircraftDetails, "avion");
  assert.equal(READ_ONLY_ALIASES.getAircraftHistory, "historial-avion");
});
```

- [ ] **Step 3: Ejecutar y ver que falla** (módulo inexistente).

- [ ] **Step 4: Implementar**

```ts
import { ADMIN_TOOL_DESCRIPTORS } from "../config/admin-tools/registry";

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

const ACTION_FUNCTIONS = new Set(["scanNearbyWifiNetworks"]);

const kebab = (name: string): string =>
  name
    .replace(/^get/, "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();

// Builds one command per read-only function. Two functions landing on the same
// alias is a configuration error: it throws instead of picking one silently.
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
    out.push({ alias, toolName: d.name, description: d.description });
  }
  return out;
};

export const findCommand = (registry: ReadOnlyCommand[], name: string): ReadOnlyCommand | null => {
  const wanted = name.toLowerCase();
  return registry.find((c) => c.alias === wanted) || null;
};

// The live registry, built from the admin tools so /help never drifts from them.
export const commandRegistry = (): ReadOnlyCommand[] =>
  buildCommandRegistry(
    ADMIN_TOOL_DESCRIPTORS.map((d) => ({ name: d.tool.function.name, description: d.tool.function.description })),
  );
```

- [ ] **Step 5: Ejecutar pruebas** → 6 pass. Nota: el test de alias usa `aliases` explícito; `buildCommandRegistry` sin segundo argumento usa el mapa real.

- [ ] **Step 6: Commit** — `feat(chat-commands): registro de comandos desde las funciones de solo lectura`.

---

### Task 3: Formateadores de texto fijo

**Files:**
- Create: `app/src/chat-commands/format.ts`
- Test: `app/src/chat-commands/format.test.ts`

**Interfaces:**
- Consumes: tipos de datos de Task 4 (`AircraftRow`, `AccessPointRow`, `GnssRow`, `WardriveRow`, `SystemRow`).
- Produces: `formatAircraft(rows: AircraftRow[]): string`, `formatWifi(aps: AccessPointRow[], query: string): string`, `formatGnss(g: GnssRow | null): string`, `formatWardrive(w: WardriveRow | null): string`, `formatSystem(s: SystemRow): string`, `formatGeneric(text: string): string`.

Estas son las formas de datos (las define `sources.ts` en Task 4; aquí se usan como tipos):

```ts
export type AircraftRow = { icao: string; callsign: string | null; registration: string | null; timestamp: number; altitude: number | null; speed: number | null };
export type AccessPointRow = { ssid: string | null; channel: number | null; rssi: number | null; security: string | null; clients: number | null };
export type GnssRow = { hasFix: boolean; satellitesUsed: number | null; hdop: number | null };
export type WardriveRow = { active: boolean; distanceM: number | null; networks: number | null; handshakes: number | null };
export type SystemRow = { radarMode: string; gpsFix: boolean; clock: string; memUsedPct: number };
```

- [ ] **Step 1: Escribir la prueba que falla**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAircraft, formatWifi, formatGnss, formatGeneric } from "./format";

test("aircraft: a count line and one line per aircraft, time from the data", () => {
  const out = formatAircraft([
    { icao: "AMX217", callsign: "AMX217", registration: null, timestamp: Date.UTC(2026, 9, 3, 17, 1, 7), altitude: 9450, speed: 244 },
  ]);
  assert.match(out, /^✈ 1 avión/);
  assert.match(out, /AMX217 · visto .*17:01:07|AMX217 · visto .*11:01:07/);
  assert.match(out, /9450 ft · 244 kt/);
});

test("aircraft: an empty zone says so, it never shows zero as data", () => {
  assert.equal(formatAircraft([]), "Sin aviones en la zona en las últimas 24 h.");
});

test("wifi: a named network that is found shows its channel, signal and security", () => {
  const out = formatWifi(
    [{ ssid: "akbal_lab", channel: 11, rssi: -67, security: "WPA2/WPA3", clients: 0 }],
    "akbal_lab",
  );
  assert.equal(out, "akbal_lab · canal 11 · -67 dBm · WPA2/WPA3 · 0 clientes");
});

test("wifi: a name that is not found says so and never invents a network", () => {
  assert.equal(formatWifi([], "fantasma"), 'No se encontró ninguna red llamada "fantasma".');
});

test("gps: no fix is said plainly, not shown as coordinates", () => {
  assert.equal(formatGnss({ hasFix: false, satellitesUsed: null, hdop: null }), "GPS sin fix.");
  assert.equal(formatGnss(null), "GPS sin datos.");
});

test("generic: a tool's own text is passed through unchanged", () => {
  assert.equal(formatGeneric("3 access point(s)."), "3 access point(s).");
});
```

- [ ] **Step 2: Ejecutar y ver que falla.**

- [ ] **Step 3: Implementar**

```ts
export type AircraftRow = { icao: string; callsign: string | null; registration: string | null; timestamp: number; altitude: number | null; speed: number | null };
export type AccessPointRow = { ssid: string | null; channel: number | null; rssi: number | null; security: string | null; clients: number | null };
export type GnssRow = { hasFix: boolean; satellitesUsed: number | null; hdop: number | null };
export type WardriveRow = { active: boolean; distanceM: number | null; networks: number | null; handshakes: number | null };
export type SystemRow = { radarMode: string; gpsFix: boolean; clock: string; memUsedPct: number };

const hhmmss = (ms: number): string =>
  new Date(ms).toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const formatAircraft = (rows: AircraftRow[]): string => {
  if (rows.length === 0) return "Sin aviones en la zona en las últimas 24 h.";
  const head = `✈ ${rows.length} avión${rows.length === 1 ? "" : "es"} en la zona (24 h)`;
  const lines = rows.map((r) => {
    const name = r.callsign?.trim() || r.registration || r.icao;
    const alt = r.altitude != null ? `${r.altitude} ft` : "— ft";
    const spd = r.speed != null ? `${r.speed} kt` : "— kt";
    return `${name} · visto ${hhmmss(r.timestamp)} · ${alt} · ${spd}`;
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
  [
    `Radar: ${s.radarMode}`,
    `GPS: ${s.gpsFix ? "con fix" : "sin fix"}`,
    `Reloj: ${s.clock}`,
    `Memoria usada: ${s.memUsedPct}%`,
  ].join("\n");

// Tools without a structured source yet answer with their own text, unchanged.
export const formatGeneric = (text: string): string => text;
```

- [ ] **Step 4: Ejecutar pruebas** → 6 pass.

- [ ] **Step 5: Commit** — `feat(chat-commands): formateadores de texto fijo`.

---

### Task 4: Fuentes de datos

**Files:**
- Create: `app/src/chat-commands/sources.ts`
- Test: `app/src/chat-commands/sources.test.ts`

**Interfaces:**
- Consumes: `getZoneRecent`, `getSightingsForIcao` (`services/adsb/history.ts`); `SIGHTING_WINDOW_MS` (`services/adsb/zone.ts`); `getWifiRadarSnapshot` (`wifiradar/service.ts:304`); `getGnssSnapshot` (`services/gnss/service.ts`); `getDriveWardriveService` (`wardrive/service.ts`) — usa el mismo método de estado que `getWardriveDriveStatus` en `config/admin-tools/wardrive-tools.ts`; `getWifiStatus` (`utils/wifi.ts`).
- Produces: `readAircraft(now: number): AircraftRow[]`, `readWifi(query: string): AccessPointRow[]`, `readGnss(): GnssRow | null`, `readWardrive(): WardriveRow | null`, `readSystem(now: number): SystemRow`. Cada lector devuelve datos estructurados; nunca texto.

- [ ] **Step 1: Escribir la prueba que falla.** La prueba cubre la función pura que convierte la snapshot del radar en filas, con datos falsos:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toAccessPointRows } from "./sources";

test("access points keep only the fields the formatter needs, and filter by name", () => {
  const rows = toAccessPointRows(
    [
      { ssid: "akbal_lab", channel: 11, rssi: -67, security: "WPA2/WPA3", clients: 0, bssid: "A0:F3" },
      { ssid: "Otra", channel: 6, rssi: -80, security: "WPA2", clients: 2, bssid: "B1" },
    ],
    "akbal",
  );
  assert.deepEqual(rows, [{ ssid: "akbal_lab", channel: 11, rssi: -67, security: "WPA2/WPA3", clients: 0 }]);
});

test("without a name, the first fifteen access points are returned", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ ssid: `R${i}`, channel: 1, rssi: -50, security: "WPA2", clients: 0, bssid: `x${i}` }));
  assert.equal(toAccessPointRows(many, "").length, 15);
});
```

- [ ] **Step 2: Ejecutar y ver que falla.**

- [ ] **Step 3: Implementar.** `toAccessPointRows` es pura (testeable); los lectores llaman a los servicios reales:

```ts
import { getZoneRecent } from "../services/adsb/history";
import { SIGHTING_WINDOW_MS } from "../services/adsb/zone";
import { getWifiRadarSnapshot } from "../wifiradar/service";
import { getGnssSnapshot } from "../services/gnss/service";
import { getWifiStatus } from "../utils/wifi";
import { findAccessPoints } from "../config/admin-tools/ap-search";
import type { AircraftRow, AccessPointRow, GnssRow, WardriveRow, SystemRow } from "./format";

export const toAccessPointRows = (
  aps: { ssid: string | null; channel: number | null; rssi: number | null; security: string | null; clients: number | null }[],
  query: string,
): AccessPointRow[] =>
  findAccessPoints(aps, query || undefined).map((a) => ({
    ssid: a.ssid,
    channel: a.channel,
    rssi: a.rssi,
    security: a.security,
    clients: a.clients,
  }));

export const readAircraft = (now: number): AircraftRow[] =>
  getZoneRecent(now - SIGHTING_WINDOW_MS).map((r) => ({
    icao: r.icao,
    callsign: r.callsign,
    registration: r.registration,
    timestamp: r.timestamp,
    altitude: r.altitude,
    speed: r.speed,
  }));

export const readWifi = (query: string): AccessPointRow[] =>
  toAccessPointRows(getWifiRadarSnapshot().accessPoints, query);

export const readGnss = (): GnssRow | null => {
  const g = getGnssSnapshot();
  if (!g) return null;
  return { hasFix: Boolean(g.hasFix), satellitesUsed: g.satellitesUsed ?? null, hdop: g.hdop ?? null };
};

// Wardrive status comes from the same service method the admin tool uses; see
// wardrive-tools.ts (getWardriveDriveStatus) before implementing this reader.
export const readWardrive = (): WardriveRow | null => null;

export const readSystem = (now: number): SystemRow => ({
  radarMode: getWifiRadarSnapshot().mode,
  gpsFix: Boolean(getGnssSnapshot()?.hasFix),
  clock: new Date(now).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }),
  memUsedPct: 0,
});
```

- [ ] **Step 4: Completar `readWardrive` y `memUsedPct`.** Antes de cerrar la tarea, leer `config/admin-tools/wardrive-tools.ts` (la función `getWardriveDriveStatus`) y `utils/system-stats` para la memoria; sustituir `readWardrive` y `memUsedPct: 0` por la lectura real. Si una fuente no existe, el lector devuelve `null` y el formateador dice "sin datos". Cada cambio con su prueba.

- [ ] **Step 5: Ejecutar pruebas** → 2 pass; `npx tsc -p .` sin errores.

- [ ] **Step 6: Commit** — `feat(chat-commands): fuentes de datos estructuradas para los comandos`.

---

### Task 5: Texto de /help y ruta de ejecución

**Files:**
- Create: `app/src/chat-commands/help.ts`, `app/src/chat-commands/help.test.ts`
- Create: `app/src/device/chat-commands-routes.ts`
- Modify: `app/src/device/web-admin-server.ts` (registrar la ruta)

**Interfaces:**
- Consumes: `ReadOnlyCommand`, `commandRegistry`, `findCommand` (Task 2); `parseMessage` (Task 1); formateadores (Task 3); lectores (Task 4); `chatStore` (`device/chat-history-routes.ts`).
- Produces: `buildHelp(registry: ReadOnlyCommand[]): string` y `POST /api/commands/run` con cuerpo `{ chatId: string | null, text: string }`, respuesta `{ chatId: string, reply: string }`.

- [ ] **Step 1: Prueba que falla para `/help`:**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHelp } from "./help";

test("help lists every command with its description, one line each", () => {
  const out = buildHelp([
    { alias: "aviones", toolName: "getNearbyAircraft", description: "lista aviones" },
    { alias: "gps", toolName: "getGnssStatus", description: "estado del GPS" },
  ]);
  assert.match(out, /\/aviones · lista aviones/);
  assert.match(out, /\/gps · estado del GPS/);
  assert.match(out, /\/ask/);
});
```

- [ ] **Step 2: Ejecutar y ver que falla.**

- [ ] **Step 3: Implementar `buildHelp`:**

```ts
import { ReadOnlyCommand } from "./registry";

// Built from the registry, so a new read-only function shows up here with no edit.
export const buildHelp = (registry: ReadOnlyCommand[]): string => {
  const lines = registry.map((c) => `/${c.alias} · ${c.description}`);
  return ["Comandos disponibles:", ...lines, "/ask <pregunta> · pregunta abierta al LLM local"].join("\n");
};
```

- [ ] **Step 4: Ruta `POST /api/commands/run`.** En `chat-commands-routes.ts`: parsear con `parseMessage`; si `help` → texto de `buildHelp(commandRegistry())`; si `command` → `findCommand`; si no existe → `Comando no existe. Escribe /help.`; si existe → leer su fuente (Task 4), formatear (Task 3) y responder. Guardar en el chat: si `chatId` es null se crea con `chatStore.createWithMessage(model, "user", text)`; si no, `appendMessage`. Luego `appendMessage(chat.id, "assistant", reply)`. Si la función lanza error, responder `Error al leer <alias>: <motivo corto>` sin datos inventados. Un test de integración manual en Task 7; aquí basta compilar.

- [ ] **Step 5: Registrar la ruta** en `web-admin-server.ts`, junto a `registerChatHistoryRoutes(router)`: `registerChatCommandRoutes(router)`.

- [ ] **Step 6: Commit** — `feat(chat-commands): /help y ruta POST /api/commands/run`.

---

### Task 6: Interfaz: interceptar comandos en el chat

**Files:**
- Modify: `app/web/admin/app.js` (función `chatForm` submit, antes de `sendMessage`)

**Interfaces:**
- Consumes: `POST /api/commands/run` (Task 5); `activeChatId`; `ChatHistory.refresh`.
- Produces: un comando escrito en el chat no inicia el stream del LLM; `/ask` quita el prefijo y sigue como texto normal.

- [ ] **Step 1: Interceptar el envío.** Dentro del listener de `chatForm` submit, después de leer `text`, antes de `sendMessage(text)`:

```js
const parsed = /^\s*\/(\S*)/.test(text) ? text : null;
if (parsed && !/^\s*\/ask\b/i.test(text)) {
  void runCommand(text);
  return;
}
if (/^\s*\/ask\b/i.test(text)) text = text.replace(/^\s*\/ask\s*/i, "");
void sendMessage(text);
```

- [ ] **Step 2: Función `runCommand`:**

```js
async function runCommand(text) {
  addMessage("user", text);
  try {
    const res = await fetch("/api/commands/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: activeChatId, text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    activeChatId = data.chatId;
    ChatHistory.setActive(activeChatId);
    addMessage("assistant", data.reply);
  } catch (err) {
    addMessage("system", `(error: ${err.message})`);
  } finally {
    ChatHistory.refresh();
  }
}
```

- [ ] **Step 3: Comprobar sintaxis:** `node --check web/admin/app.js`.

- [ ] **Step 4: Commit** — `feat(web-admin): los comandos del chat no pasan por el LLM`.

---

### Task 7: Validación en la Pi

Requiere permiso explícito para `whisplay update` y reinicio del servicio.

- [ ] **Step 1:** `node --test dist/chat-commands/` en el repo local (todas las pruebas puras en verde).
- [ ] **Step 2:** Desplegar (`git pull`, `whisplay update`, `whisplay service restart`).
- [ ] **Step 3:** Desde la sesión de admin en `/#chat`: `/help`, `/aviones`, `/wifi akbal_lab`, `/wifi fantasma`, `/gps`, `/wardrive`, `/estado`, `/Aviones ` (con mayúsculas y espacio), `/inexistente`.
- [ ] **Step 4:** `/ask` con una pregunta de aviones: debe responder el LLM con herramientas de lectura.
- [ ] **Step 5:** Verificar que cada comando quedó guardado en el chat activo y que el historial lo muestra.
- [ ] **Step 6:** Anotar en el ledger lo que no se pudo probar (por ejemplo, radar apagado).

---

## Self-Review

- **Cobertura del spec:** analizador (T1), registro con alias y colisiones (T2), formato fijo (T3), fuentes de datos (T4), `/help` y ruta de ejecución con persistencia (T5), interfaz (T6), validación (T7). El texto sin `/` sigue al LLM sin cambios (T6 no lo toca).
- **Review Focus:** 1 → T3 (`formatWifi` sin red) y T7 paso 3; 2 → T3 (`formatGnss`) y T4; 3 → T1 (`/Aviones `) y T5 (comando inexistente); 4 → T2 (colisión lanza error); 5 → T6 (un comando no inicia el stream).
- **Decisión que se apartó del spec:** el spec decía que los comandos llaman la función del admin; las funciones devuelven texto, así que los comandos leen la fuente de datos. Queda registrado en Task 4.
- **Huecos conocidos:** `readWardrive` y la memoria (`memUsedPct`) están marcados en Task 4 paso 4; no se pueden cerrar sin leer dos archivos más al ejecutar.
- **Tipos:** `AircraftRow`, `AccessPointRow`, `GnssRow`, `WardriveRow`, `SystemRow`, `ReadOnlyCommand` y `Parsed` se usan con los mismos nombres en todas las tareas.

---

**Plan complete and saved to `docs/superpowers/plans/2026-10-03-chat-commands.md`.** Lo revisas y eliges método de ejecución: **Native** (recomendado, las tareas están acopladas) o **Subagent-driven**.
