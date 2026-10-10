# Akbal Vision — Surveillance HUD (diseño)

> Evolución de la presentación de Akbal Vision a un scanner óptico cyberpunk
> fullscreen con datos **MEASURED** reales y **ESTIMATED** probabilísticos
> claramente etiquetados. Construye sobre
> `docs/superpowers/specs/2026-10-08-akbal-vision-design.md` (motor
> cámara→MediaPipe→tracker→analysis, Hitos 1-3 ya desplegados). Fecha: 2026-10-10.

## Objetivo

Que Akbal Vision se vea como un sistema de vigilancia/escaneo cyberpunk en
pantalla completa (surveillance / military HUD / CRT), con la cámara ocupando
todo el viewport y la interfaz superpuesta como HUD técnico diegético (menos
"SaaS", más cinematográfico). **Cada dato mostrado debe ser (1) medido
realmente, (2) calculado desde landmarks/tracking, o (3) una estimación
probabilística marcada con confidence.** Nada ficticio ni de relleno. Todo
local, sin backend, sin cloud, sin guardar imágenes.

## Decisiones (acordadas en brainstorming)

1. **Reemplaza la presentación, conserva el motor.** Camera/vision/tracker/
   analysis (Hitos 1-2) siguen; se reconstruye la capa de presentación
   (hud/ui) al look surveillance. No es un "modo" aparte: es el nuevo look de
   la sección.
2. **Dos fases, un solo spec.**
   - **Fase A (esta implementación):** HUD cyberpunk fullscreen + TODOS los
     datos **MEASURED** derivables hoy del FaceLandmarker + el marco
     MEASURED/ESTIMATED con confidence + el panel PROBABILISTIC ANALYSIS
     visible pero en placeholder ("MODEL NOT LOADED"). Sin modelos nuevos.
   - **Fase B (después):** un estimador real (edad/género aparente/glasses/
     expresión/…) vía ONNX Runtime Web o TF.js, implementando el seam ya
     definido. Fuera de la primera implementación (evita el riesgo de
     rendimiento que el usuario pidió no asumir todavía).
3. **Separación dura MEASURED vs ESTIMATED.** Cada campo mostrable lleva su
   `kind`; lo estimado SIEMPRE con `EST.` + confidence; leyenda visible.
4. **Límite ético de primera clase** (ver sección Ética): lista NO-INFERIR
   irrepresentable por diseño; edad/género solo como apariencia estimada.
