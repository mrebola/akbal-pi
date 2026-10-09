# Akbal Vision — Hito 2 (Análisis) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enriquecer Akbal Vision con análisis por rostro: landmarks (ojos/nariz/boca/mandíbula), orientación de cabeza (yaw/pitch/roll → FRONTAL/LEFT/RIGHT/UP/DOWN), eye contact aproximado (LOOKING/NOT_LOOKING/UNKNOWN) y movimiento (STATIC/LOW/MEDIUM/HIGH), con el panel del Primary Target completo, el evento `subject.eyeContact` y yaw/pitch/roll en debug.

**Architecture:** Se cambia el detector de `FaceDetector` a `FaceLandmarker` (MediaPipe), que entrega por rostro: landmarks normalizados (478), bbox derivado de su extensión, y una matriz de transformación facial 4×4 (→ head pose). Un módulo nuevo `analysis.js` (lógica pura) decodifica la matriz a yaw/pitch/roll y clasifica pose / eye contact / motion; `annotate()` (puro) rellena esos campos en el WorldState y emite transiciones de eye contact. El resto del pipeline (tracker/worldstate/HUD/UI) no cambia su forma — los campos ya existían en el `Subject` en valores por defecto desde el Hito 1.

**Tech Stack:** MediaPipe Tasks Vision **FaceLandmarker**, JS vanilla (ES Modules), `node --test` (lógica pura), Three.js (landmarks en el HUD).

**Spec:** `docs/superpowers/specs/2026-10-08-akbal-vision-design.md`

## Decisión de diseño (a confirmar en la revisión del plan)

**Se reemplaza `FaceDetector` por `FaceLandmarker`** (un solo modelo, ya vendoreado en `models/face_landmarker.task`). Da landmarks + matriz de pose, que son el objetivo del hito. `FaceLandmarker` **no expone un score de detección por rostro**, así que el campo CONFIDENCE del panel pasa a ser un indicador de *lock* de malla (100% mientras hay landmarks del rostro), no una probabilidad de detección. Alternativa (no elegida): correr los DOS modelos (FaceDetector para bbox+confidence real + FaceLandmarker para lo demás), que duplica el costo de inferencia en la Pi. Recomiendo el reemplazo; si prefieres conservar el confidence real, se corren ambos.

## Global Constraints

- JS vanilla ES Modules bajo `app/web/admin/akbal-vision/` (sin build; `node --test` directo sobre `js/*.test.js`, módulos ESM vía el `package.json` con `type:module`).
- Sin CDN: `FaceLandmarker` carga desde `/akbal-vision/vendor/mediapipe` + `/akbal-vision/models/face_landmarker.task` (ya los baja `install-deps.sh`). Rutas **absolutas** (document-relative), como en el Hito 1.
- Coordenadas en píxeles de video; el HUD mapea a pantalla con cover + espejo (reusar `mapBox`/añadir `mapPoint`).
- Lógica pura (`analysis.js`) sin DOM ni navegador → testeable con `node --test`.
- `#00FF66` / `#020805`, monospace; strings de usuario en español; comentarios en inglés.
- Los campos del `Subject` ya existen: `orientation`, `pose:{yaw,pitch,roll}`, `eyeContact`, `motion`, `landmarks` (Hito 1 los dejó en FRONTAL/0/UNKNOWN/STATIC/null).

## Review Focus

- **Rostro sin matriz de pose** (MediaPipe a veces no la entrega) → pose/eyeContact = UNKNOWN, sin NaN ni crash. → test puro en Task 1 (headPose con matriz vacía) + Task 3.
- **Sujeto nuevo sin frame previo** → motion = STATIC (no lanza por `prevCenter` undefined). → test puro en Task 1.
- **Espejo de la cámara frontal** → LEFT/RIGHT de la orientación deben coincidir con lo que el usuario percibe en el video espejado; la calibración del signo del yaw se valida en dispositivo. → verificación manual en Task 5.
- **Landmarks fuera de cuadro / lista vacía** → el HUD no dibuja basura ni lanza. → verificación manual en Task 4.
- **Transición de eye contact** → `subject.eyeContact` se emite al ENTRAR a LOOKING, no en cada frame. → test puro en Task 3.

---

### Task 1: `analysis.js` — matemática pura de pose / eye contact / motion

