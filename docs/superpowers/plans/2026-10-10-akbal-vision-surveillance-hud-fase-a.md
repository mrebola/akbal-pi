# Akbal Vision — Surveillance HUD, Fase A, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar la presentación de Akbal Vision a un scanner óptico cyberpunk fullscreen (surveillance/CRT) mostrando TODOS los datos MEASURED derivables hoy del FaceLandmarker, con el marco MEASURED/ESTIMATED (confidence + leyenda) y el panel PROBABILISTIC ANALYSIS en placeholder, dejando listo el seam del estimador para la Fase B.

**Architecture:** Motor sin cambios (camera/vision/tracker/analysis). Nuevos módulos puros: `metrics.js` (EAR/MAR/gaze/coverage/motion/blink-FSM/quality/appearances), `report.js` (filas {key,label,value,kind,confidence}), `estimator.js` (interfaz + nullEstimator + allowlist ética). Presentación reconstruida en 4 capas: video fullscreen → Three (cajas/landmarks/retículas) → overlay CRT (CSS) → DOM (expediente del PRIMARY, labels flotantes, barra LIVE/CAM-01/reloj, leyenda). El pipeline por frame de visión: detect→tracker→annotate→metrics→estimator(no-op)→store.

**Tech Stack:** JS vanilla ES Modules, MediaPipe FaceLandmarker (478 landmarks + iris), Three.js, CSS (CRT), `node --test` para la lógica pura.

**Spec:** `docs/superpowers/specs/2026-10-10-akbal-vision-surveillance-hud-design.md`

## Global Constraints

- JS vanilla ESM bajo `app/web/admin/akbal-vision/`; sin build; `node --test js/*.test.js` para lo puro.
- **Solo datos reales:** cada campo es MEASURED (cálculo directo) o ESTIMATED (con `EST.` + confidence). Nada de relleno.
- **Ética (frontera dura):** prohibido todo dato de criminalidad/peligrosidad/amenaza/intención/personalidad/inteligencia/estado mental/política/religión/orientación sexual/condición médica. El `estimator` tiene una **allowlist** de claves; lo demás es irrepresentable. Edad/género solo "APPARENT"+EST.+confidence.
- Local, sin backend, **sin guardar ni subir** imágenes/frames/landmarks (todo en memoria de sesión).
- Estética: `#00FF66` sobre `#020805`, monospace, líneas finas, glow sutil, scanlines CRT.
- Rutas absolutas `/akbal-vision/...` (document-relative) como en Hitos previos.
- Node 20+.

## Review Focus

- **Landmark faltante / lm incompleto** (MediaPipe a veces no da iris o algún índice) → las métricas devuelven un valor seguro ("—"/0), sin NaN ni crash. → test puro en Task 1.
- **Sujeto nuevo sin historial** → blink rate "—", appearances 1, motion STATIC; sin leer `undefined`. → test puro en Task 2.
- **frame/bbox degenerado (w=0, h=0 o frame 0)** → coverage/position no dividen por cero. → test puro en Task 1.
- **estimator con clave fuera de la allowlist** → se ignora (no se muestra dato prohibido). → test puro en Task 4.
- **Espejo** → labels flotantes y landmarks caen sobre el rostro, no en su reflejo. → verificación manual en Task 9.

---

### Task 1: `metrics.js` — geometría pura (EAR/MAR/gaze/coverage/position/motion)

**Files:**
- Create: `app/web/admin/akbal-vision/js/metrics.js`
- Test: `app/web/admin/akbal-vision/js/metrics.test.js`

**Interfaces:**
- Consumes: `lm` = array de landmarks normalizados `[{x,y}...]` (índice = punto FaceMesh); `bbox` px; `frame {w,h}`; `pose {yaw,pitch,roll}`.
- Produces (todas puras, nunca lanzan, devuelven número o null):
  - Constantes `IDX` (índices de ojos/boca/iris).
  - `ear(lm, eye) -> number|null`, `eyeOpenness(lm, eye) -> 0..100|null`.
  - `mar(lm) -> number|null`, `mouthOpen(lm) -> {pct, open}|null`.
  - `gaze(lm, pose) -> "CAMERA"|"LEFT"|"RIGHT"|"UP"|"DOWN"|"UNKNOWN"`.
  - `faceCoverage(bbox, frame) -> 0..100`, `proximity(coveragePct) -> "FAR"|"MEDIUM"|"NEAR"`.
  - `positionPct(bbox, frame) -> {x,y}` (0..100), `motionVector(prev, cur) -> {mag, angleDeg}|null`.

- [ ] **Step 1: Escribir el test que falla**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { IDX, ear, eyeOpenness, mar, mouthOpen, gaze, faceCoverage, proximity, positionPct, motionVector } from "./metrics.js";

