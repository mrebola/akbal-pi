# Akbal Vision — Hito 1 (Núcleo visible) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar el MVP visible de Akbal Vision: la cámara del equipo se ve en pantalla, MediaPipe detecta rostros, el tracker les asigna IDs estables, y un HUD cyberpunk hecho con Three.js sigue suavemente a cada rostro, todo como una sección más del admin de Akbal detrás del login.

**Architecture:** Frontend estático en ES Modules servido por el Koa del admin. Tres loops desacoplados (video nativo, vision throttled a 10-15 FPS, render rAF a 30-60 FPS). El *vision loop* corre MediaPipe FaceDetector y pasa las detecciones al `tracker` (lógica pura) que produce un `WorldState` canónico y emite eventos discretos al Event Bus; el *render loop* lee el `WorldState` y hace lerp del HUD. Separación estricta: la lógica pura (events/config/worldstate/tracker) no toca DOM ni navegador y se prueba con `node --test`; cámara/MediaPipe/Three/DOM se validan a mano en Chrome.

**Tech Stack:** HTML5/CSS3, JavaScript vanilla (ES Modules), MediaDevices/WebRTC, MediaPipe Tasks Vision (FaceDetector), Three.js (reutilizado del vendor del admin), WebGL, `node --test` (Node 20).

**Spec:** `docs/superpowers/specs/2026-10-08-akbal-vision-design.md`

## Global Constraints

- JavaScript **vanilla con ES Modules**. Sin React/Vue/Angular, sin frameworks, sin backend propio de la app, sin build step para el frontend.
- **Cero CDN**: Three.js se importa del vendor existente (`app/web/admin/vendor/three.module.min.js`); MediaPipe (WASM + modelo `face_landmarker.task`) se baja localmente con `install-deps.sh` a rutas gitignored.
- Es **una sección más del admin**: misma app, mismo puerto, ruta `/akbal-vision`, **detrás del login existente** (NO va en `PUBLIC_PATHS`). Sin base de datos, sin API nueva.
- Estética: color principal `#00FF66`, fondo `#020805`, tipografía monospace, líneas finas, glow sutil. Strings de UI en español; comentarios de código en inglés.
- Coordenadas internas en **espacio de píxeles del video**; el HUD mapea a pantalla contemplando `object-fit: cover` y el **espejo** de la cámara frontal (`facingMode:"user"`).
- Constantes del tracker: TTL de pérdida ~600 ms; IDs `SUBJ-####` con contador monotónico (4 dígitos, zero-padded). Suavizado del HUD: `lerp(…, 0.18)`.
- Pruebas de lógica pura con `node --test` sobre `app/web/admin/akbal-vision/js/` (módulos ESM vía `akbal-vision/package.json` con `{"type":"module"}`).
- Node.js 20.

## Review Focus

- **Permiso de cámara denegado / sin cámara disponible:** la app debe mostrar un estado de error legible (no pantalla en blanco ni crash) y emitir `camera.error`. → test manual en Task 7.
- **Cero rostros en cuadro:** el `WorldState` queda vacío, sin `primaryId`, y el HUD no deja residuos de un rostro anterior. → test puro en Task 6 (tracker) + verificación manual en Task 10.
- **Muchos rostros / entran y salen rápido:** los IDs se mantienen estables entre frames (sin "parpadeo" de IDs) y un rostro solo se declara perdido tras el TTL. → tests puros en Task 5 y Task 6.
- **`localStorage` no disponible (modo privado / storage bloqueado):** `config` no debe lanzar; usa defaults. → test puro en Task 3.
- **Alineación del HUD con cámara frontal (espejada):** el HUD cae sobre el rostro, no en su posición reflejada. → verificación manual en Task 10.

---

### Task 1: Scaffold de la sección + ruta + navegación + script de dependencias

**Files:**
- Create: `app/web/admin/akbal-vision/package.json`
- Create: `app/web/admin/akbal-vision/index.html`
- Create: `app/web/admin/akbal-vision/akbal-vision.css`
- Create: `app/web/admin/akbal-vision/install-deps.sh`
- Create: `app/web/admin/akbal-vision/js/.gitkeep`
- Modify: `app/src/device/web-admin-server.ts` (añadir ruta `/akbal-vision`, junto al bloque de `/crack-station` ~línea 376)
- Modify: `.gitignore` (raíz del repo)
- Modify: `app/web/admin/i18n/es.json` y `app/web/admin/i18n/en.json` (clave del nombre de la sección)

**Interfaces:**
- Consumes: nada (primera tarea).
- Produces: la ruta `GET /akbal-vision` sirviendo `akbal-vision/index.html`; el contenedor DOM con ids que consumen tareas posteriores: `#av-stage` (capas), `#av-video` (`<video>`), `#av-hud` (canvas Three), `#av-debug` (canvas 2D), `#av-ui` (paneles). `akbal-vision/package.json` con `{"type":"module"}`.

- [ ] **Step 1: Crear `akbal-vision/package.json`**

```json
{
  "name": "akbal-vision",
  "private": true,
  "type": "module"
}
```

- [ ] **Step 2: Crear el esqueleto `index.html`** (cuatro capas en el mismo viewport, importa `js/app.js` como módulo)

```html
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>AKBAL VISION</title>
  <link rel="stylesheet" href="akbal-vision.css" />
</head>
<body>
  <div id="av-stage">
    <video id="av-video" autoplay playsinline muted></video>
    <canvas id="av-hud"></canvas>
    <canvas id="av-debug"></canvas>
    <div id="av-ui"></div>
  </div>
  <script type="module" src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Crear `akbal-vision.css`** con los tokens de la estética y el apilado de capas

```css
:root { --av-accent:#00FF66; --av-bg:#020805; --av-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace; }
html,body { margin:0; height:100%; background:var(--av-bg); color:var(--av-accent);
  font-family:var(--av-mono); overflow:hidden; }
#av-stage { position:fixed; inset:0; }
#av-video { position:absolute; inset:0; width:100%; height:100%; object-fit:cover;
  transform:scaleX(-1); } /* espejo para facingMode:user; el HUD compensa igual */
#av-hud,#av-debug { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
#av-ui { position:absolute; inset:0; pointer-events:none; }
#av-ui .av-panel { pointer-events:auto; }
```

- [ ] **Step 4: Crear `install-deps.sh`** (baja MediaPipe Tasks Vision WASM + el modelo a rutas locales)

```bash
#!/usr/bin/env bash
# Downloads MediaPipe Tasks Vision runtime (WASM+loader) and the face landmarker
# model into vendored, gitignored paths so Akbal Vision runs with NO CDN and
# works offline afterwards. Pinned versions for reproducibility.
set -euo pipefail
cd "$(dirname "$0")"
MP_VER="0.10.18"
mkdir -p vendor/mediapipe models
echo "[akbal-vision] MediaPipe tasks-vision ${MP_VER}…"
curl -fsSL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs" \
  -o vendor/mediapipe/vision_bundle.mjs
for f in vision_wasm_internal.js vision_wasm_internal.wasm; do
  curl -fsSL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm/${f}" \
    -o "vendor/mediapipe/${f}"