5. **Navbar delgado auto-ocultable** + i18n del chrome (concilia "parte de la
   web app / navegable / toggle idioma" con el fullscreen diegético).

## Arquitectura

Motor sin cambios. Nuevo + reconstruido en `app/web/admin/akbal-vision/`:

```
js/
├── metrics.js      # [puro, NUEVO] métricas MEASURED por sujeto desde landmarks + historial
├── metrics.test.js # [NUEVO] TDD de EAR/MAR/gaze/coverage/blink-FSM/quality
├── report.js       # [puro, NUEVO] arma filas {key,label,value,kind,confidence} del panel
├── report.test.js  # [NUEVO]
├── estimator.js    # [NUEVO] interfaz del estimador + nullEstimator (Fase A); allowlist ética
├── analysis.js     # (Hito 2) head pose/eye contact/motion/annotate — se mantiene
├── tracker.js      # (Hito 1) + contador de apariciones por ID
├── vision.js       # (Hito 2) FaceLandmarker — se mantiene
├── hud.js          # [reconstruido] Three: cajas, landmarks, retículas, target-lock
├── crt.js|css      # [NUEVO] overlay CRT (scanlines/glow) en CSS
├── ui.js           # [reconstruido] capa DOM: expediente, labels flotantes, barra, leyenda
└── app.js          # [modificado] pipeline: vision→tracker→analysis→metrics→estimator→store
```

**Pipeline por frame de visión:** `detect → tracker.update → annotate (Hito 2)
→ metrics.compute(subjects, prevSubjects, frame, history) → estimator.estimate
(no-op Fase A) → store.set`. El render loop lee el store y pinta las 4 capas.

### Capas de presentación (mismo viewport, z ascendente)
1. **Video** fullscreen (`object-fit:cover`, espejo `scaleX(-1)`).
2. **Three** (canvas `#av-hud`): cajas target-lock, landmarks discretos,
   retículas.
3. **Overlay CRT** (CSS, `pointer-events:none`): scanlines sutiles, viñeta/glow.
4. **Capa DOM** (`#av-ui`): barra superior (AKBAL VISION · LIVE · CAM-01 ·
   reloj/fecha), panel EXPEDIENTE del PRIMARY, labels compactos flotantes sobre
   los no-primary (posicionados con la transformada cover+espejo cada frame),
   leyenda MEASURED/EST., animación TARGET ACQUIRED/TRACKING.

Navbar del admin: delgado, se auto-oculta (~3 s de inactividad o botón "SCAN";
reaparece al mover el mouse / tocar el borde superior). Mantiene el toggle de
idioma.

## Datos MEASURED (fórmulas; `metrics.js`, puro)

De los 478 landmarks del FaceLandmarker (incluye iris) + historial por ID:

- **Apertura ojo L/R (%):** EAR = dist. vertical párpados / dist. horizontal
  esquinas; mapeo a 0-100% entre refs cerrado(~0.1)/abierto(~0.3), clamp.
- **Blink:** FSM por ID — flanco de bajada de la apertura bajo umbral (p.ej.
  <20%) y recuperación → cuenta 1 parpadeo. Estado temporal por ID.
- **Blink rate:** parpadeos/minuto sobre la ventana visible; solo si
  `visibleForMs ≥ ~10 000` (si no, "—").
- **Boca (MAR, %):** vertical labios / horizontal comisuras → OPEN/CLOSED +
  %.
- **Gaze aprox:** centro del iris vs esquinas del ojo + head pose → CAMERA /
  LEFT / RIGHT / UP / DOWN (aprox, etiquetado).
- **Eye contact:** frontal (head pose) + iris centrado → LOOKING/NOT_LOOKING/
  UNKNOWN (refina el Hito 2).
- **Face coverage (%):** área bbox / área frame → proximidad **FAR / MEDIUM /
  NEAR** por umbrales (sin metros: no hay calibración).
- **Posición X/Y:** centro del bbox normalizado 0-100% del frame.
- **Movimiento + vector:** delta del centro / tiempo → magnitud (STATIC/LOW/
  MEDIUM/HIGH, del Hito 2) + dirección (ángulo/flecha).
- **Head pose:** yaw/pitch/roll (Hito 2).
- **Track quality (%):** heurística — continuidad de match + jitter del bbox.
- **Landmark quality (%):** presencia/conteo de landmarks (478 esperados) +
  baja varianza.
- **Apariciones:** contador por ID (veces perdido→visto en la sesión; en
  `tracker.js`).
- **FPS cámara/visión/render, inference ms, resolución, #faces:** ya existen.

Todas son funciones puras con fixtures (TDD). Ninguna necesita modelo nuevo.

## Modelo de reporte + seam del estimador

**Campo mostrable:**
```js
{ key, label, value: "<string>", kind: "measured" | "estimated", confidence?: 0..1 }
```
- `buildReport(subject)` (puro, `report.js`) arma las filas ordenadas del panel
  PRIMARY: sección **MEASURED** (de las métricas) y **PROBABILISTIC ANALYSIS**
  (de `subject.estimates`, o placeholders "— MODEL NOT LOADED" si vacío).
- La UI pinta el valor y, para `estimated`, `XX% EST.`; leyenda discreta:
  `MEASURED = direct visual measurement · EST. = probabilistic visual estimate`.

**Seam del estimador (`estimator.js`):**
```js
estimator.estimate(subjects, video) -> { <id>: { <key>: { value, confidence } } }
```
- **Fase A:** `nullEstimator` → `{}`.
- **Fase B:** estimador ONNX Runtime Web / TF.js con la misma firma; el
  pipeline lo llama **throttled y solo sobre el PRIMARY**; mergea en
  `subject.estimates`.
- **Allowlist ética de claves** (única fuente de verdad de qué es
  representable): `ageRange, genderApparent, glasses, mask, beard, hat,
  expression, occlusion, gazeProb, eyeClosedProb, mouthOpenProb, talkingProb,
  nearbyObject`. Cualquier otra clave se ignora. Las categorías NO-INFERIR no
  tienen clave → irrepresentables.

## Ética (frontera no negociable)

- **No calcular ni mostrar jamás:** criminalidad, peligrosidad, amenaza,
  intención, personalidad, inteligencia, estado mental, afiliación política,
  religión, orientación sexual, condiciones médicas. No hay campo para ninguna
  (allowlist) y se documenta la prohibición.
- Edad y género: **solo "APPARENT" + EST. + confidence**, nunca como hecho ni
  como identidad. Sin reconocimiento de identidad, sin embeddings persistidos.
- **Privacidad:** todo en memoria de sesión; no se sube ni se guarda video,
  fotos, rostros ni historial de landmarks. Panel PRIVACY: LOCAL PROCESSING /
  NO VIDEO UPLOAD / NO IMAGE STORAGE.

## Rendimiento

- Fase A barata: matemática sobre landmarks ya calculados; CRT en CSS; labels
  DOM acotados por #rostros; visión throttled (modos HIGH/BALANCED/LOW del
  Hito 3 cuando existan), render rAF. Sin modelos nuevos → perf-safe. El seam
  del estimador es no-op (costo cero) en Fase A.