**Files:**
- Create: `app/web/admin/akbal-vision/js/analysis.js`
- Test: `app/web/admin/akbal-vision/js/analysis.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `SELECTED_LANDMARKS` — array de índices FaceMesh a dibujar (ojos/nariz/boca/mandíbula).
  - `headPose(matrix16) -> {yaw,pitch,roll}` en grados; `matrix16` = array de 16 (column-major) o `null`/vacío → `{yaw:0,pitch:0,roll:0}`.
  - `poseState({yaw,pitch,roll}) -> "FRONTAL"|"LEFT"|"RIGHT"|"UP"|"DOWN"`.
  - `eyeContactState(pose|null) -> "LOOKING"|"NOT_LOOKING"|"UNKNOWN"`.
  - `motionState(prevCenter|null, curCenter, frameDiag) -> "STATIC"|"LOW"|"MEDIUM"|"HIGH"`.

- [ ] **Step 1: Escribir el test que falla**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { headPose, poseState, eyeContactState, motionState, SELECTED_LANDMARKS } from "./analysis.js";

// Column-major 4x4 from a 3x3 rotation R (r[row][col]); translation 0.
function mat(R) {
  const m = new Array(16).fill(0); m[15] = 1;
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = R[r][c];
  return m;
}
const deg = (d) => (d * Math.PI) / 180;
const Ry = (t) => [[Math.cos(t),0,Math.sin(t)],[0,1,0],[-Math.sin(t),0,Math.cos(t)]];
const Rx = (t) => [[1,0,0],[0,Math.cos(t),-Math.sin(t)],[0,Math.sin(t),Math.cos(t)]];
const Rz = (t) => [[Math.cos(t),-Math.sin(t),0],[Math.sin(t),Math.cos(t),0],[0,0,1]];

test("headPose: identidad -> 0,0,0; vacío -> 0,0,0", () => {
  const z = headPose(mat([[1,0,0],[0,1,0],[0,0,1]]));
  assert.ok(Math.abs(z.yaw) < 1e-6 && Math.abs(z.pitch) < 1e-6 && Math.abs(z.roll) < 1e-6);
  assert.deepEqual(headPose(null), { yaw: 0, pitch: 0, roll: 0 });
  assert.deepEqual(headPose([]), { yaw: 0, pitch: 0, roll: 0 });
});

test("headPose: recupera yaw/pitch/roll de rotaciones puras", () => {
  assert.ok(Math.abs(headPose(mat(Ry(deg(30)))).yaw - 30) < 0.5);
  assert.ok(Math.abs(headPose(mat(Rx(deg(20)))).pitch - 20) < 0.5);
  assert.ok(Math.abs(headPose(mat(Rz(deg(15)))).roll - 15) < 0.5);
});

test("poseState: frontal vs ejes dominantes", () => {
  assert.equal(poseState({ yaw: 3, pitch: -4, roll: 2 }), "FRONTAL");
  assert.equal(poseState({ yaw: 30, pitch: 0, roll: 0 }), "RIGHT");
  assert.equal(poseState({ yaw: -30, pitch: 0, roll: 0 }), "LEFT");
  assert.equal(poseState({ yaw: 0, pitch: 30, roll: 0 }), "DOWN");
  assert.equal(poseState({ yaw: 0, pitch: -30, roll: 0 }), "UP");
});

test("eyeContactState: frontal mira; desviado no; null = UNKNOWN", () => {
  assert.equal(eyeContactState({ yaw: 5, pitch: 5 }), "LOOKING");
  assert.equal(eyeContactState({ yaw: 25, pitch: 0 }), "NOT_LOOKING");
  assert.equal(eyeContactState(null), "UNKNOWN");
});

test("motionState: sin prev = STATIC; buckets por delta normalizado", () => {
  const diag = 1000;
  assert.equal(motionState(null, { x: 10, y: 10 }, diag), "STATIC");
  assert.equal(motionState({ x: 10, y: 10 }, { x: 11, y: 10 }, diag), "STATIC"); // 0.001
  assert.equal(motionState({ x: 0, y: 0 }, { x: 10, y: 0 }, diag), "LOW"); // 0.01
  assert.equal(motionState({ x: 0, y: 0 }, { x: 35, y: 0 }, diag), "MEDIUM"); // 0.035
  assert.equal(motionState({ x: 0, y: 0 }, { x: 80, y: 0 }, diag), "HIGH"); // 0.08
});

test("SELECTED_LANDMARKS es un set chico de índices", () => {
  assert.ok(Array.isArray(SELECTED_LANDMARKS) && SELECTED_LANDMARKS.length > 0 && SELECTED_LANDMARKS.length <= 16);
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test app/web/admin/akbal-vision/js/analysis.test.js`
Expected: FAIL (`./analysis.js` no existe).