done
echo "[akbal-vision] face_landmarker model…"
curl -fsSL "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task" \
  -o models/face_landmarker.task
echo "[akbal-vision] done. Assets under vendor/mediapipe/ and models/."
```

- [ ] **Step 5: Añadir las rutas gitignored** (al `.gitignore` de la raíz)

```
# Akbal Vision vendored binaries (downloaded via install-deps.sh)
app/web/admin/akbal-vision/vendor/mediapipe/
app/web/admin/akbal-vision/models/
```

- [ ] **Step 6: Registrar la ruta en el admin** (en `app/src/device/web-admin-server.ts`, junto al bloque de `/crack-station`)

```ts
router.get("/akbal-vision", (ctx) => {
  ctx.set("Cache-Control", "no-store");
  ctx.type = "text/html";
  ctx.body = fs.createReadStream(path.resolve(__dirname, "../..", "web", "admin", "akbal-vision", "index.html"));
});
```

- [ ] **Step 7: Añadir el acceso en la navegación + i18n** — agregar la clave `"nav_akbal_vision": "Akbal Vision"` en `es.json` y `en.json` dentro del objeto donde viven las demás etiquetas de navegación, y el enlace a `/akbal-vision` en el mismo lugar donde el admin lista sus secciones (seguir el patrón del enlace existente a `/crack-station`).

- [ ] **Step 8: Verificar build del server**

Run: `cd app && npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 9: Verificación manual**

Run: `cd app && npm start` (en la Pi) o servir el admin localmente; abrir `/akbal-vision` tras login.
Expected: carga una página negra con fondo `#020805`; la consola no muestra 404 de `akbal-vision.css`. (El `<video>` aún no pide cámara — eso es Task 7.)

- [ ] **Step 10: Commit**

```bash
git add app/web/admin/akbal-vision/ app/src/device/web-admin-server.ts .gitignore app/web/admin/i18n/
git commit -m "feat(akbal-vision): scaffold de la sección, ruta /akbal-vision y script de deps"
```

---

### Task 2: Event Bus (`events.js`) — establece el harness de `node --test`

**Files:**
- Create: `app/web/admin/akbal-vision/js/events.js`
- Test: `app/web/admin/akbal-vision/js/events.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `createEventBus() -> { on(type, fn), off(type, fn), emit(type, payload) }`. `on` devuelve una función para desuscribir. `emit` a un tipo sin listeners no lanza.

- [ ] **Step 1: Escribir el test que falla**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "./events.js";

test("emit entrega el payload a los listeners suscritos", () => {
  const bus = createEventBus();
  const seen = [];
  bus.on("subject.created", (p) => seen.push(p));
  bus.emit("subject.created", { id: "SUBJ-0001" });
  assert.deepEqual(seen, [{ id: "SUBJ-0001" }]);
});

test("off quita el listener y on() devuelve un desuscriptor", () => {
  const bus = createEventBus();
  let n = 0;
  const fn = () => { n++; };
  const unsub = bus.on("x", fn);
  bus.emit("x"); unsub(); bus.emit("x");
  bus.on("y", fn); bus.off("y", fn); bus.emit("y");
  assert.equal(n, 1);
});

test("emit sin listeners no lanza", () => {
  const bus = createEventBus();
  assert.doesNotThrow(() => bus.emit("nadie", 123));
});

test("múltiples listeners del mismo tipo reciben todos", () => {
  const bus = createEventBus();
  let a = 0, b = 0;
  bus.on("e", () => a++); bus.on("e", () => b++);
  bus.emit("e");
  assert.equal(a, 1); assert.equal(b, 1);
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `node --test app/web/admin/akbal-vision/js/events.test.js`
Expected: FAIL (`createEventBus` no existe).

- [ ] **Step 3: Implementación mínima**

```js
// Tiny synchronous event bus. The single extensibility seam for future
// sensors (wifi.*/gps.*/adsb.*/voice.*): they only ever emit/on here.
export function createEventBus() {
  const listeners = new Map(); // type -> Set<fn>
  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => this.off(type, fn);
    },
    off(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type, payload) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) fn(payload);
    },
  };
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `node --test app/web/admin/akbal-vision/js/events.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/web/admin/akbal-vision/js/events.js app/web/admin/akbal-vision/js/events.test.js
git commit -m "feat(akbal-vision): event bus con tests (node --test)"
```

---

### Task 3: Configuración y modos (`config.js`)

**Files:**
- Create: `app/web/admin/akbal-vision/js/config.js`
- Test: `app/web/admin/akbal-vision/js/config.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `MODES` (objeto con `HIGH`/`BALANCED`/`LOW`, cada uno `{ video:{w,h}, visionFps, renderFps, landmarks, effects }`). `createConfig(storage?) -> { mode, setMode(m), cameraId, setCameraId(id), debug, setDebug(b), current() }`. `storage` por defecto es `globalThis.localStorage` (puede faltar); `current()` devuelve `MODES[mode]`.

- [ ] **Step 1: Escribir el test que falla**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createConfig, MODES } from "./config.js";

function fakeStorage() {
  const m = new Map();
  return { getItem:(k)=>m.has(k)?m.get(k):null, setItem:(k,v)=>m.set(k,String(v)), removeItem:(k)=>m.delete(k) };
}

test("defaults: mode HIGH, sin cámara, debug off", () => {
  const c = createConfig(fakeStorage());
  assert.equal(c.mode, "HIGH");
  assert.equal(c.cameraId, null);
  assert.equal(c.debug, false);
  assert.equal(c.current(), MODES.HIGH);
});

test("setMode inválido se ignora; válido persiste y se relee", () => {
  const s = fakeStorage();
  const c = createConfig(s);
  c.setMode("TURBO"); assert.equal(c.mode, "HIGH");
  c.setMode("LOW"); assert.equal(c.mode, "LOW");
  assert.equal(createConfig(s).mode, "LOW");
});

test("setCameraId y setDebug persisten", () => {
  const s = fakeStorage();
  const c = createConfig(s);
  c.setCameraId("cam-1"); c.setDebug(true);
  const c2 = createConfig(s);
  assert.equal(c2.cameraId, "cam-1");
  assert.equal(c2.debug, true);
});

test("sin storage (undefined) usa defaults y no lanza", () => {
  let c;
  assert.doesNotThrow(() => { c = createConfig(undefined); });
  assert.equal(c.mode, "HIGH");
  assert.doesNotThrow(() => c.setMode("LOW"));
  assert.equal(c.mode, "LOW");
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `node --test app/web/admin/akbal-vision/js/config.test.js`
Expected: FAIL (`createConfig` no existe).

- [ ] **Step 3: Implementación mínima**

```js
// Performance modes (spec). HIGH=MacBook/PC, BALANCED=Pi, LOW=fallback.
export const MODES = {
  HIGH:     { video:{w:1280,h:720}, visionFps:15, renderFps:60, landmarks:true,  effects:true  },
  BALANCED: { video:{w:1280,h:720}, visionFps:10, renderFps:30, landmarks:true,  effects:false },
  LOW:      { video:{w:640, h:480}, visionFps:8,  renderFps:30, landmarks:false, effects:false },
};
const KEYS = { mode:"av.mode", cameraId:"av.cameraId", debug:"av.debug" };