// Build a 478-slot landmark array; set only the indices we test.
function lmWith(points) { const a = Array.from({ length: 478 }, () => ({ x: 0, y: 0 })); for (const [i, p] of Object.entries(points)) a[i] = p; return a; }

test("ear: ojo abierto ~0.3, cerrado ~0.1 (vertical/horizontal)", () => {
  const openL = lmWith({ [IDX.LEFT.top]: { x: 0.5, y: 0.40 }, [IDX.LEFT.bottom]: { x: 0.5, y: 0.46 }, [IDX.LEFT.outer]: { x: 0.40, y: 0.43 }, [IDX.LEFT.inner]: { x: 0.60, y: 0.43 } });
  assert.ok(Math.abs(ear(openL, IDX.LEFT) - 0.3) < 0.01);
  assert.ok(eyeOpenness(openL, IDX.LEFT) >= 95);
});

test("eyeOpenness: null si faltan los landmarks (todo en 0,0)", () => {
  assert.equal(ear(lmWith({}), IDX.LEFT), null); // horizontal dist 0 → null, sin dividir por cero
});

test("mar/mouthOpen: boca abierta", () => {
  const open = lmWith({ [IDX.MOUTH.top]: { x: 0.5, y: 0.60 }, [IDX.MOUTH.bottom]: { x: 0.5, y: 0.72 }, [IDX.MOUTH.left]: { x: 0.42, y: 0.66 }, [IDX.MOUTH.right]: { x: 0.58, y: 0.66 } });
  assert.ok(mouthOpen(open).open === true);
});

test("faceCoverage/proximity/position: sin dividir por cero", () => {
  assert.equal(faceCoverage({ x: 0, y: 0, w: 0, h: 0 }, { w: 0, h: 0 }), 0);
  const cov = faceCoverage({ x: 0, y: 0, w: 640, h: 360 }, { w: 1280, h: 720 }); // 25%
  assert.ok(Math.abs(cov - 25) < 0.1);
  assert.equal(proximity(5), "FAR");
  assert.equal(proximity(15), "MEDIUM");
  assert.equal(proximity(40), "NEAR");
  assert.deepEqual(positionPct({ x: 320, y: 180, w: 640, h: 360 }, { w: 1280, h: 720 }), { x: 50, y: 50 });
});

test("motionVector: null sin prev; magnitud/ángulo con prev", () => {
  assert.equal(motionVector(null, { x: 10, y: 10 }), null);
  const v = motionVector({ x: 0, y: 0 }, { x: 10, y: 0 });
  assert.ok(Math.abs(v.mag - 10) < 1e-6 && Math.abs(v.angleDeg - 0) < 1e-6);
});

