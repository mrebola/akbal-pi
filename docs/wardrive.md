# Wardrive (conducción) — `/wardrive`

> Módulo de captura para el vehículo: `app/src/wardrive/` + página
> fullscreen `app/web/admin/wardrive.html` (ruta `/wardrive`). Distinto del
> "Wifi Audit" de laboratorio (`wifi-audit/`, docs/wifi-audit.md): aquí se
> registra TODO lo que se ve y dónde se vio, con deauth oportunista opcional.

## Qué hace

1. **Descubrimiento pasivo continuo** — un solo pipeline `dumpcap | tshark`
   sobre el AR9271 en modo monitor (mismo patrón de `wifiradar/capture.ts`),
   con BPF que admite beacons, probe-resp, deauth y frames EAPOL.
2. **Registro por SSID** — cada SSID nuevo va a
   `data/wardrive-drive.db` (SQLite: `networks_seen`, `handshakes`,
   `drive_sessions`, `track_points`). El BSSID es la clave en el aire; el
   SSID es la clave del historial.
3. **Handshakes** — cuando tshark ve un frame EAPOL de un AP cuyo SSID aún
   no tiene handshake, `hcxpcapngtool` corre sobre los pcaps ringbuffer de
   la sesión; si hay pares EAPOL/PMKID reales, el .cap/.hc22000 se guarda
   en `~/wardrive-sessions/drive-<fecha>/` y el SSID se marca en la DB.
   Las redes sin handshake se distinguen en el mapa/lista (✋ capturado /
   ✓ cubierto por otro AP / ✕ agotado / nada = sin handshake).
4. **Deauth oportunista (OFF por defecto)** — toggle rojo en la UI. Solo
   dispara si: velocidad GPS ≤ 25 km/h, RSSI ≥ −72 dBm, seguridad
   WPA/WPA2/3 conocida, SSID sin handshake, ≤ 3 intentos por AP y cooldown
   de 45 s. Burst corto (aireplay --deauth 16 -D), dirigido al cliente si
   hay clientes en el aire.
5. **GPS por sesión** — puntos del track cada ≥ 6 m (o 20 s quieto) en
   `track_points`; distancia Haversine acumulada.
6. **Mapa** — Leaflet con tiles OSM (mismo motor de `/gps`), línea del
   recorrido en vivo, puntos verdes = handshakes de todas las sesiones,
   pestañas de redes en vivo y sesiones pasadas con CSV (formato WiGLE) y
   GPX descargables.

## Flujo de uso

1. Entrar a `http://akbal-pi...:8090/wardrive` (o la card "Wardrive" en
   el tab Wifi Audit del index).
2. Botón `▶ INICIAR` — toma la radio (detiene el WiFi Radar), entra en
   modo monitor, abre sesión y arranca el hop 2.4 GHz.
3. Manejar. El HUD muestra tiempo/distancia/redes/handshakes; el toggle
   DEAUTH se enciende solo a baja velocidad.