// All storage access is guarded: private mode / blocked storage must not throw.
function safeGet(storage, k) { try { return storage ? storage.getItem(k) : null; } catch { return null; } }
function safeSet(storage, k, v) { try { storage && storage.setItem(k, v); } catch { /* ignore */ } }

export function createConfig(storage = globalThis.localStorage) {
  let mode = MODES[safeGet(storage, KEYS.mode)] ? safeGet(storage, KEYS.mode) : "HIGH";
  let cameraId = safeGet(storage, KEYS.cameraId);
  let debug = safeGet(storage, KEYS.debug) === "true";
  return {
    get mode() { return mode; },
    setMode(m) { if (MODES[m]) { mode = m; safeSet(storage, KEYS.mode, m); } },
    get cameraId() { return cameraId; },
    setCameraId(id) { cameraId = id || null; safeSet(storage, KEYS.cameraId, id || ""); },
    get debug() { return debug; },
    setDebug(b) { debug = !!b; safeSet(storage, KEYS.debug, b ? "true" : "false"); },
    current() { return MODES[mode]; },
  };
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `node --test app/web/admin/akbal-vision/js/config.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/web/admin/akbal-vision/js/config.js app/web/admin/akbal-vision/js/config.test.js
git commit -m "feat(akbal-vision): config + modos de rendimiento con tests"
```

---

### Task 4: Contenedor de estado (`worldstate.js`)

**Files:**
- Create: `app/web/admin/akbal-vision/js/worldstate.js`
- Test: `app/web/admin/akbal-vision/js/worldstate.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `emptyWorldState() -> { subjects:{}, primaryId:null, frame:{w:0,h:0}, updatedAt:0 }`. `createWorldStore() -> { set(state), snapshot() }`. `snapshot()` devuelve el último estado seteado (o `emptyWorldState()` si nunca se seteó).

- [ ] **Step 1: Escribir el test que falla**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyWorldState, createWorldStore } from "./worldstate.js";

test("emptyWorldState tiene la forma esperada", () => {
  const s = emptyWorldState();
  assert.deepEqual(s, { subjects:{}, primaryId:null, frame:{w:0,h:0}, updatedAt:0 });
});

test("store arranca vacío y snapshot refleja el último set", () => {
  const store = createWorldStore();
  assert.deepEqual(store.snapshot(), emptyWorldState());
  const next = { subjects:{ "SUBJ-0001":{id:"SUBJ-0001"} }, primaryId:"SUBJ-0001", frame:{w:1280,h:720}, updatedAt:5 };
  store.set(next);
  assert.equal(store.snapshot(), next);
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `node --test app/web/admin/akbal-vision/js/worldstate.test.js`
Expected: FAIL (`emptyWorldState` no existe).

- [ ] **Step 3: Implementación mínima**

```js
// Canonical shared state produced by the tracker and read by hud/ui.
// Coordinates are in VIDEO PIXEL space (see spec). The store is a plain
// holder: the tracker builds whole new states; the render loop reads them.
export function emptyWorldState() {
  return { subjects: {}, primaryId: null, frame: { w: 0, h: 0 }, updatedAt: 0 };
}
export function createWorldStore() {
  let current = emptyWorldState();
  return {
    set(state) { current = state; },
    snapshot() { return current; },
  };
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `node --test app/web/admin/akbal-vision/js/worldstate.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/web/admin/akbal-vision/js/worldstate.js app/web/admin/akbal-vision/js/worldstate.test.js
git commit -m "feat(akbal-vision): contenedor WorldState con tests"
```

---

### Task 5: Tracker — asignación y re-match de IDs (`tracker.js`)

**Files:**
- Create: `app/web/admin/akbal-vision/js/tracker.js`
- Test: `app/web/admin/akbal-vision/js/tracker.test.js`

**Interfaces:**
- Consumes: `emptyWorldState()` de `worldstate.js`.
- Produces: `createTracker(opts?) -> { update(detections, prevState, nowMs) }`. `opts = { ttlMs=600, matchFactor=1.5 }`. `detections` = `[{ bbox:{x,y,w,h}, confidence, landmarks? }]` en píxeles de video. `frameSize` se pasa dentro de cada `update` vía `prevState.frame` ya seteado por el caller, pero el tracker recibe el tamaño por `update(detections, prevState, nowMs, frame)`. **Firma exacta:** `update(detections, prevState, nowMs, frame = prevState.frame)` → `{ state, events }`. `state` es un `WorldState` nuevo; `events` = `[{ type, payload }]`. IDs `SUBJ-####`. Cada `Subject`: `{ id, bbox, center:{x,y}, confidence, firstSeen, lastSeen, visibleForMs, isPrimary, orientation:"FRONTAL", pose:{yaw:0,pitch:0,roll:0}, eyeContact:"UNKNOWN", motion:"STATIC", landmarks:null }`.

- [ ] **Step 1: Escribir el test que falla (nuevos IDs + re-match por proximidad)**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTracker } from "./tracker.js";
import { emptyWorldState } from "./worldstate.js";

const det = (x, y, w = 100, h = 100, confidence = 0.9) => ({ bbox:{x,y,w,h}, confidence });
const frame = { w: 1280, h: 720 };

test("detección nueva crea SUBJ-0001 y emite subject.created", () => {
  const tr = createTracker();
  const { state, events } = tr.update([det(100,100)], emptyWorldState(), 1000, frame);
  const ids = Object.keys(state.subjects);
  assert.deepEqual(ids, ["SUBJ-0001"]);
  assert.equal(state.subjects["SUBJ-0001"].center.x, 150);
  assert.ok(events.some(e => e.type === "subject.created" && e.payload.id === "SUBJ-0001"));
});

test("IDs son monotónicos entre llamadas", () => {
  const tr = createTracker();
  let s = tr.update([det(100,100)], emptyWorldState(), 1000, frame).state;
  // el primer sujeto desaparece pasado el TTL, entra otro nuevo
  s = tr.update([det(900,500)], s, 2000, frame).state;
  assert.ok(s.subjects["SUBJ-0002"], "el segundo rostro recibe SUBJ-0002");
});

test("un rostro que se mueve poco conserva su ID", () => {
  const tr = createTracker();
  let r = tr.update([det(100,100)], emptyWorldState(), 1000, frame);
  r = tr.update([det(115,108)], r.state, 1100, frame); // se movió un poco
  assert.deepEqual(Object.keys(r.state.subjects), ["SUBJ-0001"]);
  assert.equal(r.state.subjects["SUBJ-0001"].visibleForMs, 100);
  assert.ok(!r.events.some(e => e.type === "subject.created"), "no re-crea");
});

test("dos rostros distintos mantienen IDs separados y estables", () => {
  const tr = createTracker();
  let r = tr.update([det(100,100), det(900,500)], emptyWorldState(), 1000, frame);
  const first = { ...r.state.subjects };
  r = tr.update([det(110,105), det(905,495)], r.state, 1100, frame);
  assert.deepEqual(Object.keys(r.state.subjects).sort(), ["SUBJ-0001","SUBJ-0002"]);
  // el que estaba cerca de (100,100) sigue siendo el mismo id
  const near = Object.values(r.state.subjects).find(s => s.center.x < 500);
  assert.equal(near.id, Object.values(first).find(s => s.center.x < 500).id);
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `node --test app/web/admin/akbal-vision/js/tracker.test.js`
Expected: FAIL (`createTracker` no existe).

- [ ] **Step 3: Implementación (matching + IDs; la lógica de TTL/primary se completa en Task 6 pero se incluye ya para que el módulo quede coherente)**

```js
import { emptyWorldState } from "./worldstate.js";

const area = (b) => b.w * b.h;
const centerOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Pure multi-object tracker. Greedy nearest-centroid matching within a gate
// proportional to face size, so IDs stay stable frame to frame. No side
// effects: returns the next WorldState plus the events the caller publishes.
export function createTracker({ ttlMs = 600, matchFactor = 1.5 } = {}) {
  let counter = 0;
  const nextId = () => `SUBJ-${String(++counter).padStart(4, "0")}`;

  return {
    update(detections, prevState = emptyWorldState(), nowMs = 0, frame = prevState.frame) {
      const events = [];
      const prev = prevState.subjects || {};
      const prevList = Object.values(prev);
      const used = new Set();
      const subjects = {};

      // 1) Match each detection to the closest unused prev subject within gate.
      for (const d of detections) {
        const c = centerOf(d.bbox);
        const gate = Math.max(d.bbox.w, d.bbox.h) * matchFactor;
        let best = null, bestD = Infinity;
        for (const p of prevList) {
          if (used.has(p.id)) continue;
          const dd = dist(c, p.center);
          if (dd < gate && dd < bestD) { best = p; bestD = dd; }
        }
        if (best) {
          used.add(best.id);
          subjects[best.id] = {
            ...best, bbox: d.bbox, center: c, confidence: d.confidence,
            lastSeen: nowMs, visibleForMs: nowMs - best.firstSeen,
            landmarks: d.landmarks ?? null,
          };
        } else {
          const id = nextId();
          subjects[id] = {
            id, bbox: d.bbox, center: c, confidence: d.confidence,
            firstSeen: nowMs, lastSeen: nowMs, visibleForMs: 0, isPrimary: false,
            orientation: "FRONTAL", pose: { yaw: 0, pitch: 0, roll: 0 },
            eyeContact: "UNKNOWN", motion: "STATIC", landmarks: d.landmarks ?? null,
          };
          events.push({ type: "subject.created", payload: subjects[id] });
        }
      }

      // 2) Carry unmatched prev subjects until TTL, then drop + emit lost.
      for (const p of prevList) {
        if (used.has(p.id) || subjects[p.id]) continue;
        if (nowMs - p.lastSeen <= ttlMs) subjects[p.id] = p;
        else events.push({ type: "subject.lost", payload: p });
      }

      // 3) Primary = largest bbox among the currently visible (seen this frame).
      let primaryId = null, bestArea = -1;
      for (const s of Object.values(subjects)) {
        s.isPrimary = false;
        if (s.lastSeen === nowMs && area(s.bbox) > bestArea) { bestArea = area(s.bbox); primaryId = s.id; }
      }
      if (primaryId) subjects[primaryId].isPrimary = true;

      if (detections.length > 0) events.push({ type: "vision.faceDetected", payload: { count: detections.length } });

      return { state: { subjects, primaryId, frame, updatedAt: nowMs }, events };
    },
  };
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `node --test app/web/admin/akbal-vision/js/tracker.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/web/admin/akbal-vision/js/tracker.js app/web/admin/akbal-vision/js/tracker.test.js
git commit -m "feat(akbal-vision): tracker — IDs estables y matching por proximidad"
```

---

### Task 6: Tracker — pérdida por TTL, cuadro vacío y Primary Target

**Files:**
- Modify: `app/web/admin/akbal-vision/js/tracker.js` (ya implementado en Task 5; aquí se pinnea con tests)
- Test: `app/web/admin/akbal-vision/js/tracker.test.js` (añadir casos)

**Interfaces:**
- Consumes/Produces: igual que Task 5 (sin cambios de firma; esta tarea agrega cobertura y corrige si algún test revela un bug).

- [ ] **Step 1: Añadir los tests que faltan**

```js
test("un rostro ausente se mantiene dentro del TTL y se pierde después", () => {
  const tr = createTracker({ ttlMs: 600 });
  let r = tr.update([det(100,100)], emptyWorldState(), 1000, frame);
  // 300ms sin verlo: sigue vivo
  r = tr.update([], r.state, 1300, frame);
  assert.ok(r.state.subjects["SUBJ-0001"], "dentro del TTL sigue");
  assert.ok(!r.events.some(e => e.type === "subject.lost"));
  // 700ms sin verlo: perdido
  r = tr.update([], r.state, 2000, frame);
  assert.deepEqual(Object.keys(r.state.subjects), []);
  assert.ok(r.events.some(e => e.type === "subject.lost" && e.payload.id === "SUBJ-0001"));
});

test("cuadro vacío deja estado sin sujetos y sin primary", () => {
  const tr = createTracker();
  tr.update([det(100,100)], emptyWorldState(), 1000, frame);
  const r = tr.update([], { subjects:{}, primaryId:null, frame, updatedAt:0 }, 1000, frame);
  assert.deepEqual(r.state.subjects, {});
  assert.equal(r.state.primaryId, null);
});

test("el bbox de mayor área es el Primary Target", () => {
  const tr = createTracker();
  const r = tr.update([det(100,100,80,80), det(800,400,200,200)], emptyWorldState(), 1000, frame);
  assert.equal(r.state.primaryId, r.state.subjects["SUBJ-0002"].id);
  assert.equal(r.state.subjects["SUBJ-0002"].isPrimary, true);
  assert.equal(r.state.subjects["SUBJ-0001"].isPrimary, false);
});
```

- [ ] **Step 2: Correr los tests**

Run: `node --test app/web/admin/akbal-vision/js/tracker.test.js`
Expected: PASS (7 tests en total). Si alguno falla, corregir `tracker.js` hasta que pase (no tocar las firmas).

- [ ] **Step 3: Commit**

```bash
git add app/web/admin/akbal-vision/js/tracker.test.js app/web/admin/akbal-vision/js/tracker.js
git commit -m "test(akbal-vision): tracker — TTL/lost, cuadro vacío y primary target"
```

---

### Task 7: Cámara (`camera.js`) — getUserMedia, selección y errores

**Files:**
- Create: `app/web/admin/akbal-vision/js/camera.js`

**Interfaces:**
- Consumes: el `<video>` (`#av-video`); `config` (para `cameraId` y `current().video`); `bus` (emite `camera.ready|error|changed`).
- Produces: `createCamera({ video, config, bus }) -> { listDevices(), start(deviceId?), stop(), get activeDeviceId() }`. `listDevices()` → `[{ deviceId, label }]`. `start()` adjunta el stream al `<video>`, persiste el `deviceId` en `config` y emite `camera.ready`/`camera.changed`; en fallo emite `camera.error` con `{ name, message }`.

- [ ] **Step 1: Implementar `camera.js`**

```js
// Camera acquisition + hot-switching. getUserMedia requires a secure context
// (https or localhost) — see spec; errors surface as camera.error, never a
// blank screen. facingMode:"user" preferred on first run.
export function createCamera({ video, config, bus }) {
  let stream = null;
  let activeDeviceId = null;

  async function listDevices() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter(d => d.kind === "videoinput")
                 .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Cámara ${i + 1}` }));
    } catch { return []; }
  }

  async function start(deviceId = config.cameraId || undefined) {
    stop();
    const v = config.current().video;
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width:{ideal:v.w}, height:{ideal:v.h}, frameRate:{ideal:30} }
        : { facingMode: "user", width:{ideal:v.w}, height:{ideal:v.h}, frameRate:{ideal:30} },
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play().catch(() => {});
      const track = stream.getVideoTracks()[0];
      activeDeviceId = track?.getSettings?.().deviceId || deviceId || null;
      if (activeDeviceId) config.setCameraId(activeDeviceId);
      bus.emit("camera.ready", { deviceId: activeDeviceId, width: video.videoWidth, height: video.videoHeight });
      bus.emit("camera.changed", { deviceId: activeDeviceId });
      return true;
    } catch (err) {
      bus.emit("camera.error", { name: err?.name || "Error", message: err?.message || String(err) });
      return false;
    }
  }

  function stop() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  }

  return { listDevices, start, stop, get activeDeviceId() { return activeDeviceId; } };
}
```

- [ ] **Step 2: Verificación manual — cámara OK**

Servir en localhost (contexto seguro) y abrir la página; `app.js` aún no existe, así que probar temporalmente desde la consola del navegador:
```js
import("./js/camera.js").then(async ({createCamera}) => {
  const bus = { emit:(t,p)=>console.log(t,p) };
  const config = { cameraId:null, current:()=>({video:{w:1280,h:720}}), setCameraId:()=>{} };
  const cam = createCamera({ video: document.getElementById("av-video"), config, bus });
  console.log(await cam.listDevices());
  await cam.start();
});
```
Expected: el navegador pide permiso; al conceder se ve el video; consola imprime `camera.ready` con width/height reales; `listDevices()` lista al menos la cámara integrada.

- [ ] **Step 3: Verificación manual — error (Review Focus)**

Repetir denegando el permiso (o en un contexto no seguro).
Expected: consola imprime `camera.error` con `name:"NotAllowedError"` (o similar); no hay excepción sin capturar ni pantalla rota.

- [ ] **Step 4: Commit**

```bash
git add app/web/admin/akbal-vision/js/camera.js
git commit -m "feat(akbal-vision): cámara con selección de dispositivo y manejo de errores"
```

---

### Task 8: Visión (`vision.js`) — MediaPipe FaceDetector throttled

**Files:**
- Create: `app/web/admin/akbal-vision/js/vision.js`

**Interfaces:**
- Consumes: el `<video>`; MediaPipe de `../vendor/mediapipe/vision_bundle.mjs` y el WASM de `../vendor/mediapipe/`; el modelo no (FaceDetector trae su propio modelo liviano empaquetado vía la URL del task — en Hito 1 usamos el **FaceDetector** de MediaPipe, cuyo modelo `blaze_face_short_range.tflite` también se baja; añadirlo a `install-deps.sh` en este task).
- Produces: `createVision({ video }) -> { init(), detect(nowMs) }`. `init()` carga el FaceDetector (async, una vez). `detect(nowMs)` corre `detectForVideo` sobre el frame actual y devuelve `[{ bbox:{x,y,w,h}, confidence }]` en **píxeles de video** (ya desespejado: la detección se hace sobre el frame real, el espejo es solo CSS; ver Task 10 para el mapeo a pantalla). Si no está listo, devuelve `[]`.

- [ ] **Step 1: Añadir el modelo del FaceDetector a `install-deps.sh`** (nuevo bloque antes del `echo "done"`)

```bash
echo "[akbal-vision] face_detector model…"
curl -fsSL "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite" \
  -o models/blaze_face_short_range.tflite