- [ ] **Step 3: Implementar `analysis.js`**

```js
// Pure analysis helpers for Akbal Vision (Hito 2). No DOM/browser.

// Minimal, readable FaceMesh landmark set (eyes, nose tip, mouth, jaw/chin).
export const SELECTED_LANDMARKS = [33, 133, 362, 263, 1, 61, 291, 13, 14, 152, 234, 454];

const DEG = 180 / Math.PI;

// MediaPipe facialTransformationMatrix: 16 numbers, column-major 4x4. The 3x3
// rotation submatrix → Tait-Bryan yaw(Y)/pitch(X)/roll(Z) in degrees. Verified
// against pure Ry/Rx/Rz in the tests. Missing/short matrix → zeros.
export function headPose(matrix16) {
  if (!matrix16 || matrix16.length < 16) return { yaw: 0, pitch: 0, roll: 0 };
  const r = (row, col) => matrix16[col * 4 + row];
  const yaw = Math.atan2(r(0, 2), r(2, 2)) * DEG;
  const pitch = Math.atan2(-r(1, 2), Math.hypot(r(1, 0), r(1, 1))) * DEG;
  const roll = Math.atan2(r(1, 0), r(1, 1)) * DEG;
  return { yaw, pitch, roll };
}

const FRONTAL_DEG = 15;

export function poseState({ yaw, pitch }) {
  if (Math.abs(yaw) < FRONTAL_DEG && Math.abs(pitch) < FRONTAL_DEG) return "FRONTAL";
  if (Math.abs(yaw) >= Math.abs(pitch)) return yaw > 0 ? "RIGHT" : "LEFT";
  return pitch > 0 ? "DOWN" : "UP";
}

const LOOK_DEG = 12;

export function eyeContactState(pose) {
  if (!pose) return "UNKNOWN";
  return Math.abs(pose.yaw) < LOOK_DEG && Math.abs(pose.pitch) < LOOK_DEG ? "LOOKING" : "NOT_LOOKING";
}

// Per-frame bbox-center displacement, normalized by the frame diagonal so it's
// resolution-independent. No previous position (new subject) → STATIC.
export function motionState(prevCenter, curCenter, frameDiag) {
  if (!prevCenter || !frameDiag) return "STATIC";
  const d = Math.hypot(curCenter.x - prevCenter.x, curCenter.y - prevCenter.y) / frameDiag;
  if (d < 0.005) return "STATIC";
  if (d < 0.02) return "LOW";
  if (d < 0.05) return "MEDIUM";
  return "HIGH";
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `node --test app/web/admin/akbal-vision/js/analysis.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/web/admin/akbal-vision/js/analysis.js app/web/admin/akbal-vision/js/analysis.test.js
git commit -m "feat(akbal-vision): analysis.js — head pose/eye contact/motion (puro, con tests)"
```

---

### Task 2: `annotate()` — rellenar el WorldState y emitir eye-contact

**Files:**
- Modify: `app/web/admin/akbal-vision/js/analysis.js` (añadir `annotate`)
- Test: `app/web/admin/akbal-vision/js/analysis.test.js` (añadir casos)

**Interfaces:**
- Consumes: `headPose/poseState/eyeContactState/motionState` (Task 1); `Subject` con `matrix` (number[16]|null) y `landmarks` provistos por vision.js (Task 3).
- Produces: `annotate(subjects, prevSubjects, frameDiag) -> { subjects, events }`. Muta/escribe en cada subject `pose`, `orientation`, `eyeContact`, `motion` (y conserva `landmarks`). `events` = `[{type:"subject.eyeContact", payload: subject}]` SOLO para sujetos que pasan a `LOOKING` desde un estado previo distinto.

- [ ] **Step 1: Añadir los tests que fallan**

```js
import { annotate } from "./analysis.js"; // añadir al import existente

const subj = (id, extra = {}) => ({ id, center: { x: 100, y: 100 }, matrix: null, landmarks: null, ...extra });

test("annotate rellena los campos y motion usa el center previo", () => {
  const prev = { "SUBJ-0001": subj("SUBJ-0001", { center: { x: 0, y: 0 } }) };
  const cur = { "SUBJ-0001": subj("SUBJ-0001", { center: { x: 80, y: 0 } }) };
  const { subjects } = annotate(cur, prev, 1000);
  assert.equal(subjects["SUBJ-0001"].motion, "HIGH");
  assert.equal(subjects["SUBJ-0001"].orientation, "FRONTAL"); // matrix null → yaw/pitch 0
  assert.equal(subjects["SUBJ-0001"].eyeContact, "UNKNOWN"); // sin matriz → UNKNOWN
});

