# AIRCRAFT RADAR — ADS-B con HackRF One

`http://<ip-del-dispositivo>:8090/aircraft-radar` — lista de aeronaves
detectadas ordenada por distancia + mapa/radar (ver "Frontend" abajo),
alimentado en tiempo real por un HackRF One en 1090MHz. Además hay una
pantalla física simplificada en el menú rápido del LCD ("Aviones"). Solo
recepción: el backend de HackRF de `readsb` únicamente recibe (API RX de
`libhackrf`, sin ninguna ruta de transmisión en el binario), y este módulo
no interactúa con ningún transpondedor.

## Arquitectura

```
HackRF One (USB, RX-only)
  → readsb --device-type hackrf --net --net-sbs-port 30003  (nativo, sin
    proceso intermedio — decodifica Mode-S/ADS-B directo desde libhackrf)
  → socket TCP 127.0.0.1:30003 (texto SBS-1/BaseStation)
  → parser (app/src/services/adsb/sbs-parser.ts) → RawAdsbMessage
  → tracker (app/src/services/adsb/aircraft-tracker.ts) — estado en
    memoria, merge por ICAO, distancia/bearing vs GPS de Akbal
  → SQLite (app/src/services/adsb/history.ts) — aircraft_seen +
    caché de resolución ICAO/ruta
  → WebSocket /aircraft-radar/ws + API REST → navegador
  → LCD físico vía radar_ui genérico (chat-flow/aircraft-radar-mode.ts)
  → tools del agente (config/aircraft-radar-tools.ts)
```

Mismo patrón que WIFIRADAR (ver [`wifiradar.md`](./wifiradar.md)): capturar
con una herramienta externa bien probada y parsear su salida, en vez de
reimplementar el decodificador (Mode-S/CRC/CPR es fácil de hacer mal).

### Por qué `readsb` (y no `dump1090`, ni un decodificador propio)