```

- [ ] **Step 2: Implementar `vision.js`**

```js
import { FilesetResolver, FaceDetector } from "../vendor/mediapipe/vision_bundle.mjs";

// MediaPipe FaceDetector loaded 100% from vendored assets (no CDN). Runs in
// VIDEO mode against the <video> frame. Output bboxes are in video pixel space.
export function createVision({ video }) {
  let detector = null;

  async function init() {
    const files = await FilesetResolver.forVisionTasks("../vendor/mediapipe");
    detector = await FaceDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: "../models/blaze_face_short_range.tflite" },
      runningMode: "VIDEO",
    });
  }

  function detect(nowMs) {
    if (!detector || !video.videoWidth) return [];
    const res = detector.detectForVideo(video, nowMs);
    return (res.detections || []).map(d => {
      const bb = d.boundingBox; // originX/originY/width/height in pixels
      return {
        bbox: { x: bb.originX, y: bb.originY, w: bb.width, h: bb.height },
        confidence: d.categories?.[0]?.score ?? 0,
      };
    });
  }

  return { init, detect };
}
```

- [ ] **Step 3: Correr `install-deps.sh` y verificar assets**

Run: `bash app/web/admin/akbal-vision/install-deps.sh`
Expected: existen `vendor/mediapipe/vision_bundle.mjs`, `vendor/mediapipe/vision_wasm_internal.wasm`, `models/blaze_face_short_range.tflite`.

- [ ] **Step 4: Verificación manual — detección**

En localhost, con la cámara ya iniciada (Task 7), probar desde consola:
```js
const { createVision } = await import("./js/vision.js");
const vis = createVision({ video: document.getElementById("av-video") });
await vis.init();
console.log(vis.detect(performance.now())); // pararte frente a la cámara
```
Expected: con un rostro visible, devuelve un array con al menos un `{bbox, confidence}` con coordenadas plausibles (0 ≤ x ≤ videoWidth). Sin rostro, `[]`.

- [ ] **Step 5: Commit**

```bash
git add app/web/admin/akbal-vision/js/vision.js app/web/admin/akbal-vision/install-deps.sh
git commit -m "feat(akbal-vision): visión con MediaPipe FaceDetector (vendoreado)"
```

---

### Task 9: Escena Three.js (`scene.js`)

**Files:**
- Create: `app/web/admin/akbal-vision/js/scene.js`

**Interfaces:**
- Consumes: el canvas `#av-hud`; Three.js de `../../vendor/three.module.min.js` (el vendor existente del admin).
- Produces: `createScene(canvas) -> { scene, camera, renderer, resize(cssW, cssH), render(), toScene(px, py) }`. Cámara **ortográfica en píxeles CSS** con origen arriba-izquierda (x→derecha, y→abajo). `toScene(px,py)` convierte píxel-CSS a coordenada de la escena. `resize` ajusta renderer + cámara al tamaño en CSS (con `devicePixelRatio`).

