# Akbal Vision — Diseño (spec v0.2 adaptado a akbal-pi)

> Spec de arquitectura único para Akbal Vision. La implementación se hace en
> tres hitos (ver "Hitos"), cada uno con su propio plan de implementación
> derivado de este spec. Fecha: 2026-10-08.

## Objetivo

App web local **Akbal Vision**: usa la cámara del dispositivo para detectar y
seguir rostros en tiempo real y mostrar un HUD estilo cyberpunk/surveillance.
Primero corre en una MacBook (cámara integrada, Chrome); después queda lista
para Raspberry Pi 5 con Chromium (kiosk) y webcam USB. Sin backend, sin cloud,
sin LLM por ahora. Todo el procesamiento es local; no se sube ni se guarda
video, fotos, rostros ni landmarks.

No hace reconocimiento de identidad ni estima edad, género o emociones.

## Decisiones de arquitectura (acordadas en brainstorming)

1. **Integrada en el admin actual.** Akbal Vision es una página más del admin
   web (servida por el servidor Koa existente, `app/src/device/web-admin-server.ts`),
   con el look de Akbal y **detrás del login existente**. **Sin base de datos**
   y, en el Hito 1, **sin API nueva**: es frontend autocontenido.
2. **Cámara y contexto seguro.** `getUserMedia()` exige contexto seguro (https
   o localhost). El admin se sirve hoy por http plano sobre el tailnet, lo que
   bloquearía la cámara en acceso remoto. Solución: la Pi sirve además **HTTPS
   con certificado auto-firmado** en un **puerto aparte** (p. ej. 8443) sobre el
   mismo Koa app; el `http:8090` actual queda intacto. El auto-firmado cubre las
   tres rutas de acceso (localhost / WiFi directo por IP / Tailscale) con una
   advertencia-a-aceptar por dispositivo. (Hito 3.)
3. **Dependencias locales / offline.** Three.js se reutiliza del vendor ya
   existente (`app/web/admin/vendor/three.module.min.js`). MediaPipe (runtime
   WASM + modelo `face_landmarker.task`) se baja con un script a rutas
   gitignored. Cero CDN en producción; offline tras instalar.
4. **Implementación por hitos** sobre un spec único (este), para que las
   interfaces y el Event Bus queden coherentes desde el inicio.
5. **Pruebas:** TDD con `node --test` (incluido en Node 20, sin dependencias
   nuevas) en los módulos de **lógica pura**; cámara/MediaPipe/Three/DOM se
   validan manualmente en Chrome.
6. **Flujo de datos (Enfoque 1):** estado "pull" para lo continuo + Event Bus
   para lo discreto (ver "Flujo de datos").

## Stack

- HTML5, CSS3, JavaScript **vanilla con ES Modules**. Sin React/Vue/Angular,
  sin Node.js en runtime, sin backend propio de la app.
- MediaDevices / WebRTC para cámara.
- MediaPipe Tasks Vision: **FaceDetector** (Hito 1) y **FaceLandmarker** (Hito 2).
- Three.js + WebGL para el HUD. WebAssembly (MediaPipe). Canvas 2D para debug.
- `localStorage` para preferencias. Event Bus interno en JS.
- Desarrollo: servidor estático en localhost (`python3 -m http.server 8080`).
  Deploy: integrado en el admin Koa (ver decisión 1-2).

## Estructura de archivos

```
app/web/admin/akbal-vision/
├── index.html                  # ruta /akbal-vision en web-admin-server.ts (tras login)
├── akbal-vision.css
├── js/
│   ├── app.js        # bootstrap: boot sequence, cablea módulos, arranca los 3 loops
│   ├── config.js     # [puro] defaults, modos HIGH/BALANCED/LOW, localStorage
│   ├── events.js     # [puro] event bus: emit/on/off
│   ├── worldstate.js # [puro] estado canónico: sujetos + primaryId + frame
│   ├── camera.js     # getUserMedia, enumerateDevices, cambio de cámara, errores
│   ├── vision.js     # MediaPipe FaceDetector (+FaceLandmarker en Hito 2), throttled
│   ├── tracker.js    # [puro] detecciones→WorldState, IDs SUBJ-####, primary, eventos
│   ├── analysis.js   # [puro] head pose / eye contact / motion   (Hito 2)
│   ├── scene.js      # Three.js: scene, WebGLRenderer transparente, OrthographicCamera
│   ├── hud.js        # geometría HUD por sujeto, lerp(0.18), landmarks
│   └── ui.js         # paneles DOM: target, event log, settings, boot, privacidad, debug
├── vendor/mediapipe/           # WASM + tasks-vision (bajados por script; gitignored)
└── models/face_landmarker.task # modelo (bajado por script; gitignored)
```