4. `■ DETENER` — restaura la radio y deja la sesión en la lista. En la Pi,
   detener pide confirmación (ver [Pantalla física](#pantalla-física-de-la-pi)).

## Radios (1, 2 o 3 dongles)

El modo se elige con el selector **Radios** de la página (o con
`WARDRIVE_RADIO_MODE` en `.env` como default al arrancar):

- **auto** (default): usa todos los dongles con modo monitor conectados.
- **single**: 1 dongle compartido. Es ciego durante cada ronda de ataque.
- **dual**: 2 dongles. Uno ataca y el otro descubre.
- **triple**: 3 dongles si hay 3; si hay menos, usa los que haya y lo indica.

Con dos o más radios, una es la **radio de ataque** (`ath9k_htc` primero, por
sus capturas EAPOL/PMKID deterministas) y el resto son **de descubrimiento**.

- **Las tres radios descubren.** La radio de ataque también escucha y salta de
  canal mientras no está en una ronda. Los 13 canales 2.4 GHz se reparten en
  tramos, uno por radio, así que el ciclo completo de la banda es más corto
  con cada radio que se suma.
- **Una ronda de ataque** solo pausa la captura de su propia radio. Las demás
  siguen saltando de canal, y al terminar la ronda la radio de ataque vuelve a
  escuchar.
- **Etiqueta de radios**: la página muestra las radios que están activas de
  verdad, por ejemplo `WLAN1+WLAN3+WLAN2 · 3 radios`, con su rol
  (descubrimiento o ataque).
- Si se desconecta una radio, la sesión sigue con las demás y solo se detiene
  cuando no queda ninguna de descubrimiento.
- El selector guarda el modo en memoria: al reiniciar el servicio vuelve al
  default de `.env`.

## Decisiones de diseño

- **Un módulo aparte** (`wardrive/`), no un modo más de `wifi-audit/`: el
  flujo de laboratorio (allowlist, ataques dirigidos largos) es
  incompatible con capturar mientras se avanza; los estados y la DB son
  distintos. Comparten el hardware por exclusión mutua: el WiFi Radar solo
  corre mientras se usa (pantalla o página abiertas) y nunca mientras corre
  wardrive; wifi-audit y wardrive no corren a la vez porque ambos exigen las
  radios USB.
- **Dedup por SSID** (elección del owner): si el handshake salió de otro
  AP con el mismo nombre, los demás APs se marcan "✓ cubierto" y no se
  re-atacan en recorridos nuevos. `networks_seen.handshake = 1` es la
  fuente de verdad (sobrevive reinicios).
- **Deauth oportunista total** (elección del owner) pero con frenos:
  apagable, limitado a lento/detenido, RSSI alto, 3 intentos/AP. Captura
  pasiva de EAPOL siempre activa — no envía nada al aire.
- **Ringbuffer dumpcap** (10 × 5 MB ≈ 50 MB) por sesión: los .cap
  per-target se extraen con hcxpcapngtool del ring sin escribir traffic
  crudo ilimitado al SD. La extracción corre solo cuando hay EAPOL real.
- **Polling 1 Hz** (no WebSocket): el status ya viene agregado
  (40 APs máximo, track por puntos), suficiente para mapa fluido y mucho
  más barato que un stream por-frame.
- **DEMO**: con el toggle LIVE/DEMO del header, el wardrive genera APs y
  track sintéticos (loop alrededor del Zócalo) sin tocar hardware —
  igual que GPS/radar/aviones.

## Compartir sesiones (`.akbal`)

La pestaña **Compartir** de la página exporta una sesión a un paquete
`.akbal` (un ZIP con `manifest.json` y el sha256 de cada archivo) y permite
cargar paquetes de otras sesiones.

- **Exportar**: `GET /api/wardrive/drive/sessions/:id/export.akbal`. Por
  defecto incluye credenciales y handshakes; `?credentials=0` los deja fuera.
- **Importar**: `POST /api/wardrive/drive/sessions/import`. Rechaza cualquier
  paquete cuyo contenido no coincida con el manifiesto, y limita el tamaño
  descomprimido a 1 GB.
- **Listar y borrar sesiones compartidas**: `GET /api/wardrive/drive/shared`
  y `POST /api/wardrive/drive/shared/delete`.

Código: `app/src/akbal/` (formato, paquete, archivos de sesión y almacén) y
`app/src/device/akbal-routes.ts`.

## Archivos

| Archivo | Rol |
|---|---|
| `app/src/wardrive/service.ts` | Orquestador: sesión, hop, ataques, GPS, exportes |
| `app/src/wardrive/radio-plan.ts` | Modos de radios (auto, single, dual, triple) y roles |
| `app/src/akbal/` | Paquetes `.akbal` para compartir sesiones |
| `app/src/wardrive/capture.ts` | dumpcap(+ring) \| tshark → DriveFrame (beacon/deauth/eapol) |
| `app/src/wardrive/attack.ts` | extractEapolToSession (hcxpcapngtool) + DeauthOpRunner |
| `app/src/wardrive/drive-db.ts` | SQLite: networks_seen / handshakes / drive_sessions / track_points |
| `app/src/wardrive/types.ts` | DriveStatus, DriveApView, etc. |
| `app/web/admin/wardrive.{html,css,js}` | Página fullscreen del mapa |
| `app/data/wardrive-drive.db` | DB runtime (git-ignored) |

## API

- `GET /api/wardrive/drive/status` — todo el estado para la página (poll 1 s).
- `POST /api/wardrive/drive/start` / `.../stop` — sesión on/off.
- `POST /api/wardrive/drive/deauth` `{on}` — toggle oportunista.
- `GET` / `POST /api/wardrive/drive/radio-mode` — modo de radios (`auto`,
  `single`, `dual` o `triple`). Solo se cambia con la sesión detenida.
- `POST /api/wardrive/drive/sessions/delete` — borra una sesión.
- `GET /api/wardrive/drive/sessions/:id/export.akbal` — exporta un paquete.
- `POST /api/wardrive/drive/sessions/import` — importa un paquete.
- `GET /api/wardrive/drive/shared` y `POST /api/wardrive/drive/shared/delete`.
- `GET /api/wardrive/drive/sessions` — lista de sesiones (contadores).
- `GET /api/wardrive/drive/track?id=drive-…` — polyline.
- `GET /api/wardrive/drive/session-networks?id=drive-…` — redes de la sesión.
- `GET /api/wardrive/drive/export/csv?id=…` / `export/gpx?id=…` — exportes.
- `GET /api/wardrive/drive/files?id=…` y `/files/download?path=…` — artefactos.

## Limitaciones

- Solo 2.4 GHz (misma phy ath9k_htc del radar; 5 GHz queda fuera por DFS).
- SSIDs ocultos no se registran (no hay SSID que mapear ni dedupear).
- WPA3-SAE puro: los handshakes no existen; el PMKID pasivo sí se captura
  cuando un cliente se conecta (mismo pipeline EAPOL).
- La extracción por objetivo depende del ringbuffer: si el burst fue
  hace > ~50 MB de tráfico, el pcap ya rotó (se reintenta en la próxima
  pasada del mismo AP dentro de la ventana/cooldown).
- La posición guardada de cada red es la del GPS al momento de verla por
  primera/última vez (ancla de sesión); el CSV WiGLE lleva esa posición.
## Pantalla física de la Pi

La opción **Wardrive** del menú rápido (click corto en reposo) abre la
pantalla de wardrive en la LCD:

- Sin sesión: tarjeta "Iniciar captura". **Mantener 0,9 s** inicia.
- Con sesión: overlay vivo con contadores. Para detener:
  - **Mantener 0,9 s** o **doble clic** abren la tarjeta "¿Detener captura?".
  - En esa tarjeta, **mantener 0,9 s** confirma y detiene; **doble clic**
    vuelve al overlay; un **clic corto no hace nada**.
- Doble clic sin sesión activa sale de la pantalla.

**Iniciar/detener desde la web o desde la Pi es indistinto**: ambos llaman
al mismo servicio (`wardrive/service.ts`), y un espejo LCD
(`startWardriveDisplayMirror` en `chat-flow/wardrive-mode.ts`) pinta el
overlay cuando la sesión se arrancó desde la web. La sesión activa aparece
en la pantalla aunque nadie la esté mirando desde el navegador.

El overlay del LCD se comparte con Wifi Audit (`render_wardrive_screen` en
`chatbot-ui.py`): Node manda `wardrive_label` ("WARDRIVE <IFACE>" o
"WIFI AUDIT <IFACE>") y la banda inferior cambia el contador — "N handshakes ·
M redes" para wardrive, "N/M handshakes" para audit.