- [ ] **Step 1: Implementar `scene.js`**

```js
import * as THREE from "../../vendor/three.module.min.js";

// Transparent WebGL overlay with an orthographic camera in CSS-pixel space:
// (0,0) top-left, +x right, +y down — so face pixel coords map to HUD geometry
// with a trivial transform. The scene sits above the <video> layer.
export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1000, 1000); // set in resize()

  function resize(cssW, cssH) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(cssW, cssH, false);
    camera.left = 0; camera.right = cssW; camera.top = 0; camera.bottom = cssH;
    camera.updateProjectionMatrix();
  }
  function render() { renderer.render(scene, camera); }
  function toScene(px, py) { return { x: px, y: py }; } // identity in this ortho setup

  return { scene, camera, renderer, resize, render, toScene };
}
```

- [ ] **Step 2: Verificación manual**

Añadir temporalmente en consola un rectángulo de prueba y confirmar que se dibuja encima del video y en la posición correcta:
```js
const THREE = await import("../../vendor/three.module.min.js"); // o el path correcto
const { createScene } = await import("./js/scene.js");
const sc = createScene(document.getElementById("av-hud"));
sc.resize(innerWidth, innerHeight);
const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(100,100,0),new THREE.Vector3(300,100,0),new THREE.Vector3(300,300,0),new THREE.Vector3(100,300,0),new THREE.Vector3(100,100,0)]);
sc.scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({color:0x00ff66})));
sc.render();
```
Expected: un cuadro verde `#00FF66` dibujado cerca de la esquina superior izquierda (en píxeles 100-300), encima del video, sin deformarse al ser el canvas de pantalla completa.