Three.js se importa del vendor existente del admin (no se duplica).

## Arquitectura y loops

```
Camera → <video> (nativo ~30fps)
             │
   vision loop (throttled 10-15 fps):  MediaPipe → detecciones crudas → tracker.update → WorldState (+bus)
             │
   render loop (rAF 30-60 fps):        lee WorldState → lerp HUD → Three draw + refresca UI continua
```

- **Camera:** el `<video>` corre a FPS nativo del navegador; no es un loop propio.
- **Vision loop:** timer auto-agendado, limitado a los `visionFps` del modo.
  Cada tick: inferencia MediaPipe sobre el frame actual → `tracker.update` →
  escribe `WorldState` y publica los eventos devueltos. **Auto-pacea: si una
  inferencia se pasa del presupuesto, salta el siguiente tick, nunca encola.**
- **Render loop:** `requestAnimationFrame`. Lee el `WorldState` actual, hace
  lerp del HUD hacia él, dibuja Three y refresca los campos continuos de la UI.

**Separación estricta:** `vision` no conoce Three; `tracker`/`analysis`/
`config`/`events`/`worldstate` son lógica pura (sin DOM/navegador → testeables);
`hud`/`ui` solo **leen** estado. El Event Bus es la única costura para sensores
futuros.

## Flujo de datos y contratos

### WorldState

```js
WorldState = { subjects: {id: Subject}, primaryId: string|null,
               frame: {w, h}, updatedAt: ms }

Subject = {
  id: "SUBJ-0001", bbox: {x,y,w,h}, center: {x,y}, confidence,
  firstSeen, lastSeen, visibleForMs, isPrimary,
  // Campos de Hito 2: presentes desde el Hito 1 pero en UNKNOWN/null:
  orientation: "FRONTAL"|"LEFT"|"RIGHT"|"UP"|"DOWN",
  pose: {yaw, pitch, roll},
  eyeContact: "LOOKING"|"NOT_LOOKING"|"UNKNOWN",
  motion: "STATIC"|"LOW"|"MEDIUM"|"HIGH",
  landmarks: null | [ {x,y} ... ]   // solo puntos selectos (ojos/nariz/boca/mandíbula)
}
```

Todo en **espacio de píxeles del video**. MediaPipe entrega coords normalizadas
→ se multiplican por `frame.w/h` al entrar al estado. El HUD mapea video-píxel →
píxel-en-pantalla con una sola transformada que contempla `object-fit: cover` y
el **espejo** de la cámara frontal (`facingMode: "user"`), para que el HUD no
salga volteado.

### Tracker (lógica pura, sin efectos)

```js
tracker.update(rawDetections, prevState, nowMs) -> { state: WorldState, events: [{type, payload}] }
```

- Empareja cada detección con el sujeto previo más cercano por **distancia de
  centro + similitud de tamaño** dentro de un umbral de gating; conserva el ID.
- Un sujeto sin match se mantiene hasta que `nowMs - lastSeen` supere un **TTL
  (~600 ms)** → entonces se emite `subject.lost` y se elimina.
- Detección nueva → ID `SUBJ-####` con contador monotónico → `subject.created`.
- **Primary target = bbox de mayor área** entre los visibles (`isPrimary`).
- Devuelve los eventos; el *vision loop* los publica y cambia el estado. Así el
  tracker no tiene efectos secundarios y es 100% testeable.

### Event Bus

```js
events.emit(type, payload);  events.on(type, fn);  events.off(type, fn);
```

Eventos iniciales:
- Hito 1: `system.boot.*`, `camera.ready|error|changed`, `vision.ready`,
  `vision.faceDetected`, `subject.created`, `subject.lost`.
- Hito 2: `subject.eyeContact` (al entrar/salir del estado LOOKING).

Namespaces reservados, sin acople (el bus solo transporta strings): `wifi.*`,
`gps.*`, `adsb.*`, `rf.*`, `voice.*`, `agent.*`.

### config (persistido en localStorage: mode, cameraId, debug)

