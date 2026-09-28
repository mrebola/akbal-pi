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
4. `■ DETENER` — restaura la radio y deja la sesión en la lista.

## Decisiones de diseño

- **Un módulo aparte** (`wardrive/`), no un modo más de `wifi-audit/`: el
  flujo de laboratorio (allowlist, ataques dirigidos largos) es
  incompatible con capturar mientras se avanza; los estados y la DB son
  distintos. Comparten el hardware vía exclusión mutua (el wardrive
  detiene el radar; wifi-audit y wardrive nunca corren a la vez — sus
  botones son mutuamente excluyentes en la práctica porque ambos exigen
  la única radio USB).
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

## Archivos

| Archivo | Rol |
|---|---|
| `app/src/wardrive/service.ts` | Orquestador: sesión, hop, ataques, GPS, exportes |
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
pantalla de wardrive en la LCD: tarjeta "Iniciar captura" si no hay sesión
(mantener ~0.9s inicia), overlay vivo con contadores si hay sesión
(mantener ~0.9s detiene). Doble clic sale de la pantalla — y si la sesión
estaba corriendo, también la detiene.

**Iniciar/detener desde la web o desde la Pi es indistinto**: ambos llaman
al mismo servicio (`wardrive/service.ts`), y un espejo LCD
(`startWardriveDisplayMirror` en `chat-flow/wardrive-mode.ts`) pinta el
overlay cuando la sesión se arrancó desde la web. La sesión activa aparece
en la pantalla aunque nadie la esté mirando desde el navegador.

El overlay del LCD se comparte con Wifi Audit (`render_wardrive_screen` en
`chatbot-ui.py`): Node manda `wardrive_label` ("WARDRIVE <IFACE>" o
"AUDIT WIFI <IFACE>") y la banda inferior cambia el contador — "N handshakes ·
M redes" para wardrive, "N/M handshakes" para audit.