- [ ] **Step 3: Commit**

```bash
git add app/web/admin/akbal-vision/js/scene.js
git commit -m "feat(akbal-vision): escena Three.js (ortográfica en píxeles)"
```

---

### Task 10: HUD (`hud.js`) — geometría por sujeto, lerp y mapeo video→pantalla

**Files:**
- Create: `app/web/admin/akbal-vision/js/hud.js`

**Interfaces:**
- Consumes: el objeto de `createScene(...)`; Three.js; snapshots del `WorldState`.
- Produces: `createHud(sceneApi, THREE) -> { update(snapshot, metrics) }`. `metrics = { cssW, cssH, videoW, videoH, mirror:true }`. `update` crea/actualiza/elimina un grupo Three por sujeto (esquinas + label de texto del primary; esquinas mínimas para el resto), hace `lerp(current, target, 0.18)` de la posición, y mapea el bbox de **video-píxel → píxel-CSS** usando `object-fit: cover` + espejo horizontal (porque el `<video>` está `scaleX(-1)`).

- [ ] **Step 1: Implementar `hud.js`**

```js
// Maps video-pixel bboxes to on-screen CSS pixels under object-fit:cover and
// the front-camera mirror, then draws HUD corners that lerp toward the target
// each render frame (jitter-free). Full HUD for the primary, minimal for others.
export function createHud(sceneApi, THREE) {
  const groups = new Map(); // id -> { group, cur:{x,y,w,h} }

  function mapBox(b, m) {
    // object-fit:cover scale + centering offset
    const scale = Math.max(m.cssW / m.videoW, m.cssH / m.videoH);
    const dispW = m.videoW * scale, dispH = m.videoH * scale;
    const offX = (m.cssW - dispW) / 2, offY = (m.cssH - dispH) / 2;
    let x = offX + b.x * scale, y = offY + b.y * scale;
    const w = b.w * scale, h = b.h * scale;
    if (m.mirror) x = m.cssW - (x + w); // horizontal flip to match the mirrored video
    return { x, y, w, h };
  }

  function makeGroup(primary) {
    const group = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: 0x00ff66, transparent: true, opacity: primary ? 1 : 0.5 });
    // four L-shaped corners drawn as a single line loop placeholder (refined visually later)
    const geo = new THREE.BufferGeometry();
    group.add(new THREE.LineSegments(geo, mat));
    group.userData.mat = mat;
    sceneApi.scene.add(group);
    return group;
  }

  function cornerPoints(x, y, w, h, c) {
    // c = corner length in px
    const L = (x1,y1,x2,y2) => [new THREE.Vector3(x1,y1,0), new THREE.Vector3(x2,y2,0)];
    return [
      ...L(x,y, x+c,y), ...L(x,y, x,y+c),
      ...L(x+w,y, x+w-c,y), ...L(x+w,y, x+w,y+c),
      ...L(x,y+h, x+c,y+h), ...L(x,y+h, x,y+h-c),
      ...L(x+w,y+h, x+w-c,y+h), ...L(x+w,y+h, x+w,y+h-c),
    ];
  }

  function update(snapshot, metrics) {
    const seen = new Set();
    for (const s of Object.values(snapshot.subjects)) {
      seen.add(s.id);
      const t = mapBox(s.bbox, metrics);
      let entry = groups.get(s.id);
      if (!entry) { entry = { group: makeGroup(s.isPrimary), cur: { ...t } }; groups.set(s.id, entry); }
      // lerp current toward target
      const a = 0.18;
      entry.cur.x += (t.x - entry.cur.x) * a; entry.cur.y += (t.y - entry.cur.y) * a;
      entry.cur.w += (t.w - entry.cur.w) * a; entry.cur.h += (t.h - entry.cur.h) * a;
      const c = Math.min(entry.cur.w, entry.cur.h) * 0.22;
      const line = entry.group.children[0];
      line.geometry.setFromPoints(cornerPoints(entry.cur.x, entry.cur.y, entry.cur.w, entry.cur.h, c));
      entry.group.userData.mat.opacity = s.isPrimary ? 1 : 0.5;
    }
    // remove HUD for subjects no longer present
    for (const [id, entry] of groups) {
      if (!seen.has(id)) { sceneApi.scene.remove(entry.group); groups.delete(id); }
    }
    sceneApi.render();
  }

  return { update };
}
```

- [ ] **Step 2: Verificación manual — seguimiento y alineación (Review Focus: espejo + cuadro vacío)**

Con cámara + visión + escena cableadas por un script temporal, correr el tracker sobre las detecciones y llamar `hud.update(store.snapshot(), metrics)` en un `requestAnimationFrame`.
Expected:
- Las esquinas del HUD caen **sobre** el rostro (no en su posición reflejada) con la cámara frontal espejada.
- Al mover la cabeza, el HUD la sigue **suavemente** (sin saltos).
- Al salir del cuadro, tras ~600 ms el HUD de ese rostro **desaparece** (no queda pegado).
- Con dos personas, la más grande/cercana tiene el HUD completo (opacidad 1) y la otra el mínimo (0.5).

- [ ] **Step 3: Commit**

```bash
git add app/web/admin/akbal-vision/js/hud.js
git commit -m "feat(akbal-vision): HUD con lerp y mapeo video→pantalla (cover + espejo)"
```

---