test("annotate emite subject.eyeContact solo al ENTRAR a LOOKING", () => {
  const looking = (id) => subj(id, { matrix: new Array(16).fill(0).map((_, i) => (i % 5 === 0 ? 1 : 0)) }); // identidad → frontal → LOOKING
  // frame 1: no había previo mirando → entra a LOOKING → evento
  let r = annotate({ "SUBJ-0001": looking("SUBJ-0001") }, {}, 1000);
  assert.ok(r.events.some((e) => e.type === "subject.eyeContact" && e.payload.id === "SUBJ-0001"));
  // frame 2: ya estaba LOOKING → sin evento nuevo
  r = annotate({ "SUBJ-0001": looking("SUBJ-0001") }, r.subjects, 1000);
  assert.ok(!r.events.some((e) => e.type === "subject.eyeContact"));
});
```
(Nota: una matriz identidad column-major es `[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]`; el `i%5===0` de arriba produce exactamente esos unos en 0,5,10,15.)

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test app/web/admin/akbal-vision/js/analysis.test.js`
Expected: FAIL (`annotate` no existe).

- [ ] **Step 3: Implementar `annotate` en `analysis.js`**

```js
// Fills pose/orientation/eyeContact/motion on each subject (from its matrix +
// its previous center) and emits subject.eyeContact only on the transition
// INTO "LOOKING" (not every frame). Pure: returns the same subjects object
// mutated in place plus the events for the caller to publish.
export function annotate(subjects, prevSubjects = {}, frameDiag = 0) {
  const events = [];
  for (const s of Object.values(subjects)) {
    const prev = prevSubjects[s.id] || null;
    const pose = s.matrix ? headPose(s.matrix) : null;
    s.pose = pose || { yaw: 0, pitch: 0, roll: 0 };
    s.orientation = poseState(s.pose);
    s.eyeContact = eyeContactState(pose);
    s.motion = motionState(prev ? prev.center : null, s.center, frameDiag);
    if (s.eyeContact === "LOOKING" && (!prev || prev.eyeContact !== "LOOKING")) {
      events.push({ type: "subject.eyeContact", payload: s });
    }
  }
  return { subjects, events };
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `node --test app/web/admin/akbal-vision/js/analysis.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add app/web/admin/akbal-vision/js/analysis.js app/web/admin/akbal-vision/js/analysis.test.js
git commit -m "feat(akbal-vision): annotate() — rellena pose/motion y emite subject.eyeContact"
```

---

### Task 3: `vision.js` → FaceLandmarker (landmarks + matriz + bbox)

**Files:**
- Modify: `app/web/admin/akbal-vision/js/vision.js`

**Interfaces:**
- Consumes: FaceLandmarker de `/akbal-vision/vendor/mediapipe`, modelo `/akbal-vision/models/face_landmarker.task`; `SELECTED_LANDMARKS` de `analysis.js`.
- Produces: `detect(nowMs)` ahora devuelve por rostro `{ bbox:{x,y,w,h}, confidence, landmarks:[{x,y}...], matrix:number[16]|null }`. `bbox` = extensión (min/max) de TODOS los landmarks en píxeles; `landmarks` = solo los `SELECTED_LANDMARKS` en píxeles; `matrix` = `facialTransformationMatrixes[i].data` o `null`; `confidence` = 1 cuando hay malla (lock), ver decisión de diseño.

- [ ] **Step 1: Reescribir `vision.js`**

```js
import { FilesetResolver, FaceLandmarker } from "../vendor/mediapipe/vision_bundle.mjs";
import { SELECTED_LANDMARKS } from "./analysis.js";

