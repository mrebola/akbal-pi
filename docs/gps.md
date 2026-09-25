# GPS — posición del dispositivo en un mapa mundial

Página fullscreen `http://<ip-del-dispositivo>:8090/gps` (link **GPS** en la
nav, al lado de Audit WiFi): un mapa mundial visual (Leaflet + tiles CARTO)
centrado en la posición actual del dongle GPS conectado a la Raspberry Pi,
con marcador pulsante, círculo de precisión y un panel de satélites en vivo.
Documenta la implementación vigente (`app/src/utils/gps.ts`,
`app/web/admin/gps.*`).

## Hardware

Un receptor GNSS USB (u-blox y clones) que emite NMEA por puerto serial:

- `ttyACM*` (CDC-ACM, la mayoría de los u-blox) — detectado primero.
- `ttyUSB*` (puentes USB-serial CP210x/PL2303).

Detección genérica: se lista `/dev` y se toma el primer serial USB
disponible (`findGpsDevice`); no hace falta configurar nada. Al enchufar el
dongle la página lo encuentra sola en el próximo poll.

Requisito opcional: `gpsd` (`sudo apt-get install gpsd gpspipe`). Con gpsd
corriendo se usa `gpspipe -r`; sin él se lee el device serial directo con
`cat` — una sola ruta de código para ambos setups.

## Qué muestra

### Mapa

- Vista mundial hasta que llega el primer fix; ahí se centra y hace zoom
  (zoom 15) en la posición.
- Marcador verde pulsante + círculo de precisión estimada (radio ~1.5×HDOP,
  acotado 5–100 m).
- `worldCopyJump` para que hacer pan por el antimeridiano siga viendo el
  marcador.

### HUD de posición (arriba a la izquierda)

Latitud/longitud, altitud, velocidad (km/h), rumbo, HDOP, hora del fix (UTC)
y el device (`/dev/ttyACM0`…). Sin fix muestra el mensaje de estado con la
cuenta de satélites.

### Panel de satélites (abajo a la izquierda)

- Contador **en fix**: `N/4` — los satélites usados en la solución contra el
  mínimo para un fix 3D (`MIN_SATS_FOR_FIX = 4`: lat/lon/alt/hora).
- Contador **visibles**: `M/total` — satélites con SNR/elevación reportados
  contra todos los PRNs que el receiver está rastreando (GSV+GSA).
- Sky plot circular: anillo exterior = horizonte, centro = cenit; cada punto
  es un satélite coloreado por SNR (rojo→verde) con contorno verde si
  participa en el fix; title con PRN/elevación/azimut/SNR.

### Sin suficientes satélites

El HUD dice explícitamente cuántos faltan, ej:

> Fix inválido: se necesitan 4 satélites y hay 2 en la solución (7 visibles).
> Sal a cielo despejado.

El backend marca el fix como stale si no hay GGA nuevo en 30s
(`FIX_STALE_MS`) — el mapa vuelve a la vista mundial en vez de mostrar una
posición vieja.

## Arquitectura

```
dongle USB (/dev/ttyACM0|ttyUSB0)
  └─ gpsd (opcional) ── gpspipe -r ─┐
      └─ (sin gpsd) cat /dev/ttyACM0 ┴─ GpsNmeaReader (app/src/utils/gps.ts)
            ├─ GGA → lat/lon/alt/hora/quality/sats usados/HDOP
            ├─ RMC → velocidad/rumbo
            ├─ GSV → satélites en vista (PRN/el/az/SNR por constelación)
            └─ GSA → PRNs en la solución (used)
         → getGpsStatus() → /api/gps/status (poll 2s desde gps.js)
                           → /api/gps/summary (resumen para headers)
```

- El reader es **long-lived**: se spawnéa al primer pedido de status, reinicia
  solo si muere o si el dongle cambia de device (unplug/replug), y se detiene
  cuando ya no hay ninguno conectado.
- Checksum XOR de cada sentencia NMEA validado antes de parsear; líneas
  corruptas se descartan.
- Los contadores del fix salen de GGA (campo `numsat`); los "visibles" de la
  unión GSV (elevación/SNR) y GSA (participa en fix).

## API

```
GET /gps                  # la página del mapa (sesión del admin)
GET /api/gps/status       # GpsStatus completo: posición + satélites[]
GET /api/gps/summary      # {present, hasFix, satellitesUsed, satellitesInView, satellitesNeeded}
```

`GpsStatus` (utils/gps.ts):

| Campo | Qué es |
|---|---|
| `present` / `device` | hay dongle y cuál |
| `hasFix` | solución válida (GGA quality > 0, no stale) |
| `latitude` / `longitude` / `altitudeM` | posición (null sin fix) |
| `speedKmh` / `headingDeg` | de RMC |
| `hdop` | dilución de precisión horizontal (<2 bueno) |
| `satellitesUsed` / `satellitesInView` / `satellitesNeeded` | N en fix / M visibles / mínimo 4 |
| `satellites[]` | `{prn, elevation, azimuth, snr, used}` |
| `error` | estado humano cuando no hay fix |

## Cómo usarlo

1. Enchufar el dongle GPS a un puerto USB de la Pi.
2. Entrar a la web admin y abrir **GPS** en la nav (o ir a `/gps` directo).
3. Esperar el fix: el mensaje del HUD avisa cuántos satélites hay y cuántos
   faltan; con 4+ el mapa centra y muestra el marcador.
4. El punto se actualiza solo cada 2 segundos mientras la página está abierta.

## Notas

- El fix inicial puede tardar 1–5 minutos si el dongle está frío (cold start)
  o si hay techo/interiores — el mensaje de satélites es la guía.
- La página es solo observación; no guarda historial de rutas ni logs de
  posición.
- No requiere internet en la Pi: Leaflet y CSS están vendoreados
  (`web/admin/vendor/leaflet/`); solo los tiles del mapa vienen de CARTO
  (si la Pi no tiene salida a internet el mapa queda vacío pero el HUD de
  posición y satélites funciona igual).