- Fase B: el estimador correrá throttled y solo sobre el PRIMARY.

## Estética

Verde neón `#00FF66` sobre `#020805`, líneas finas, monospace, glow discreto,
scanlines CRT sutiles, transparencias, animaciones cortas. Herramienta técnica
real, no videojuego.

## Panel EXPEDIENTE (PRIMARY) — contenido

`AKBAL VISION` · TRACK RECORD/SUBJ · STATUS · DETECTION % · VISIBLE (hh:mm:ss) ·
APPEARANCES · HEAD POSE (yaw/pitch/roll) · GAZE · EYES L/R % · BLINK (+rate) ·
MOUTH · MOTION (+vector) · POSITION X/Y · FACE COVERAGE % (+FAR/MED/NEAR) ·
TRACK QUALITY % · LANDMARK QUALITY % · **PROBABILISTIC ANALYSIS** (Fase A:
"MODEL NOT LOADED") · **SYSTEM METRICS** (CAMERA/VISION/RENDER FPS, INFERENCE
ms, FACES, RESOLUTION) · **PRIVACY**.

No-primary: label compacto flotante, p.ej. `SUBJ-0003 · TRACK 98.4% · GAZE
CAMERA · YAW -8° · 00:47`.

## Criterios de aceptación (Fase A)

1. Cámara fullscreen; HUD verde-sobre-negro diegético; scanlines CRT; glow;
   monospace.
2. Panel expediente del PRIMARY con todos los campos MEASURED en valores
   reales; labels compactos flotantes sobre los demás rostros.
3. Leyenda MEASURED/EST.; panel PROBABILISTIC visible con "MODEL NOT LOADED".
4. Reloj/fecha, LIVE, CAM-01; animación TARGET ACQUIRED/TRACKING.
5. Reales: blink + blink-rate, apertura ojos, boca, gaze, coverage +
   FAR/MED/NEAR, vector de movimiento, track/landmark quality, apariciones,
   posición X/Y, head pose.
6. Ninguna inferencia prohibida; edad/género ausentes en Fase A (sin modelo)
   pero arquitectura (seam + allowlist + panel) lista.
7. Local, sin subir ni guardar; métricas puras con TDD (node --test).
8. Navbar delgado auto-ocultable + i18n del chrome.

## Arquitectura futura (Fase B, no se implementa ahora)

Estimador ONNX Runtime Web / TF.js detrás del seam `estimator.estimate`,
throttled y primary-only, poblando `subject.estimates` con claves de la
allowlist; edad/género/glasses/expresión/occlusion como estimaciones con
confidence. Modelos vendoreados localmente (sin CDN), como MediaPipe.