La primera versión de este módulo usaba `hackrf_transfer -r - | dump1090
--ifile -` (el truco estándar de la comunidad HackRF+ADS-B para forks de
`dump1090`, que no soportan HackRF nativamente — están escritos contra
`librtlsdr`). Verificado en hardware real: ese pipeline corría sin errores
pero **nunca decodificó un mensaje ADS-B real** — ver
["Estado de la captura real"](#estado-de-la-captura-real) más abajo para
la investigación completa. Se cambió a
[`readsb`](https://github.com/wiedehopf/readsb) (fork moderno,
activamente mantenido) porque tiene **soporte nativo de HackRF** vía
`libhackrf` (`sdr_hackrf.c`, `--device-type hackrf`) — un solo proceso,
sin `hackrf_transfer` ni un pipe intermedio, sin que Node necesite manejar
el formato de bytes (`readsb` sabe leer directo del HackRF, muestreando a
la tasa que su propio demodulador espera) — y fue lo que realmente
consiguió decodificar aeronaves reales en este hardware.

`app/src/services/adsb/hackrf-receiver.ts` hace `spawn("readsb", [...])`
directo (sin `bash -c`, sin pipe — un solo proceso que ya habla TCP).

### Por qué el feed SBS-1 (puerto 30003) y no Beast binario

`readsb --net --net-sbs-port` expone el mismo feed BaseStation en texto
plano CSV (`MSG,3,...`) que ya exponía `dump1090` — parseable línea por
línea sin una capa de framing binario adicional, mismo espíritu que
parsear la salida `-T fields` de `tshark` en WIFIRADAR.
`app/src/services/adsb/sbs-parser.ts` interpreta los 22 campos según el
`TransmissionType` (1=callsign, 2/3=posición, 4=velocidad,
5/6=altitud+squawk) — sin cambios frente a la versión con `dump1090`,
porque el formato del feed es idéntico entre ambos.

### Demo Mode

Sin HackRF conectado (o si el proceso muere), `AircraftRadarService`
(`app/src/services/adsb/service.ts`) cae automáticamente a
`demo-mode.ts`: aeronaves sintéticas con callsigns de aerolíneas mexicanas
(Volaris/Aeroméxico/Viva Aerobus) moviéndose en línea recta alrededor de
un punto de referencia en Guadalajara, alimentando el **mismo tracker**
que la captura real. Retry cada 15s hacia modo live, igual que WIFIRADAR.
El toggle LIVE/DEMO (`POST /api/aircraft/mode`) también está conectado al
switch global de plataforma (`app/src/utils/platform-mode.ts`).

### GPS y distancia/bearing

Reutiliza `app/src/utils/gps.ts` (el mismo dongle u-blox que ya usa el
resto de Akbal) — no hay un segundo lector de GPS. La posición se consulta
cada 5s (mismo timer que hace `sweep()`), no por cada mensaje ADS-B: un fix
GPS no se mueve lo suficiente entre dos mensajes separados por cientos de
ms como para justificar el I/O extra. Sin fix, `distanceKm`/`bearingDeg`
quedan `null` — nunca un valor inventado.

**Dos motivos distintos para que una aeronave no aparezca en el mapa/radar,
aunque sí esté en la lista** (fácil de confundir): (1) Akbal no tiene fix
GPS — nada se puede ubicar; o (2) Akbal sí tiene fix, pero *esa aeronave en
particular* todavía no tuvo un mensaje de posición (SBS tipo 2/3) que
decodificara — con recepción real tan escasa, es común ver
velocidad/altitud/identidad resueltas (mensajes tipo 4 y de vigilancia) de
una aeronave bastante antes que su posición, o nunca. El frontend
distingue ambos casos explícitamente (`distanceLabel()` en
`aircraft-radar.js`: "sin fix GPS de Akbal" vs. "sin posición aún") — antes
decía "sin GPS" para los dos casos, lo cual hacía ver como un problema de
Akbal algo que en realidad es "todavía no le tocó esa aeronave".

### Resolución de ICAO24 y ruta — sin inventar datos

Mismo orden capa-local-antes-que-remota que `wifiradar/oui.ts` usa para
vendors, vía [adsbdb.com](https://www.adsbdb.com/) (API pública, gratis,
sin API key):

1. **Caché SQLite** (`aircraft_lookup_cache` / `route_lookup_cache` en
   `app/src/services/adsb/history.ts`) — una vez resuelto un ICAO o
   callsign, no se vuelve a consultar por 30 días (registro/modelo) o 24h
   (ruta).
2. **adsbdb.com** (opt-in vía `ADSB_LOOKUP_ONLINE_ENABLED`, default on) —
   `GET /v0/aircraft/{icao}` para registration/manufacturer/model/operator,
   `GET /v0/callsign/{callsign}` para origen/destino/número de vuelo.
   Rate-limited a un request cada 500ms, backoff de 10s ante error/offline.

Si no resuelve: los campos de identidad quedan `null` y la ruta se muestra
como **"Route unknown"** — nunca un origen/destino adivinado. No hay una
base de datos local de matrículas bundleada (a diferencia de las ~50
entradas curadas de OUI en WIFIRADAR): no existe un subconjunto pequeño de
matrículas reales que valga la pena empaquetar, así que un ICAO nunca antes
visto sin internet simplemente queda sin resolver.

### Historial (SQLite)

`app/data/aircraft-radar.db` (mismo directorio `data/` que el resto del
proyecto, gitignored). Tabla `aircraft_seen(timestamp, icao, callsign,
registration, lat, lon, altitude, speed, heading)`, un insert por
aeronave cada ~10s como máximo mientras tiene posición (no por cada
mensaje crudo — un avión real puede mandar una actualización de posición
por segundo). Consultada por `GET /api/aircraft/history` y por la tool del
agente `getAircraftHistory`.

## Pantalla física (LCD)

`chat-flow/aircraft-radar-mode.ts`, accesible desde el menú rápido
("Aviones"). Mismo primitivo genérico `radar_ui` que ya usaba WIFIRADAR en
`python/chatbot-ui.py` — pero como propio campo `aircraft_radar_ui`
(no comparte estado con `radar_ui`, así ambas pantallas no pueden
pisarse) con su propio render (`render_aircraft_radar_screen`, título
"AIRCRAFT RADAR"). A diferencia de WIFIRADAR (ángulo hasheado, sin
significado real), aquí el ángulo de cada punto es el **bearing GPS real**
de la aeronave, y el color reutiliza la misma escala verde/amarillo/rojo
pero para tendencia de acercamiento (`approaching`) en vez de RSSI.
Aeronaves sin fix GPS (o antes de tenerlo) no se pueden ubicar en el disco
y se excluyen del dibujo — el texto inferior lo indica explícitamente.

## Tools del agente

`app/src/config/aircraft-radar-tools.ts`: `getNearbyAircraft`,
`getNearestAircraft`, `getAircraftDetails` (busca por ICAO, callsign,
matrícula u operador — "Volaris", "0D1005", etc.) y `getAircraftHistory`.
Todas devuelven texto listo para que el LLM responda, y ninguna inventa
campos que no se pudieron resolver.

## Dependencias de Linux

Ni `hackrf` (para `hackrf_info`, usado solo para detección) ni `readsb`
con soporte de HackRF tienen paquete listo en Debian trixie (Raspberry Pi
OS actual) para lo segundo — `readsb` se compila desde fuente.

```bash
sudo apt-get update
sudo apt-get install -y hackrf libhackrf-dev libncurses-dev zlib1g-dev \
  libzstd-dev help2man git build-essential pkg-config

git clone --depth 20 https://github.com/wiedehopf/readsb.git ~/readsb-src
cd ~/readsb-src
make HACKRF=yes -j4
sudo cp readsb /usr/local/bin/readsb
```

- **`hackrf`** (paquete apt) — trae `hackrf_info`/`hackrf_transfer` (este
  último ya no se usa para capturar, solo queda `hackrf_info` para
  detección). El usuario que corre `chatbot.service` necesita estar en el
  grupo `plugdev` (udev rule del paquete usa `MODE="0666"`/`GROUP="plugdev"`);
  si `hackrf_info` da permission denied justo después de instalar,
  desconectar y reconectar el HackRF alcanza (no hace falta reiniciar).
- **`libhackrf-dev`** — headers de `libhackrf` que `readsb` necesita para
  compilar su backend nativo de HackRF (`sdr_hackrf.c`, `-DENABLE_HACKRF`).
- Mismo sudo sin contraseña completo del usuario `akbal` que ya cubre
  WIFIRADAR/wardrive — no hace falta una regla de sudoers adicional,
  `readsb` corre sin sudo.

## Cómo verificar que el HackRF está conectado

```bash
lsusb | grep -i "1d50:6089"   # Great Scott Gadgets HackRF One
hackrf_info                   # debe imprimir "Found HackRF" + serial
```

Sin el HackRF (o si `hackrf_info`/`readsb` no están instalados), Aircraft
Radar arranca automáticamente en DEMO MODE — no hace falta hardware para
probar la UI.

## Cómo iniciar

No requiere un paso de arranque separado — corre como parte de
`chatbot.service`:

```bash
sudo systemctl restart chatbot.service
grep -i aircraft-radar ~/whisplay-ai-chatbot/chatbot.log | tail -5
# "[aircraft-radar] Live capture started (HackRF One (...))" → real
# "Real capture unavailable, using DEMO MODE: <razón>" → demo
```

## Estado de la captura real

Verificado en el dispositivo real (Pi 5 + HackRF One, Guadalajara) — la
recepción real **funciona**, aunque sigue siendo marginal. Bitácora de la
investigación, por si hace falta retomarla:

1. **Primer sospechoso, descartado — tasa de muestreo**: `dump1090.h`
   define `MODES_DEFAULT_RATE 2000000` (2 muestras/µs) — confirmado
   correcto, no era esto.
2. **Segundo sospechoso, descartado — signo de bytes**: HackRF entrega IQ
   de 8 bits **con signo** (confirmado en el código fuente oficial de
   `hackrf_transfer.c`, que hace `^= 0x80` para convertir a sin signo solo
   en su modo `--wav`) mientras `dump1090` asume bytes **sin signo**
   (confirmado en su tabla de magnitud). Se probó la conversión (XOR 0x80
   en un pipe intermedio) sin cambio en el resultado — tampoco era esto.
3. **La causa real — el propio `dump1090`**: con `readsb` (ver arriba) sí
   aparecía actividad real consistente con la ganancia (decenas de miles
   de "preambles" Mode-S por sesión de 20s, piso de ruido subiendo con la
   ganancia), pero en ventanas cortas (10-20s) **0 mensajes pasaban CRC**.
   La ganancia exacta que el usuario ya había confirmado funcional en otra
   herramienta (LNA 40, VGA 50, amp on) tampoco cambiaba nada en esas
   ventanas cortas — hasta que una prueba de **2 minutos** con esos mismos
   valores sí decodificó mensajes reales (6 con CRC válido, 1 aeronave
   real). La recepción es rara/débil (8 mensajes usables en 120s en la
   mejor corrida), pero real. `dump1090` (el fork de 2016, nunca probado
   contra un HackRF de verdad) simplemente no lo lograba en el tiempo de
   prueba disponible — no está claro si es una diferencia real de
   sensibilidad del demodulador o solo mala suerte con ventanas cortas,
   pero cambiar a `readsb` fue lo que funcionó.

**Limitante conocida, sin resolver**: `readsb` reporta seguido
`weirdness: hackRF gave us a block with an unusual size` y ocasionalmente
`Lost N packets on USB` — apunta a un problema de timing/throughput por
USB en este HackRF/Pi específico (puerto, cable, o el controlador USB del
Pi 5) que probablemente limita la tasa de recepción real por debajo de lo
que la antena permitiría. Probar otro puerto/cable USB o un hub
alimentado es la siguiente pista a seguir si la recepción sigue
sintiéndose demasiado esporádica.

**Ganancia por defecto** (`ADSB_HACKRF_LNA_GAIN=40`,
`ADSB_HACKRF_VGA_GAIN=50`, `ADSB_HACKRF_AMP_ENABLED=true`) — la primera
combinación confirmada funcional en este hardware; ajustable por `.env`
si una antena distinta o un entorno distinto necesita otra cosa.

## API interna

```
GET  /api/aircraft            snapshot completo (modo, aeronaves)
GET  /api/aircraft/nearest    la más cercana con fix GPS
GET  /api/aircraft/history    ?minutes=N&icao=OPCIONAL — historial SQLite
GET  /api/aircraft/:icao      detalle de una aeronave activa
GET  /api/aircraft/mode       modo actual (live/demo) + lo solicitado
POST /api/aircraft/mode       { mode: "live" | "demo" }
```

## Frontend

`app/web/admin/aircraft-radar.html` + `.js` + `.css`, mismo topbar/nav/tema
que el resto del panel (`styles.css`). Lista lateral ordenada por distancia
+ detalle al hacer click (reutiliza las clases `.apm-*` del modal de
WIFIRADAR/Audit WiFi). Dos vistas detrás de un toggle **MAPA / RADAR** en
el header (mismo patrón que el MAPA/GLOBO 3D de `/gps`):

- **RADAR**: el disco circular original — Akbal al centro, aeronaves
  ubicadas por bearing/distancia relativos, anillos de 10/25/50/100km.
  Canvas 2D plano.
- **MAPA**: un mapa Leaflet real (mismo motor que `/gps`, vendorizado en
  `vendor/leaflet/`) con cada aeronave ubicada por su **lat/lon absoluta**
  de ADS-B — a diferencia del radar circular, no necesita que Akbal tenga
  fix GPS para mostrar aviones (solo el propio marcador de Akbal sí lo
  necesita). Tiles en **modo oscuro**: OSM solo sirve basemaps claros sin
  key (CARTO dark_all empezó a pedir API key — ver el historial de
  `gps.js` con el mismo problema), así que se usa el truco estándar de
  invertir los tiles claros (`filter: invert(1) hue-rotate(180deg) ...`)
  en vez de depender de un proveedor de tiles oscuros que puede romperse.

  Cada aeronave es un `L.divIcon` — un triángulo SVG rotado según su rumbo
  real y coloreado por tendencia de acercamiento (mismo esquema
  verde/amarillo/rojo que el radar/LCD). **No usa Three.js/WebGL**: una
  primera versión dibujaba los aviones con una capa 3D encima del mapa,
  pero WebGL no es algo de lo que depender en una página que debe andar en
  cualquier navegador/dispositivo — en algunos simplemente no pintaba nada,
  sin ningún error visible. Un `<div>` con SVG funciona en todos lados.

  **Movimiento suave**: Leaflet posiciona cada marcador con un
  `transform: translate(...)` — `.ar-map .leaflet-marker-icon` le agrega
  una `transition` sobre ese `transform`, así que `marker.setLatLng()`
  desliza al marcador a la nueva posición en vez de saltar. Combinado con
  que las posiciones reales llegan aproximadamente cada segundo (real o
  demo), el resultado es una aeronave que se ve moverse continuamente en
  vez de brincar una vez por segundo.

### Distancia/rumbo recalculados en el navegador (no solo en el backend)

El backend solo refresca `distanceKm`/`bearingDeg` cada 5s (el timer de
`aircraft-tracker.ts` que también consulta el GPS), pero los snapshots por
WebSocket llegan cada 300ms — usar el valor del backend tal cual hacía que
el radar circular se viera "brincar" una vez cada 5 segundos en vez de
moverse. `aircraft-radar.js` guarda la posición de Akbal (la misma que ya
consulta cada 2s para el marcador propio del mapa) y recalcula
distancia/rumbo de cada aeronave **en el cliente**, con las mismas
fórmulas de haversine/bearing que `services/adsb/geo.ts`, en cada snapshot
— así el radar se mueve tan seguido como llegan snapshots, sin depender
del timer de 5s del backend. La tendencia "acercándose/alejándose"
(`approaching`, para el color de cada punto) también se recalcula así,
comparando contra la última distancia vista por ICAO.

### Trayectoria y auto-encuadre (vista MAPA)

Cada aeronave con posición deja un rastro (`L.polyline`, verde punteado)
en `aircraft-radar.js`: la primera vez que aparece se pide su historial
(`GET /api/aircraft/history?icao=`, la misma tabla SQLite de
`history.ts`) para no empezar con un rastro vacío, y de ahí en adelante
se extiende con cada posición nueva que llega (deduplicando puntos
repetidos). Se borra cuando la aeronave sale del snapshot (fuera de
rango, podada por `aircraft-tracker.ts`).

El mapa también se auto-encuadra: cuando el conjunto de aeronaves *con
posición* cambia (aparece una nueva, o la última desaparece),
`map.fitBounds()` ajusta zoom/centro para que Akbal y todas las
aeronaves detectadas con posición entren en pantalla (con
`maxZoom` para no acercarse de forma absurda si una queda muy cerca).
No se reajusta en cada snapshot — solo cuando cambia el conjunto — para
no pelearse con quien esté paneando/zoomeando manualmente mientras
observa una aeronave moverse.