### Task 11: UI (`ui.js`) — boot, panel del target, event log, settings, privacidad, fullscreen

**Files:**
- Create: `app/web/admin/akbal-vision/js/ui.js`
- Modify: `app/web/admin/akbal-vision/akbal-vision.css` (estilos de paneles)

**Interfaces:**
- Consumes: `#av-ui`; `bus`; `config`; la lista de cámaras (de `camera.listDevices()`).
- Produces: `createUI({ root, bus, config, camera }) -> { boot(steps), renderTarget(snapshot), logEvent(text), setDevices(list), setDebug(stats) }`. `boot(steps)` renderiza la secuencia de arranque (array de `{label, ok}`). `renderTarget(snapshot)` pinta el panel del Primary Target. `logEvent` mantiene las últimas 20 líneas con timestamp. `setDebug` muestra/oculta el overlay según `config.debug`.

- [ ] **Step 1: Implementar `ui.js`** (paneles mínimos pero completos para Hito 1)

```js
const pad = (n) => String(n).padStart(2, "0");
const clock = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const fmtVisible = (ms) => { const s = Math.floor(ms/1000); return `${pad(Math.floor(s/60))}:${pad(s%60)}`; };

export function createUI({ root, bus, config, camera }) {
  root.innerHTML = `
    <section class="av-panel av-target" id="av-target"></section>
    <section class="av-panel av-log"><h2>EVENT LOG</h2><ul id="av-log-list"></ul></section>
    <section class="av-panel av-settings" id="av-settings">
      <h2>AKBAL VISION</h2>
      <label>CÁMARA <select id="av-cam"></select></label>
      <label>MODO <select id="av-mode">
        <option>HIGH</option><option>BALANCED</option><option>LOW</option></select></label>
      <label><input type="checkbox" id="av-debug-toggle"> DEBUG</label>
      <button id="av-full">FULLSCREEN</button>
      <p class="av-privacy">LOCAL PROCESSING · NO VIDEO UPLOAD</p>
    </section>
    <section class="av-panel av-debug-stats hidden" id="av-debug-stats"></section>
    <pre class="av-boot" id="av-boot"></pre>`;

  const logList = root.querySelector("#av-log-list");
  const lines = [];
  root.querySelector("#av-mode").value = config.mode;
  root.querySelector("#av-debug-toggle").checked = config.debug;

  root.querySelector("#av-mode").addEventListener("change", (e) => { config.setMode(e.target.value); location.reload(); });
  root.querySelector("#av-cam").addEventListener("change", (e) => camera.start(e.target.value));
  root.querySelector("#av-debug-toggle").addEventListener("change", (e) => {
    config.setDebug(e.target.checked);
    root.querySelector("#av-debug-stats").classList.toggle("hidden", !e.target.checked);
  });
  root.querySelector("#av-full").addEventListener("click", () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  return {
    boot(steps) {
      root.querySelector("#av-boot").textContent =
        "AKBAL VISION\n\n" + steps.map(s => `${s.label.padEnd(12,".")} ${s.ok ? "OK" : "…"}`).join("\n") +
        (steps.every(s => s.ok) ? "\n\nLOCAL PROCESSING ENABLED\nSYSTEM READY" : "");
      if (steps.every(s => s.ok)) setTimeout(() => root.querySelector("#av-boot").classList.add("hidden"), 800);
    },
    renderTarget(snapshot) {
      const p = snapshot.subjects[snapshot.primaryId];
      const el = root.querySelector("#av-target");
      if (!p) { el.innerHTML = `<h2>TARGET</h2><p class="muted">NO SUBJECT</p>`; return; }
      el.innerHTML = `<h2>TARGET</h2>
        <div class="av-id">${p.id}</div>
        <dl>
          <dt>STATUS</dt><dd>TRACKING</dd>
          <dt>CONFIDENCE</dt><dd>${(p.confidence*100).toFixed(1)}%</dd>
          <dt>VISIBLE</dt><dd>${fmtVisible(p.visibleForMs)}</dd>
          <dt>ORIENTATION</dt><dd class="muted">${p.orientation}</dd>
          <dt>EYE CONTACT</dt><dd class="muted">${p.eyeContact}</dd>
          <dt>MOTION</dt><dd class="muted">${p.motion}</dd>
        </dl>`;
    },
    logEvent(text) {
      lines.push(`${clock()} ${text}`);
      while (lines.length > 20) lines.shift();
      logList.innerHTML = lines.map(l => `<li>${l}</li>`).join("");
    },
    setDevices(list) {
      const sel = root.querySelector("#av-cam");
      sel.innerHTML = list.map(d => `<option value="${d.deviceId}">${d.label}</option>`).join("");
      if (config.cameraId) sel.value = config.cameraId;
    },
    setDebug(stats) {
      const el = root.querySelector("#av-debug-stats");
      el.textContent = `CAMERA ${stats.cameraFps} FPS\nVISION ${stats.visionFps} FPS\nRENDER ${stats.renderFps} FPS\nINFERENCE ${stats.inferenceMs} ms\nFACES ${stats.faces}`;
    },
  };
}
```

- [ ] **Step 2: Añadir estilos de paneles** a `akbal-vision.css`

```css
.av-panel { position:absolute; background:rgba(2,8,5,.72); border:1px solid rgba(0,255,102,.35);
  padding:10px 12px; font-size:12px; letter-spacing:.5px; box-shadow:0 0 12px rgba(0,255,102,.15); }
.av-panel h2 { margin:0 0 6px; font-size:11px; opacity:.8; }
.av-target { top:16px; left:16px; min-width:180px; }
.av-target .av-id { font-size:18px; margin-bottom:6px; }
.av-target dl { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; margin:0; }
.av-target dt { opacity:.6; } .av-target dd { margin:0; text-align:right; }
.av-log { bottom:16px; left:16px; width:280px; } .av-log ul { margin:0; padding:0; list-style:none; }
.av-log li { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.av-settings { top:16px; right:16px; display:flex; flex-direction:column; gap:6px; }
.av-settings label { display:flex; justify-content:space-between; gap:8px; }
.av-settings button { background:transparent; color:var(--av-accent); border:1px solid var(--av-accent);
  font-family:inherit; padding:4px; cursor:pointer; }
.av-privacy { opacity:.7; font-size:10px; margin:4px 0 0; }
.av-debug-stats { bottom:16px; right:16px; white-space:pre; }
.av-boot { position:absolute; inset:0; margin:0; display:flex; flex-direction:column;
  justify-content:center; align-items:center; background:var(--av-bg); transition:opacity .4s; }
.hidden { display:none !important; } .muted { opacity:.45; }
@media (max-width:640px){ .av-log{width:60vw} .av-target,.av-settings{font-size:11px} }
```

- [ ] **Step 3: Verificación manual**

Cablear por `app.js` (Task 12) o un script temporal: llamar `boot`, `logEvent`, `renderTarget` con un snapshot de prueba, `setDevices` con la lista real.
Expected: se ve el boot centrado (desaparece tras ~0.8 s), el panel del target arriba-izquierda, el log abajo-izquierda con hora, settings arriba-derecha con el selector de cámara poblado, el badge de privacidad, el botón fullscreen funciona. Con `DEBUG` activado aparece el overlay de stats.