// MediaPipe FaceLandmarker (vendored, no CDN). VIDEO mode. Outputs, per face:
// selected landmarks + full-extent bbox (video pixels) + the 4x4 facial
// transformation matrix (head pose). Absolute asset URLs (document-relative).
export function createVision({ video }) {
  let landmarker = null;

  async function init() {
    const files = await FilesetResolver.forVisionTasks("/akbal-vision/vendor/mediapipe");
    landmarker = await FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: "/akbal-vision/models/face_landmarker.task" },
      runningMode: "VIDEO",
      numFaces: 4,
      outputFacialTransformationMatrixes: true,
    });
  }

  function detect(nowMs) {
    if (!landmarker || !video.videoWidth) return [];
    const res = landmarker.detectForVideo(video, nowMs);
    const W = video.videoWidth, H = video.videoHeight;
    const faces = res.faceLandmarks || [];
    return faces.map((lm, i) => {
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      for (const p of lm) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
      const bbox = { x: minX * W, y: minY * H, w: (maxX - minX) * W, h: (maxY - minY) * H };
      const landmarks = SELECTED_LANDMARKS.filter((idx) => lm[idx]).map((idx) => ({ x: lm[idx].x * W, y: lm[idx].y * H }));
      const matrix = res.facialTransformationMatrixes?.[i]?.data ? Array.from(res.facialTransformationMatrixes[i].data) : null;
      return { bbox, confidence: 1, landmarks, matrix };
    });
  }

  return { init, detect };
}
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node --check app/web/admin/akbal-vision/js/vision.js`
Expected: sin salida (OK).

- [ ] **Step 3: Verificación manual (navegador, localhost)**

Con la cámara iniciada, en consola:
```js
const { createVision } = await import("/akbal-vision/js/vision.js");
const v = createVision({ video: document.getElementById("av-video") }); await v.init();
console.log(v.detect(performance.now()));
```
Expected: con un rostro, un objeto con `bbox` plausible, `landmarks` (varios puntos), y `matrix` de 16 números. Girar la cabeza cambia la matriz.

- [ ] **Step 4: Commit**

```bash
git add app/web/admin/akbal-vision/js/vision.js
git commit -m "feat(akbal-vision): vision.js usa FaceLandmarker (landmarks + matriz + bbox)"
```

---

### Task 4: Wiring en `app.js` + landmarks en el HUD + panel/debug

**Files:**
- Modify: `app/web/admin/akbal-vision/js/app.js` (annotate en el vision loop; evento; debug pose)
- Modify: `app/web/admin/akbal-vision/js/hud.js` (dibujar landmarks del primary)
- Modify: `app/web/admin/akbal-vision/js/tracker.js` (conservar `matrix` del detection en el subject)
- Modify: `app/web/admin/akbal-vision/js/ui.js` (quitar el `muted` de orientation/eye/motion; yaw/pitch/roll en debug)

**Interfaces:**
- Consumes: `annotate` (Task 2), `detect` con `matrix`/`landmarks` (Task 3), `mapBox` del HUD.
- Produces: el vision loop corre `annotate(state.subjects, prevSnapshot.subjects, frameDiag)` tras `tracker.update`, publica sus eventos, y guarda el estado; el HUD dibuja los landmarks selectos del primary; el panel muestra los campos reales; el overlay de debug añade `POSE y/p/r`.

- [ ] **Step 1: `tracker.js` conserva la matriz**

En la rama de detección nueva y en el match, propagar `matrix` desde la detección al subject (hoy solo pasa `landmarks`). En el objeto del match: `landmarks: d.landmarks ?? null, matrix: d.matrix ?? null`. En el subject nuevo: añadir `matrix: d.matrix ?? null`. (Buscar `landmarks: d.landmarks ?? null` — hay dos sitios.)

- [ ] **Step 2: `app.js` corre annotate en el vision loop**

Importar `annotate`:
```js
import { annotate } from "./analysis.js";
```
En `visionTick`, tras `const { state, events } = tracker.update(...)` y antes de `store.set(state)`:
```js
const prev = store.snapshot();
const frameDiag = Math.hypot(video.videoWidth || 0, video.videoHeight || 0);
const ann = annotate(state.subjects, prev.subjects, frameDiag);
const allEvents = [...events, ...ann.events];
store.set(state);
for (const ev of allEvents) bus.emit(ev.type, ev.payload);
```
(Reemplaza el `store.set(state)` + loop de `events` actuales.) Y añadir el log del nuevo evento:
```js
bus.on("subject.eyeContact", (s) => ui.logEvent(`EYE CONTACT ${s.id}`));
```

- [ ] **Step 3: `hud.js` dibuja los landmarks del primary**

Añadir en `update`, dentro del loop de sujetos, para el primary y si `s.landmarks`:
```js
// draw selected landmarks as short crosshair points (primary only)
if (s.isPrimary && s.landmarks && s.landmarks.length) {
  const pts = [];
  for (const p of s.landmarks) {
    const q = mapBox({ x: p.x, y: p.y, w: 0, h: 0 }, metrics); // reuse cover+mirror mapping
    const r = 3;
    pts.push(new THREE.Vector3(q.x - r, q.y, 0), new THREE.Vector3(q.x + r, q.y, 0));
    pts.push(new THREE.Vector3(q.x, q.y - r, 0), new THREE.Vector3(q.x, q.y + r, 0));
  }
  // second LineSegments child for landmarks (create once, like the corners)
  ...
}
```
Detalle de implementación: añadir un segundo `LineSegments` al group (en `makeGroup`) para los landmarks, con su propia geometría actualizada aquí; limpiar su geometría cuando el sujeto no es primary o no tiene landmarks. `mapBox` con w=0,h=0 devuelve el punto mapeado (el espejo usa `cssW-(x+0)`); verificar que el punto cae sobre el rasgo en el video espejado (Task 5).

- [ ] **Step 4: `ui.js` — panel real + debug pose**

En `renderTarget`, quitar la clase `muted` de orientation/eye/motion (ya traen datos). En `setDebug`, añadir la línea de pose:
```js
`... FACES ${stats.faces}\nPOSE ${stats.pose || "—"}`
```
Y en `app.js` poblar `perf.pose` con el yaw/pitch/roll del primary cada frame del render loop:
```js
const primary = snap.subjects[snap.primaryId];
perf.pose = primary ? `y${primary.pose.yaw.toFixed(0)} p${primary.pose.pitch.toFixed(0)} r${primary.pose.roll.toFixed(0)}` : "—";
```

- [ ] **Step 5: Sintaxis**

Run: `node --check app/web/admin/akbal-vision/js/app.js app/web/admin/akbal-vision/js/hud.js app/web/admin/akbal-vision/js/tracker.js app/web/admin/akbal-vision/js/ui.js`
Expected: OK. Luego la suite pura: `node --test app/web/admin/akbal-vision/js/*.test.js` → verde (tracker sigue pasando; matrix es aditivo).

- [ ] **Step 6: Commit**

```bash
git add app/web/admin/akbal-vision/js/app.js app/web/admin/akbal-vision/js/hud.js app/web/admin/akbal-vision/js/tracker.js app/web/admin/akbal-vision/js/ui.js
git commit -m "feat(akbal-vision): wiring de análisis — landmarks en HUD, panel real, evento y debug de pose"
```

---

### Task 5: Verificación manual + calibración en dispositivo

**Files:** ninguno (verificación; posibles ajustes de signo/umbral en `analysis.js` si la calibración lo pide, cada uno con su test).

- [ ] **Step 1: Suite pura completa**

Run: `node --test app/web/admin/akbal-vision/js/*.test.js`
Expected: PASS (events + config + worldstate + tracker + boot + paths + analysis).

- [ ] **Step 2: Verificación en navegador (localhost, contexto seguro)**

Expected, con un rostro:
- Se dibujan puntos de landmarks (ojos/nariz/boca/mandíbula) sobre el rostro del **primary**, alineados (no espejados al revés).
- El panel muestra ORIENTATION cambiando (FRONTAL al mirar de frente; LEFT/RIGHT al girar; UP/DOWN al inclinar), EYE CONTACT (LOOKING de frente, NOT_LOOKING al desviar), MOTION (STATIC quieto, sube al moverse).
- `EYE CONTACT <id>` aparece en el event log al recuperar la mirada (no en cada frame).
- DEBUG muestra `POSE y/p/r`.

- [ ] **Step 3: Calibración (si hace falta)**

Si LEFT/RIGHT salen invertidos respecto a lo que se ve en el video **espejado**, invertir el signo del yaw en `poseState`/`eyeContactState` (o negar `yaw` en `headPose`) — **con un test que fije el nuevo signo** (RED→GREEN) antes de ajustar. Igual para umbrales FRONTAL_DEG/LOOK_DEG si son muy sensibles.

- [ ] **Step 4: Ledger** de lo verificado y lo PENDIENTE USUARIO (lo visual requiere navegador + cámara).

---

## Notas de cierre

- Deploy tras el merge: `whisplay update` + `whisplay service restart` (los assets de MediaPipe ya están; solo cambia código frontend). La cámara desde cualquier equipo ya funciona por el HTTPS del Hito 3.
- Rendimiento: FaceLandmarker es más pesado que FaceDetector; si en la Pi va lento, bajar `numFaces` o `visionFps` (los modos HIGH/BALANCED/LOW del Hito 3 — pendientes — son el lugar para afinarlo).
- Los modos de rendimiento, el overlay de debug completo y la optimización de kiosk siguen siendo el bloque restante del Hito 3, fuera de este plan.
