# AIRCRAFT RADAR — ADS-B con HackRF One

`http://<ip-del-dispositivo>:8090/aircraft-radar` — lista de aeronaves
detectadas ordenada por distancia + radar circular (Akbal al centro,
anillos de 10/25/50/100km), alimentado en tiempo real por un HackRF One en
1090MHz. Además hay una pantalla física simplificada en el menú rápido del
LCD ("Aviones"). Solo recepción: el HackRF nunca transmite (`hackrf_transfer
-r`, jamás `-t`), y este módulo no interactúa con ningún transpondedor.

## Arquitectura

```
HackRF One (USB, RX-only)
  → hackrf_transfer -r - -f 1090000000 -s 2000000  (IQ crudo u8 a stdout)
  → dump1090 --ifile - --net --net-sbs-port 30003   (decodifica Mode-S/ADS-B)
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

### Por qué `hackrf_transfer | dump1090` y no un decodificador propio

`dump1090` (y sus forks) no soportan HackRF nativamente — están escritos
contra `librtlsdr`. El truco estándar de la comunidad HackRF+ADS-B:
`hackrf_transfer` escribe IQ crudo sin firma/cabecera a stdout, exactamente
el mismo formato de bytes (u8 entrelazado I/Q) que `dump1090 --ifile`
espera leer de un archivo — así que un pipe de shell conecta ambos sin que
`dump1090` necesite saber que el HackRF existe.

**La tasa de muestreo debe ser exactamente 2,000,000 Hz, no 2.4MSPS.**
`dump1090.h` define `MODES_DEFAULT_RATE 2000000` y todo su demodulador
Mode-S asume 2 muestras/µs (encoding PPM de 1Mbit/s) — alimentarlo a otra
tasa desincroniza el timing de bits silenciosamente y decodifica basura, no
un error visible. `app/src/services/adsb/hackrf-receiver.ts` fija esto con
un comentario explícito para que nadie lo "optimice" de vuelta a 2.4MSPS.

Igual que en WIFIRADAR: un solo `bash -c "hackrf_transfer ... | dump1090 ..."`
(no dos `spawn` de Node conectados con `.pipe()`), `detached: true` para
poder matar el grupo de procesos completo en `stop()`.

### Por qué el feed SBS-1 (puerto 30003) y no Beast binario

`dump1090 --net-sbs-port` expone el feed BaseStation en texto plano CSV
(`MSG,3,...`) sobre TCP — parseable línea por línea sin una capa de framing
binario adicional, mismo espíritu que parsear la salida `-T fields` de
`tshark` en WIFIRADAR. `app/src/services/adsb/sbs-parser.ts` interpreta los
22 campos según el `TransmissionType` (1=callsign, 2/3=posición,
4=velocidad, 5/6=altitud+squawk).

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

`dump1090` no tiene paquete en Debian trixie (Raspberry Pi OS actual) —
se compila desde fuente. `hackrf` sí está en apt.

```bash
sudo apt-get update
sudo apt-get install -y hackrf librtlsdr-dev
git clone https://github.com/MalcolmRobb/dump1090.git ~/dump1090-src
cd ~/dump1090-src
# GCC moderno (10+) rompe este código de 2016 con "multiple definition of
# `Modes`" por el cambio de default a -fno-common — EXTRACFLAGS=-fcommon
# restaura el comportamiento viejo que este Makefile asume.
make EXTRACFLAGS=-fcommon
sudo cp dump1090 /usr/local/bin/dump1090
```

- **`hackrf`** (paquete apt) — trae `hackrf_info`/`hackrf_transfer`. El
  usuario que corre `chatbot.service` necesita estar en el grupo `plugdev`
  (udev rule del paquete usa `MODE="0666"`/`GROUP="plugdev"`); si
  `hackrf_info` da permission denied justo después de instalar, desconectar
  y reconectar el HackRF alcanza (no hace falta reiniciar).
- **`librtlsdr-dev`** — dump1090 se linkea contra `librtlsdr` en su
  Makefile aunque nunca se usa un dongle RTL-SDR en este flujo (solo hace
  falta para compilar).
- Mismo sudo sin contraseña completo del usuario `akbal` que ya cubre
  WIFIRADAR/wardrive — no hace falta una regla de sudoers adicional para
  `hackrf_transfer`/`dump1090` (corren sin sudo).

## Cómo verificar que el HackRF está conectado

```bash
lsusb | grep -i "1d50:6089"   # Great Scott Gadgets HackRF One
hackrf_info                   # debe imprimir "Found HackRF" + serial
```

Sin el HackRF (o si `hackrf_info`/`dump1090` no están instalados), Aircraft
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

`app/web/admin/aircraft-radar.html` + `.js` + `.css` — canvas 2D plano
(sin Three.js: un radar visto desde arriba no necesita 3D, a diferencia
del globo de WIFIRADAR), mismo topbar/nav/tema que el resto del panel
(`styles.css`). Lista lateral ordenada por distancia + detalle al hacer
click (reutiliza las clases `.apm-*` del modal de WIFIRADAR/Audit WiFi).