- [ ] **Step 4: Commit**

```bash
git add app/web/admin/akbal-vision/js/ui.js app/web/admin/akbal-vision/akbal-vision.css
git commit -m "feat(akbal-vision): UI — boot, panel target, event log, settings, fullscreen"
```

---

### Task 12: Bootstrap y loops (`app.js`) — integración end-to-end del Hito 1

**Files:**
- Create: `app/web/admin/akbal-vision/js/app.js`

**Interfaces:**
- Consumes: todos los módulos anteriores + Three.js.
- Produces: el arranque de la app; no exporta nada (es el entry point del `<script type="module">`). Cablea el bus a la UI (eventos → event log), corre la secuencia de boot, y arranca los tres loops.

- [ ] **Step 1: Implementar `app.js`**

```js
import * as THREE from "../../vendor/three.module.min.js";
import { createEventBus } from "./events.js";
import { createConfig } from "./config.js";
import { createWorldStore } from "./worldstate.js";
import { createTracker } from "./tracker.js";
import { createCamera } from "./camera.js";
import { createVision } from "./vision.js";
import { createScene } from "./scene.js";
import { createHud } from "./hud.js";
import { createUI } from "./ui.js";

const video = document.getElementById("av-video");
const bus = createEventBus();
const config = createConfig();
const store = createWorldStore();
const tracker = createTracker();
const camera = createCamera({ video, config, bus });
const vision = createVision({ video });
const sceneApi = createScene(document.getElementById("av-hud"));
const hud = createHud(sceneApi, THREE);
const ui = createUI({ root: document.getElementById("av-ui"), bus, config, camera });

// Bus → event log (human-readable lines).
bus.on("camera.ready", () => ui.logEvent("CAMERA READY"));
bus.on("camera.error", (e) => ui.logEvent(`CAMERA ERROR ${e.name}`));
bus.on("vision.ready", () => ui.logEvent("VISION READY"));
bus.on("subject.created", (s) => ui.logEvent(`SUBJECT ACQUIRED ${s.id}`));
bus.on("subject.lost", (s) => ui.logEvent(`SUBJECT LOST ${s.id}`));

const steps = [
  { label: "CAMERA", ok: false }, { label: "VISION", ok: false },
  { label: "TRACKER", ok: true }, { label: "RENDERER", ok: true },
];
ui.boot(steps); ui.logEvent("SYSTEM ONLINE");

const perf = { cameraFps: 0, visionFps: 0, renderFps: 0, inferenceMs: 0, faces: 0 };

async function bootstrap() {
  const camOk = await camera.start();
  steps[0].ok = camOk; ui.boot(steps);
  ui.setDevices(await camera.listDevices()); // labels aparecen tras conceder permiso
  try { await vision.init(); steps[1].ok = true; bus.emit("vision.ready"); }
  catch (e) { ui.logEvent("VISION FAIL"); }
  ui.boot(steps);
  startLoops();
}

function startLoops() {
  const mode = config.current();
  // Vision loop: throttled, self-pacing (skips, never queues).
  let visionBusy = false, lastVision = 0, visionFrames = 0, visionWindow = performance.now();
  async function visionTick() {
    const now = performance.now();
    if (!visionBusy && now - lastVision >= 1000 / mode.visionFps) {
      visionBusy = true; lastVision = now;
      const t0 = performance.now();
      const dets = vision.detect(now);
      perf.inferenceMs = Math.round(performance.now() - t0);
      perf.faces = dets.length;
      const { state, events } = tracker.update(dets, store.snapshot(), now, { w: video.videoWidth, h: video.videoHeight });
      store.set(state);
      for (const ev of events) bus.emit(ev.type, ev.payload);
      visionFrames++;
      if (now - visionWindow >= 1000) { perf.visionFps = visionFrames; visionFrames = 0; visionWindow = now; }
      visionBusy = false;
    }
    setTimeout(visionTick, 5);
  }
  visionTick();

  // Render loop: rAF, reads WorldState and lerps the HUD.
  let renderFrames = 0, renderWindow = performance.now();
  function renderTick() {
    const cssW = window.innerWidth, cssH = window.innerHeight;
    sceneApi.resize(cssW, cssH);
    const snap = store.snapshot();
    hud.update(snap, { cssW, cssH, videoW: video.videoWidth || cssW, videoH: video.videoHeight || cssH, mirror: true });
    ui.renderTarget(snap);
    renderFrames++;
    const now = performance.now();
    if (now - renderWindow >= 1000) { perf.renderFps = renderFrames; renderFrames = 0; renderWindow = now; if (config.debug) ui.setDebug(perf); }
    requestAnimationFrame(renderTick);
  }
  requestAnimationFrame(renderTick);
}

bootstrap();
```

- [ ] **Step 2: Verificación manual — criterios de aceptación del Hito 1**

Servir en localhost y abrir `/akbal-vision` (o el archivo vía `python3 -m http.server`). Conceder cámara.
Expected (checklist):
- Secuencia de boot corta → SYSTEM READY, luego se ve el video.
- Con un rostro: aparece `SUBJECT ACQUIRED SUBJ-0001` en el log; el HUD de esquinas verde sigue el rostro suavemente.
- El panel TARGET muestra ID, STATUS TRACKING, CONFIDENCE %, VISIBLE mm:ss (ORIENTATION/EYE CONTACT/MOTION en gris).
- Con dos personas: la mayor es Primary (HUD completo); la otra, mínimo.
- Salir del cuadro: tras ~600 ms, `SUBJECT LOST` y el HUD desaparece.
- El selector de cámara cambia de dispositivo; FULLSCREEN funciona; DEBUG muestra FPS/inference/faces.
- Sin red (DevTools → Offline) tras `install-deps.sh`, recargar: sigue cargando (Three/MediaPipe/modelo locales).

- [ ] **Step 3: Correr toda la suite pura**

Run: `node --test app/web/admin/akbal-vision/js/`
Expected: PASS (events 4, config 4, worldstate 2, tracker 7 = 17 tests).

- [ ] **Step 4: Commit**

```bash
git add app/web/admin/akbal-vision/js/app.js
git commit -m "feat(akbal-vision): bootstrap, 3 loops y MVP del Hito 1 end-to-end"
```

---

## Notas de cierre

- El **deploy a HTTPS** de toda la web de Akbal (para que la cámara funcione fuera de localhost) es del **Hito 3**; durante el Hito 1 se desarrolla y prueba en localhost (contexto seguro), tal cual el modelo del spec.
- `analysis.js` (head pose / eye contact / motion), el render de landmarks y el panel completo son del **Hito 2**; en el Hito 1 esos campos se muestran en gris (`UNKNOWN`/`STATIC`/`FRONTAL`).
- Al terminar el Hito 1: `git push` y, si se quiere ver en la Pi, `whisplay update` + `whisplay service restart` (la ruta ya queda servida; la cámara desde un equipo remoto requiere el HTTPS del Hito 3).