test("gaze: frontal + iris centrado = CAMERA; UNKNOWN sin iris", () => {
  const centered = lmWith({ [IDX.LEFT.outer]: { x: 0.40, y: 0.43 }, [IDX.LEFT.inner]: { x: 0.60, y: 0.43 }, [IDX.LEFT.iris]: { x: 0.50, y: 0.43 }, [IDX.RIGHT.outer]: { x: 0.80, y: 0.43 }, [IDX.RIGHT.inner]: { x: 0.70, y: 0.43 }, [IDX.RIGHT.iris]: { x: 0.75, y: 0.43 } });
  assert.equal(gaze(centered, { yaw: 2, pitch: 1, roll: 0 }), "CAMERA");
  assert.equal(gaze(lmWith({}), { yaw: 0, pitch: 0, roll: 0 }), "UNKNOWN");
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test app/web/admin/akbal-vision/js/metrics.test.js`
Expected: FAIL (`./metrics.js` no existe).

- [ ] **Step 3: Implementar `metrics.js`** (geometría)

```js
// Pure MEASURED facial metrics from MediaPipe FaceLandmarker (normalized lm[]).
// Never throws; returns null / safe values when landmarks are missing.
export const IDX = {
  LEFT:  { top: 159, bottom: 145, outer: 33, inner: 133, iris: 468 },
  RIGHT: { top: 386, bottom: 374, outer: 263, inner: 362, iris: 473 },
  MOUTH: { top: 13, bottom: 14, left: 61, right: 291 },
};
const EAR_CLOSED = 0.1, EAR_OPEN = 0.3, MAR_OPEN = 0.35;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const dist = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0);
const has = (lm, i) => lm && lm[i] && (lm[i].x !== 0 || lm[i].y !== 0);

export function ear(lm, eye) {
  if (!has(lm, eye.top) || !has(lm, eye.bottom) || !has(lm, eye.outer) || !has(lm, eye.inner)) return null;
  const h = dist(lm[eye.outer], lm[eye.inner]);
  if (h === 0) return null;
  return dist(lm[eye.top], lm[eye.bottom]) / h;
}
export function eyeOpenness(lm, eye) {
  const e = ear(lm, eye);
  return e == null ? null : Math.round(clamp01((e - EAR_CLOSED) / (EAR_OPEN - EAR_CLOSED)) * 100);
}
export function mar(lm) {
  if (!has(lm, IDX.MOUTH.left) || !has(lm, IDX.MOUTH.right)) return null;
  const w = dist(lm[IDX.MOUTH.left], lm[IDX.MOUTH.right]);
  if (w === 0) return null;
  return dist(lm[IDX.MOUTH.top], lm[IDX.MOUTH.bottom]) / w;
}
export function mouthOpen(lm) {
  const m = mar(lm);
  return m == null ? null : { pct: Math.round(clamp01(m / 0.6) * 100), open: m > MAR_OPEN };
}
export function gaze(lm, pose) {
  const r = (eye) => (has(lm, eye.iris) && has(lm, eye.outer) && has(lm, eye.inner)
    ? (lm[eye.iris].x - lm[eye.outer].x) / ((lm[eye.inner].x - lm[eye.outer].x) || 1) : null);
  const l = r(IDX.LEFT), rr = r(IDX.RIGHT);
  if (l == null && rr == null) return "UNKNOWN";
  if (pose) {
    if (pose.yaw <= -15) return "LEFT";
    if (pose.yaw >= 15) return "RIGHT";
    if (pose.pitch >= 15) return "DOWN";
    if (pose.pitch <= -15) return "UP";
  }
  const avg = ((l ?? 0.5) + (rr ?? 0.5)) / 2; // ~0.5 centered
  if (avg < 0.35) return "LEFT";
  if (avg > 0.65) return "RIGHT";
  return "CAMERA";
}
export function faceCoverage(bbox, frame) {
  const fa = (frame?.w || 0) * (frame?.h || 0);
  if (fa === 0) return 0;
  return Math.round(((bbox.w * bbox.h) / fa) * 1000) / 10;
}
export function proximity(coveragePct) {
  if (coveragePct >= 30) return "NEAR";
  if (coveragePct >= 10) return "MEDIUM";
  return "FAR";
}
export function positionPct(bbox, frame) {
  const w = frame?.w || 1, h = frame?.h || 1;
  return { x: Math.round(((bbox.x + bbox.w / 2) / w) * 100), y: Math.round(((bbox.y + bbox.h / 2) / h) * 100) };
}
export function motionVector(prevCenter, curCenter) {
  if (!prevCenter) return null;
  const dx = curCenter.x - prevCenter.x, dy = curCenter.y - prevCenter.y;
  return { mag: Math.hypot(dx, dy), angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI };
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `node --test app/web/admin/akbal-vision/js/metrics.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/web/admin/akbal-vision/js/metrics.js app/web/admin/akbal-vision/js/metrics.test.js
git commit -m "feat(akbal-vision): metrics.js geometría (EAR/MAR/gaze/coverage/motion, puro+tests)"
```

---

### Task 2: `metrics.js` — temporal (blink FSM, blink rate, appearances, quality) + `computeMetrics`

**Files:**
- Modify: `app/web/admin/akbal-vision/js/metrics.js`
- Test: `app/web/admin/akbal-vision/js/metrics.test.js`

**Interfaces:**
- Produces: `createMetricsHistory() -> history` (estado por ID). `computeMetrics(subjects, prevSubjects, frame, history, nowMs) -> subjects` — escribe en cada subject: `eyeL`, `eyeR` (0..100|null), `blink` (bool), `blinkRate` (num|null), `mouth` ({pct,open}|null), `gaze`, `coverage`, `proximity`, `position`, `motion` (ya del Hito2) + `motionVec`, `trackQuality` (0..100), `landmarkQuality` (0..100), `appearances` (int). Actualiza `history` por ID (EAR previo para el FSM de blink, lista de timestamps de blinks, episodios visibles, visto-el-frame-anterior). Pura respecto a entradas; `history` es el acumulador explícito.

- [ ] **Step 1: Añadir los tests que fallan**

```js
import { createMetricsHistory, computeMetrics } from "./metrics.js"; // añadir al import

const lmOpen = lmWith({ [IDX.LEFT.top]: { x: 0.5, y: 0.40 }, [IDX.LEFT.bottom]: { x: 0.5, y: 0.46 }, [IDX.LEFT.outer]: { x: 0.4, y: 0.43 }, [IDX.LEFT.inner]: { x: 0.6, y: 0.43 }, [IDX.RIGHT.top]: { x: 0.5, y: 0.40 }, [IDX.RIGHT.bottom]: { x: 0.5, y: 0.46 }, [IDX.RIGHT.outer]: { x: 0.8, y: 0.43 }, [IDX.RIGHT.inner]: { x: 0.7, y: 0.43 } });
const lmClosed = lmWith({ [IDX.LEFT.top]: { x: 0.5, y: 0.425 }, [IDX.LEFT.bottom]: { x: 0.5, y: 0.435 }, [IDX.LEFT.outer]: { x: 0.4, y: 0.43 }, [IDX.LEFT.inner]: { x: 0.6, y: 0.43 }, [IDX.RIGHT.top]: { x: 0.5, y: 0.425 }, [IDX.RIGHT.bottom]: { x: 0.5, y: 0.435 }, [IDX.RIGHT.outer]: { x: 0.8, y: 0.43 }, [IDX.RIGHT.inner]: { x: 0.7, y: 0.43 } });
const S = (id, lm, center = { x: 100, y: 100 }) => ({ id, lm, center, bbox: { x: 60, y: 60, w: 80, h: 80 } });
const frame = { w: 1280, h: 720 };

test("blink: flanco abierto→cerrado→abierto cuenta 1 parpadeo", () => {
  const h = createMetricsHistory();
  let subs = { A: S("A", lmOpen) };
  computeMetrics(subs, {}, frame, h, 1000);
  assert.equal(subs.A.blink, false);
  subs = { A: S("A", lmClosed) };
  computeMetrics(subs, { A: S("A", lmOpen) }, frame, h, 1100); // se cierra
  subs = { A: S("A", lmOpen) };
  const out = computeMetrics(subs, { A: S("A", lmClosed) }, frame, h, 1200); // se reabre → parpadeo
  assert.equal(out.A.blink, true);
});

test("appearances: cuenta episodios visibles (perdido→visto)", () => {
  const h = createMetricsHistory();
  computeMetrics({ A: S("A", lmOpen) }, {}, frame, h, 1000); // aparece: 1
  computeMetrics({}, { A: S("A", lmOpen) }, frame, h, 1100); // no visible este frame
  const out = computeMetrics({ A: S("A", lmOpen) }, {}, frame, h, 1200); // reaparece: 2
  assert.equal(out.A.appearances, 2);
});

test("blinkRate null hasta ~10s de ventana; coverage/quality presentes", () => {
  const h = createMetricsHistory();
  const out = computeMetrics({ A: S("A", lmOpen) }, {}, frame, h, 1000);
  assert.equal(out.A.blinkRate, null);
  assert.ok(out.A.coverage > 0 && out.A.trackQuality >= 0 && out.A.landmarkQuality >= 0);
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test app/web/admin/akbal-vision/js/metrics.test.js`
Expected: FAIL (`createMetricsHistory`/`computeMetrics` no existen).

- [ ] **Step 3: Implementar lo temporal** (añadir a `metrics.js`)

```js
const BLINK_OPEN = 60, BLINK_CLOSED = 20; // openness % hysteresis
const BLINKRATE_MIN_MS = 10000;

export function createMetricsHistory() { return new Map(); } // id -> {eyeState, blinks:[], firstSeen, seenPrev, episodes}

export function computeMetrics(subjects, prevSubjects = {}, frame = { w: 0, h: 0 }, history = createMetricsHistory(), nowMs = 0) {
  for (const s of Object.values(subjects)) {
    const lm = s.lm || null;
    s.eyeL = eyeOpenness(lm, IDX.LEFT);
    s.eyeR = eyeOpenness(lm, IDX.RIGHT);
    s.mouth = mouthOpen(lm);
    s.gaze = gaze(lm, s.pose);
    s.coverage = faceCoverage(s.bbox, frame);
    s.proximity = proximity(s.coverage);
    s.position = positionPct(s.bbox, frame);
    const prev = prevSubjects[s.id] || null;
    s.motionVec = motionVector(prev ? prev.center : null, s.center);
    // landmark quality: fracción de índices clave presentes
    const keys = [IDX.LEFT.top, IDX.LEFT.bottom, IDX.RIGHT.top, IDX.RIGHT.bottom, IDX.MOUTH.top, IDX.MOUTH.left, IDX.LEFT.iris, IDX.RIGHT.iris];
    s.landmarkQuality = lm ? Math.round((keys.filter((i) => has(lm, i)).length / keys.length) * 100) : 0;

    let h = history.get(s.id);
    if (!h) { h = { eyeOpen: true, blinks: [], firstSeen: nowMs, seenPrev: false, episodes: 0 }; history.set(s.id, h); }
    // appearances: cada vez que pasa de NO visible el frame previo a visible ahora
    if (!h.seenPrev) h.episodes += 1;
    s.appearances = h.episodes;
    // blink FSM con histéresis sobre el promedio de apertura
    const openAvg = [s.eyeL, s.eyeR].filter((v) => v != null);
    const avg = openAvg.length ? openAvg.reduce((a, b) => a + b, 0) / openAvg.length : 100;
    let blink = false;
    if (h.eyeOpen && avg < BLINK_CLOSED) h.eyeOpen = false;
    else if (!h.eyeOpen && avg > BLINK_OPEN) { h.eyeOpen = true; h.blinks.push(nowMs); blink = true; }
    s.blink = blink;
    // blink rate (por minuto) solo con suficiente ventana
    const windowMs = nowMs - h.firstSeen;
    h.blinks = h.blinks.filter((t) => nowMs - t <= 60000);
    s.blinkRate = windowMs >= BLINKRATE_MIN_MS ? Math.round((h.blinks.length / (windowMs / 60000)) * 10) / 10 : null;
    // track quality: confianza * (1 - jitter normalizado) — simplificado: continuidad
    s.trackQuality = Math.round(Math.min(100, (s.confidence ?? 1) * 100 * (h.seenPrev ? 1 : 0.8)));
  }
  // marcar seenPrev para el próximo frame (todos los del history)
  for (const [id, h] of history) h.seenPrev = !!subjects[id];
  return subjects;
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `node --test app/web/admin/akbal-vision/js/metrics.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add app/web/admin/akbal-vision/js/metrics.js app/web/admin/akbal-vision/js/metrics.test.js
git commit -m "feat(akbal-vision): metrics temporal — blink FSM, blink rate, appearances, quality"
```

---

### Task 3: `report.js` — filas MEASURED/ESTIMATED del panel

**Files:**
- Create: `app/web/admin/akbal-vision/js/report.js`
- Test: `app/web/admin/akbal-vision/js/report.test.js`

**Interfaces:**
- Produces: `buildReport(subject) -> { measured: Row[], estimated: Row[] }` con `Row = {label, value, confidence?}`. `measured` desde los campos de `computeMetrics`+`annotate`; `estimated` desde `subject.estimates` (o `[{label:"—", value:"MODEL NOT LOADED"}]` si vacío). `LEGEND` string exportado.

- [ ] **Step 1: Test que falla**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, LEGEND } from "./report.js";

const subj = {
  id: "SUBJ-0001", confidence: 0.982, visibleForMs: 77000, appearances: 2,
  pose: { yaw: -12.4, pitch: 4.8, roll: -2.1 }, gaze: "CAMERA", eyeL: 82, eyeR: 79,
  blink: false, mouth: { pct: 10, open: false }, motion: "LOW", coverage: 18.7, proximity: "MEDIUM",
  trackQuality: 94, landmarkQuality: 97, estimates: {},
};

test("buildReport: measured con valores reales; estimated placeholder si vacío", () => {
  const r = buildReport(subj);
  assert.ok(r.measured.find((x) => /DETECTION/i.test(x.label) && x.value.includes("98.2")));
  assert.ok(r.measured.find((x) => /COVERAGE/i.test(x.label)));
  assert.equal(r.estimated.length, 1);
  assert.match(r.estimated[0].value, /MODEL NOT LOADED/);
});

test("buildReport: estimated con confidence cuando hay estimates", () => {
  const r = buildReport({ ...subj, estimates: { ageRange: { value: "25–34", confidence: 0.72 }, genderApparent: { value: "MALE", confidence: 0.81 } } });
  const age = r.estimated.find((x) => /AGE/i.test(x.label));
  assert.equal(age.value, "25–34");
  assert.ok(Math.abs(age.confidence - 0.72) < 1e-9);
});

test("LEGEND explica MEASURED y EST.", () => {
  assert.match(LEGEND, /MEASURED/);
  assert.match(LEGEND, /EST\./);
});
```

- [ ] **Step 2: Correr → falla.** `node --test app/web/admin/akbal-vision/js/report.test.js` → FAIL.

- [ ] **Step 3: Implementar `report.js`**

```js
export const LEGEND = "MEASURED = direct visual measurement · EST. = probabilistic visual estimate";

// Allowlist of estimate keys we are willing to display (ethics: nothing else is
// representable — no criminality/threat/intent/health/politics/etc.).
const EST_LABELS = {
  ageRange: "AGE RANGE", genderApparent: "GENDER APPEAR.", glasses: "GLASSES", mask: "MASK",
  beard: "BEARD", hat: "HAT", expression: "EXPRESSION", occlusion: "OCCLUSION",
};

const fmtMs = (ms) => { const s = Math.floor(ms / 1000); const p = (n) => String(n).padStart(2, "0"); return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`; };
const n1 = (v) => (v == null ? "—" : (Math.round(v * 10) / 10).toString());

export function buildReport(s) {
  const measured = [
    { label: "DETECTION", value: `${(s.confidence * 100).toFixed(1)}%` },
    { label: "STATUS", value: "TRACKING" },
    { label: "VISIBLE", value: fmtMs(s.visibleForMs || 0) },
    { label: "APPEARANCES", value: String(s.appearances ?? 1) },
    { label: "HEAD POSE", value: `Y${n1(s.pose?.yaw)} P${n1(s.pose?.pitch)} R${n1(s.pose?.roll)}` },
    { label: "GAZE", value: s.gaze || "UNKNOWN" },
    { label: "EYES", value: `L ${s.eyeL == null ? "—" : s.eyeL + "%"}  R ${s.eyeR == null ? "—" : s.eyeR + "%"}` },
    { label: "BLINK", value: s.blink ? "YES" : "NO" + (s.blinkRate != null ? `  (${s.blinkRate}/min)` : "") },
    { label: "MOUTH", value: s.mouth == null ? "—" : s.mouth.open ? `OPEN ${s.mouth.pct}%` : "CLOSED" },
    { label: "MOTION", value: s.motion || "STATIC" },
    { label: "POSITION", value: s.position ? `${s.position.x},${s.position.y}` : "—" },
    { label: "FACE COVERAGE", value: `${s.coverage ?? 0}%  ${s.proximity || ""}`.trim() },
    { label: "TRACK QUALITY", value: `${s.trackQuality ?? 0}%` },
    { label: "LANDMARK QUALITY", value: `${s.landmarkQuality ?? 0}%` },
  ];
  const est = s.estimates || {};
  const estimated = Object.keys(EST_LABELS)
    .filter((k) => est[k])
    .map((k) => ({ label: EST_LABELS[k], value: String(est[k].value), confidence: est[k].confidence }));
  if (estimated.length === 0) estimated.push({ label: "—", value: "MODEL NOT LOADED" });
  return { measured, estimated };
}
```

- [ ] **Step 4: Correr → pasa** (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/web/admin/akbal-vision/js/report.js app/web/admin/akbal-vision/js/report.test.js
git commit -m "feat(akbal-vision): report.js — filas MEASURED/ESTIMATED + leyenda"
```

---

### Task 4: `estimator.js` — seam + nullEstimator + allowlist

**Files:**
- Create: `app/web/admin/akbal-vision/js/estimator.js`
- Test: `app/web/admin/akbal-vision/js/estimator.test.js`

**Interfaces:**
- Produces: `EST_ALLOWLIST` (set de claves permitidas, única fuente de verdad); `filterEstimates(raw) -> clean` (descarta claves fuera de la allowlist); `nullEstimator` con `estimate(subjects, video) -> {}`.

- [ ] **Step 1: Test que falla**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { EST_ALLOWLIST, filterEstimates, nullEstimator } from "./estimator.js";

test("allowlist excluye categorías prohibidas", () => {
  for (const banned of ["criminality", "threat", "danger", "intent", "personality", "politics", "religion", "sexualOrientation", "medical", "iq", "mentalState"]) {
    assert.ok(!EST_ALLOWLIST.has(banned), `${banned} jamás permitido`);
  }
  assert.ok(EST_ALLOWLIST.has("ageRange") && EST_ALLOWLIST.has("genderApparent"));
});

test("filterEstimates descarta claves fuera de la allowlist", () => {
  const clean = filterEstimates({ ageRange: { value: "25–34", confidence: 0.7 }, threat: { value: "HIGH", confidence: 0.9 } });
  assert.ok(clean.ageRange);
  assert.ok(!("threat" in clean));
});

test("nullEstimator devuelve vacío", async () => {
  assert.deepEqual(await nullEstimator.estimate({ A: {} }, null), {});
});
```

- [ ] **Step 2: Correr → falla.**

- [ ] **Step 3: Implementar `estimator.js`**

```js
// The ONLY estimate keys that may ever be displayed. Ethics boundary: anything
// about criminality, threat, intent, personality, intelligence, mental state,
// politics, religion, sexual orientation or medical conditions is NOT here and
// MUST NOT be added — it is irrepresentable by design.
export const EST_ALLOWLIST = new Set([
  "ageRange", "genderApparent", "glasses", "mask", "beard", "hat",
  "expression", "occlusion", "gazeProb", "eyeClosedProb", "mouthOpenProb",
  "talkingProb", "nearbyObject",
]);

export function filterEstimates(raw) {
  const clean = {};
  for (const k of Object.keys(raw || {})) if (EST_ALLOWLIST.has(k)) clean[k] = raw[k];
  return clean;
}

// Phase A: no model loaded. Phase B swaps this for an ONNX Runtime Web / TF.js
// estimator with the same shape, run throttled and primary-only; its output is
// always passed through filterEstimates() before display.
export const nullEstimator = {
  async estimate(_subjects, _video) { return {}; },
};
```

- [ ] **Step 4: Correr → pasa** (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/web/admin/akbal-vision/js/estimator.js app/web/admin/akbal-vision/js/estimator.test.js
git commit -m "feat(akbal-vision): estimator seam + nullEstimator + allowlist ética"
```

---

### Task 5: `vision.js` entrega landmarks completos + pipeline en `app.js`

**Files:**
- Modify: `app/web/admin/akbal-vision/js/vision.js`, `app/web/admin/akbal-vision/js/app.js`

**Interfaces:**
- `vision.detect()` añade `lm` = array normalizado completo `[{x,y}...]` por rostro (además de bbox/confidence/matrix/landmarks del Hito 2). `app.js` crea `const metricsHistory = createMetricsHistory()` y `const estimator = nullEstimator`; en el vision loop, tras `annotate`, llama `computeMetrics(state.subjects, prev.subjects, frame, metricsHistory, now)` y `const est = await estimator.estimate(state.subjects, video)` → mergea `subject.estimates = filterEstimates(est[id] || {})`.

- [ ] **Step 1: `vision.js` añade `lm`**

En el `.map` de `detect`, añadir `lm: lm.map((p) => ({ x: p.x, y: p.y }))` al objeto devuelto (el `lm` normalizado completo; `landmarks` selectos se mantienen para el HUD actual).

- [ ] **Step 2: tracker conserva `lm`** — en `tracker.js`, propagar `lm: d.lm ?? null` en match y en nuevo (junto a `matrix`).

- [ ] **Step 3: `app.js` cablea metrics + estimator**

```js
import { createMetricsHistory, computeMetrics } from "./metrics.js";
import { nullEstimator } from "./estimator.js";
import { filterEstimates } from "./estimator.js";
// ... tras instanciar:
const metricsHistory = createMetricsHistory();
const estimator = nullEstimator;
```
En `visionTick`, tras `annotate(...)` y antes de `store.set(state)`:
```js
computeMetrics(state.subjects, prev.subjects, { w: video.videoWidth, h: video.videoHeight }, metricsHistory, now);
const est = await estimator.estimate(state.subjects, video);
for (const s of Object.values(state.subjects)) s.estimates = filterEstimates(est[s.id] || {});
```

- [ ] **Step 4: Sintaxis + suite pura**

Run: `node --check app/web/admin/akbal-vision/js/vision.js app/web/admin/akbal-vision/js/app.js` ; `node --test app/web/admin/akbal-vision/js/*.test.js`
Expected: OK; suite verde (incluye metrics/report/estimator + las previas).

- [ ] **Step 5: Commit**

```bash
git add app/web/admin/akbal-vision/js/vision.js app/web/admin/akbal-vision/js/tracker.js app/web/admin/akbal-vision/js/app.js
git commit -m "feat(akbal-vision): pipeline — lm completo, computeMetrics y estimator (no-op) por frame"
```

---

### Task 6: Presentación — capas CRT + Three restilizado + barra/reloj/LIVE

**Files:**
- Modify: `app/web/admin/akbal-vision/index.html` (capa CRT, barra superior), `akbal-vision.css` (CRT/scanlines/estética), `js/hud.js` (retículas/estilo), `js/app.js` (reloj)

**Interfaces:** consume el estado ya enriquecido.

- [ ] **Step 1** index.html: añadir dentro de `#av-stage` una capa `<div id="av-crt"></div>` (sobre el canvas, bajo `#av-ui`) y en `#av-ui` una barra superior `<header id="av-topline"><span>AKBAL VISION</span><span id="av-live">● LIVE</span><span>CAM-01</span><time id="av-clock"></time></header>`.
- [ ] **Step 2** CSS: `#av-crt` con scanlines (`repeating-linear-gradient` horizontal, opacidad ~0.06), viñeta (`radial-gradient`), `pointer-events:none`; `#av-live` con animación de pulso; estética monospace/glow de `#av-topline`.
- [ ] **Step 3** hud.js: afinar el estilo de las cajas (esquinas target-lock ya existen) y añadir una retícula central discreta opcional; mantener landmarks del primary.
- [ ] **Step 4** app.js: en el render loop, actualizar `#av-clock` con hora+fecha (cada ~1 s basta; gatear con un contador).
- [ ] **Step 5** `node --check` de los JS tocados.
- [ ] **Step 6: Commit** `feat(akbal-vision): capas CRT + barra LIVE/CAM-01/reloj + Three restilizado`.

---

### Task 7: Panel EXPEDIENTE + labels flotantes + leyenda (ui.js)

**Files:**
- Modify: `app/web/admin/akbal-vision/js/ui.js`, `akbal-vision.css`, i18n `es.json`/`en.json`

**Interfaces:** usa `buildReport` (Task 3) y `LEGEND`.

- [ ] **Step 1** ui.js: reemplazar `renderTarget` para pintar el panel expediente desde `buildReport(primary)` — sección MEASURED (filas label/value) y PROBABILISTIC ANALYSIS (filas con `value` + `XX% EST.` si hay confidence), SYSTEM METRICS, PRIVACY (LOCAL PROCESSING / NO VIDEO UPLOAD / NO IMAGE STORAGE), y la leyenda `LEGEND`.
- [ ] **Step 2** ui.js: añadir `renderLabels(snapshot, metrics)` que crea/actualiza/elimina un `<div class="av-flabel">` por sujeto **no-primary**, posicionado con la transformada cover+espejo (misma que el HUD) sobre su bbox; contenido compacto `SUBJ-xxxx · TRACK % · GAZE · YAW · timer`. Llamarlo desde el render loop.
- [ ] **Step 3** CSS: estilos del panel expediente (columna derecha, filas monospace, tags), `.av-flabel` (caja chica translúcida), leyenda discreta.
- [ ] **Step 4** i18n: claves nuevas del chrome (labels del expediente que quieras traducir; los tokens terminal quedan fijos). Añadir a es/en.json namespace `akbalvision`.
- [ ] **Step 5** `node --check app/web/admin/akbal-vision/js/ui.js` + validar JSON i18n.
- [ ] **Step 6: Commit** `feat(akbal-vision): panel expediente + labels flotantes + leyenda MEASURED/EST.`.

---

### Task 8: Animación TARGET ACQUIRED + navbar delgado auto-ocultable

**Files:**
- Modify: `app/web/admin/akbal-vision/index.html`, `akbal-vision.css`, `js/app.js` (o ui.js)

- [ ] **Step 1** Animación: al `subject.created` o al cambiar el primary, mostrar un overlay breve `TARGET ACQUIRED` / `TRACKING` (CSS keyframes, ~1.2 s, se auto-oculta). Disparar desde el handler del bus.
- [ ] **Step 2** Navbar: hacer el `#topbar` delgado y auto-ocultable en esta página — clase que lo colapsa tras ~3 s de inactividad del mouse y reaparece en `mousemove`/toque del borde superior; el toggle de idioma sigue accesible.
- [ ] **Step 3** `node --check`.
- [ ] **Step 4: Commit** `feat(akbal-vision): animación TARGET ACQUIRED + navbar auto-ocultable`.

---

### Task 9: Verificación manual + calibración en navegador

**Files:** ninguno (verificación; posibles ajustes de umbral con test).

- [ ] **Step 1** Suite pura completa: `node --test app/web/admin/akbal-vision/js/*.test.js` → verde.
- [ ] **Step 2** Servir en localhost (`python3 -m http.server` desde `app/web/admin`, abrir `/akbal-vision/`) y verificar con cámara:
  - HUD fullscreen cyberpunk + scanlines CRT + barra LIVE/CAM-01/reloj.
  - Panel expediente con TODOS los campos MEASURED en valores reales que cambian (parpadea → BLINK/rate; abre boca → MOUTH OPEN; acércate → FACE COVERAGE sube y NEAR; muévete → MOTION/vector; mira a los lados → GAZE/HEAD POSE).
  - PROBABILISTIC ANALYSIS = "MODEL NOT LOADED"; leyenda visible.
  - Labels flotantes sobre rostros no-primary, alineados (no espejados al revés).
  - Animación TARGET ACQUIRED al entrar; navbar se oculta y reaparece.
- [ ] **Step 3** Calibración (si hace falta, cada ajuste con su test RED→GREEN): umbrales EAR_OPEN/CLOSED, MAR_OPEN, coverage FAR/MED/NEAR, y el signo del gaze vs el espejo.
- [ ] **Step 4** Ledger de lo verificado y lo PENDIENTE USUARIO.

---

## Notas de cierre

- Deploy tras merge: `whisplay update` + `whisplay service restart` (frontend; assets MediaPipe ya presentes). Cámara desde cualquier equipo por el HTTPS del Hito 3.
- **Fase B (futuro):** implementar un estimador real (ONNX Runtime Web / TF.js) detrás de `estimator.estimate`, throttled + primary-only, con modelos vendoreados; su salida SIEMPRE pasa por `filterEstimates`.
- Rendimiento: todo Fase A es matemática sobre landmarks + CSS; sin modelos nuevos.