```js
config = {
  mode: "HIGH"|"BALANCED"|"LOW",   // default HIGH en MacBook/PC, BALANCED en Pi
  cameraId: string|null,
  debug: false,
  modes: {
    HIGH:     {video:{w:1280,h:720}, visionFps:15, renderFps:60, landmarks:true,  effects:true},
    BALANCED: {video:{w:1280,h:720}, visionFps:10, renderFps:30, landmarks:true,  effects:false},
    LOW:      {video:{w:640, h:480}, visionFps:8,  renderFps:30, landmarks:false, effects:false}
  }
}
```

Toda lectura/escritura de `localStorage` va en try-catch (modo privado / storage
bloqueado no debe romper la app).

## Módulos (responsabilidad única)

- **config.js** [puro]: defaults, modos de rendimiento, persistencia en
  localStorage, cámara seleccionada.
- **events.js** [puro]: event bus (emit/on/off).
- **worldstate.js** [puro]: contenedor del estado canónico + accesores;
  entrega snapshots de solo lectura a hud/ui.
- **camera.js**: `enumerateDevices`, `getUserMedia` con las constraints del modo,
  cambio de cámara en caliente, manejo de errores de permiso/dispositivo,
  attach al `<video>`.
- **vision.js**: carga MediaPipe (FaceDetector; +FaceLandmarker en Hito 2) desde
  el WASM+modelo vendoreados; corre inferencia sobre el `<video>` a la tasa del
  modo; produce detecciones crudas (bbox, confidence; +landmarks en Hito 2).
- **tracker.js** [puro]: ver contrato arriba.
- **analysis.js** [puro] (Hito 2): head pose (yaw/pitch/roll → estado), eye
  contact (aprox. visual), motion (por delta del bbox).
- **scene.js**: Three.js `Scene`, `WebGLRenderer` transparente (overlay),
  `OrthographicCamera` en espacio de píxeles; maneja resize.
- **hud.js**: construye la geometría del HUD por sujeto (esquinas, target-lock,
  líneas, retículas, label, landmarks selectos), hace lerp `current.lerp(target,
  0.18)`; HUD completo para el primary, mínimo para el resto.
- **ui.js**: paneles HTML/CSS (panel AKBAL VISION del target, event log de 20,
  settings con selector de cámara y modo, secuencia de boot, badge de
  privacidad, overlay de debug, botón fullscreen).
- **app.js**: bootstrap — secuencia de boot, instancia y cablea módulos, arranca
  los tres loops.

## Especificaciones de comportamiento (del SPEC v0.2)

### Cámara
Constraints iniciales: `{ video: { width:{ideal:1280}, height:{ideal:720},
frameRate:{ideal:30}, facingMode:"user" }, audio:false }`. Permite elegir entre
las cámaras disponibles (`enumerateDevices`); guarda la elegida en localStorage.

### HUD por rostro
```
┌──            ──┐
     SUBJ-0001
     TRACKING 98%
└──            ──┘
```
Sigue al rostro con interpolación (lerp 0.18) para evitar jitter.

### Panel del Target (campos)
`AKBAL VISION` · TARGET · STATUS · CONFIDENCE · VISIBLE (mm:ss) · ORIENTATION ·
EYE CONTACT · MOTION. (ORIENTATION/EYE CONTACT/MOTION = UNKNOWN hasta Hito 2.)

### Landmarks (Hito 2)
Solo puntos relevantes (ojos, nariz, boca, mandíbula). Visualización minimalista;
no se dibujan todos los landmarks.

### Head pose (Hito 2)
Estados FRONTAL/LEFT/RIGHT/UP/DOWN; se mantienen yaw/pitch/roll para debug.

### Eye contact (Hito 2)
Estados LOOKING/NOT_LOOKING/UNKNOWN; aproximación visual, no medición exacta.

### Motion (Hito 2)
Según cambios del bbox: STATIC/LOW/MEDIUM/HIGH.

### Event Log
Últimos 20 eventos con timestamp, p. ej.:
```
12:44:01 SYSTEM ONLINE
12:44:07 SUBJECT ACQUIRED SUBJ-0001
12:44:14 EYE CONTACT SUBJ-0001
12:44:21 SUBJECT LOST SUBJ-0001
```

### Capas visuales (mismo viewport)
1) video, 2) Three.js HUD, 3) Canvas debug, 4) HTML/CSS UI.

### Estética
Cyberpunk / surveillance / military HUD / terminal. Color principal `#00FF66`,
fondo `#020805`. Líneas finas, tipografía monospace, glow sutil, scanlines
discretas, transparencias. Herramienta técnica, no videojuego.

### Boot
Secuencia breve (CAMERA/VISION/TRACKER/RENDERER … OK → LOCAL PROCESSING ENABLED
→ SYSTEM READY), sin retrasos artificiales.

### Privacidad
Muestra "LOCAL PROCESSING / NO VIDEO UPLOAD". No guarda ni transmite video,
fotos, rostros ni landmarks históricos.

### Performance (objetivos)
Camera 30 FPS, Vision 10-15 FPS, HUD 30-60 FPS. MediaPipe no corre en cada
frame; loops separados (ver arquitectura).

### Debug (overlay opcional)
`CAMERA`, `VISION`, `RENDER` (FPS), `INFERENCE` (ms), `FACES`.

### Raspberry Pi
Preparada para Pi 5 / Linux / Chromium / webcam USB; ejecución futura
`chromium --kiosk https://localhost:8443` (o el puerto HTTPS que se defina).
Modo por defecto en Pi: BALANCED.

## Hitos

**Hito 1 — Núcleo visible (MVP):** config, events, worldstate, camera (+selector),
vision (solo FaceDetector), tracker (IDs, primary, created/lost), scene, hud
(esquinas/target-lock/label, lerp, completo para primary y mínimo para el resto),
ui (boot, panel con TARGET/STATUS/CONFIDENCE/VISIBLE, event log, selector de
cámara, badge de privacidad, fullscreen), app (loops). Campos de análisis en
UNKNOWN. Se desarrolla/prueba en la MacBook vía localhost.

**Hito 2 — Análisis:** FaceLandmarker + analysis.js (head pose, eye contact,
motion), render de landmarks selectos, panel completo, evento `subject.eyeContact`,
yaw/pitch/roll en debug.

**Hito 3 — Rendimiento + deploy:** modos HIGH/BALANCED/LOW + conmutación, overlay
de debug, vendoring/offline completo + `install-deps.sh`, listener HTTPS
auto-firmado + generación con openssl + ruta `/akbal-vision` en el admin,
optimización Pi/Chromium kiosk.

## Pruebas

TDD con `node --test` en la lógica pura:
- **tracker**: asignación/re-match de IDs entre frames, TTL→lost, selección de
  primary, contador de IDs.
- **events**: emit/on/off, múltiples listeners, off remueve.
- **worldstate**: accesores, snapshots inmutables.
- **config**: defaults, modos, load/save en localStorage (guardado con try-catch;
  mock de storage en test).
- **analysis** (Hito 2): umbrales de pose/motion/eye-contact con fixtures.

Manual en Chrome: cámara, carga de MediaPipe, render Three, suavidad del
seguimiento, boot, fullscreen, prueba offline (DevTools offline).

## Manejo de errores

- **Cámara:** permiso denegado / sin dispositivo / dispositivo perdido → estado
  de error claro en el HUD + evento `camera.error` + reintento; `enumerateDevices`
  vacío → mensaje.
- **MediaPipe:** fallo al cargar WASM/modelo → boot muestra "VISION …… FAIL"; la
  app degrada (sigue el video, sin detección).
- **WebGL no disponible** → mensaje de error.
- **Presupuesto:** si una inferencia se pasa de tiempo, el vision loop se
  auto-pacea (salta, nunca encola) para no bloquear el render.
- **Resize/orientación:** se recalculan scene y transformadas del HUD.

## Criterios de aceptación (v0.2 completa, sobre los 3 hitos)

Abre en Chrome en MacBook; pide permiso de cámara; usa la cámara integrada;
detecta uno o varios rostros; asigna IDs temporales; mantiene tracking estable;
Three.js dibuja el HUD; el HUD sigue suavemente; detecta landmarks básicos;
estima orientación; detecta eye contact aproximado; detecta movimiento;
selecciona Primary Target; muestra Event Log; permite cambiar cámara; tiene
fullscreen; tiene modo debug; funciona sin backend; puede funcionar offline;
queda preparada para Raspberry Pi y futura IA local.

## Arquitectura futura (no se implementa ahora)

El Event Bus queda como costura para integrar, sin rehacer cámara/visión/
tracking: Camera/WiFi/GPS/ADS-B/RF/System → Event Bus → Context Engine → Akbal
Agent → Ollama/LLM local → HUD/Voice/Actions.

**No incluir ahora:** Ollama/LLM/Qwen/Whisper/TTS/OpenClaw, reconocimiento
facial, embeddings, identificación de personas, WiFi/GPS/ADS-B/SDR/HackRF,
backend, cloud APIs.
