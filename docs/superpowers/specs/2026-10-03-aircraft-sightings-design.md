# Avistamientos de aeronaves en la zona GPS, con historial de 24 h — Aircraft Radar

Fecha: 2026-10-03
Estado: Terminado y desplegado: zona de 24 h, lista mezclada con aviones en vivo, tarjetas con capturas y distancia por captura.

## Objetivo

Que en `http://<host-de-la-pi>:8090/aircraft-radar` se vean los
últimos aviones capturados en las últimas 24 horas, de los aviones que Akbal
detectó dentro de una misma zona alrededor de su posición GPS. Pasan pocos
aviones, así que cada captura se guarda con fecha y hora, y la lista se puede
consultar después desde la misma pantalla.

## Estado actual (referencia)

- `app/src/services/adsb/history.ts` ya guarda filas en `aircraft_seen`
  (timestamp, icao, callsign, registro, lat, lon, altitud, velocidad,
  rumbo). Se escribe desde `aircraft-tracker.ts:131`, como máximo una vez
  cada ~10 s por avión que tiene posición (`docs/aircraft-radar.md`).
- `GET /api/aircraft/history` acepta `minutes` e `icao`, pero no hay
  ningún borrado: la tabla crece sin límite.
- La vista MAPA ya dibuja el rastro de cada avión con
  `GET /api/aircraft/history?icao=`.
- La posición de referencia es el fix GPS real, o `ADSB_HOME_LAT/LON` si no
  hay GPS (`service.ts:homePosition()`).

## Definido

**Zona** = área alrededor de la posición GPS de Akbal. Un avión está "en la
zona" cuando su posición está dentro de un radio desde Akbal.

**Se guarda la zona al momento de capturar.** Akbal puede moverse (el GPS
cambia), así que cada fila guarda si estaba en la zona cuando se grabó. La
lista de 24 h no se recalcula contra la posición actual: si Akbal se mueve,
los aviones capturados en la zona anterior siguen en la lista como estaban.

**Radio de 10 km**, configurable con `ADSB_SIGHTING_RADIUS_KM`.

**Origen de la posición de Akbal:** el fix GPS real si lo hay. Si no, `ADSB_HOME_LAT/LON`
como respaldo. Si no hay ninguno, no hay zona.

## Por definir

Nada. Todas las preguntas están respondidas.

## Decisiones

| Tema | Decisión |
|---|---|
| Qué se guarda | Reutilizar `aircraft_seen`; no hay tabla nueva |
| Cuándo una captura es "en la zona" | Posición dentro del radio desde el fix GPS al momento de capturar |
| Lista "aviones en la zona" | Aviones distintos con capturas en la zona de las últimas 24 h, del más reciente al más antiguo |
| Hora de la captura | Mostrada como "visto a las HH:MM" (hora local de la Pi) |
| Histórico por avión | Sus capturas en la zona de las últimas 24 h, con fecha y hora |
| Retención | Se borran las filas con `timestamp` anterior a 24 h. Corre al arrancar y cada hora |
| Lookup de registro y ruta | No se borra; es caché de otra tabla (`aircraft_lookup_cache`, `route_lookup_cache`) |

## Comportamiento

**Lista de aviones en la zona (24 h).** Muestra cada avión que tuvo al
menos una captura en la zona durante las últimas 24 h. Para cada uno:
icao, callsign, registro, hora de su última captura en la zona, y altitud y
velocidad de esa captura. Ordenados por la hora de la última captura, del
más reciente al más antiguo.

**Hora de la captura.** Cada avión muestra "visto a las HH:MM", que es la
hora de su última captura en la zona.

**Histórico por avión.** Al seleccionar un avión de la lista, se muestran sus
capturas en la zona de las últimas 24 h, con fecha y hora, altitud,
velocidad y distancia a Akbal. Ordenadas del más reciente al más antiguo.

**Retención de 24 h.** Las filas con `timestamp < ahora - 24 h` se borran.
El borrado corre al arrancar el servicio y después cada hora. Así el
historial nunca pasa de 24 h, aunque la Pi haya estado apagada.

**Sin posición de Akbal.** Si no hay fix GPS y tampoco `ADSB_HOME_LAT/LON`,
no hay zona. La lista no se llena y la pantalla lo dice.

**Reloj de la Pi.** Las horas dependen del reloj del sistema. Si la Pi no
tiene hora sincronizada (NTP o RTC), las horas quedan mal y el borrado de 24 h
puede borrar datos de más o de menos. La pantalla muestra una advertencia si
el reloj no está sincronizado.

## Modelo de datos

`aircraft_seen` ya tiene índices por `icao` y por `timestamp`, que cubren las
consultas nuevas. Se agrega una columna:

- `near INTEGER NOT NULL DEFAULT 0`: 1 si la captura estaba dentro del radio
  de la zona al grabarse.

Migración aditiva, igual que `history.ts` (`ALTER TABLE` si la columna no
existe). Las filas anteriores a la migración quedan con `near = 0` y no entran
en la lista de zona, porque no hay posición de Akbal registrada para ellas.
Salen de la vista cuando cumplen 24 h y la retención las borra entonces; el
borrado no cambia por la migración.

## API

| Método | Ruta | Cambio |
|---|---|---|
| `GET` | `/api/aircraft/zone` | Nuevo. Aviones distintos con capturas en la zona de las últimas 24 h, con su última captura |
| `GET` | `/api/aircraft/sightings?icao=` | Nuevo. Capturas en la zona del avión en las últimas 24 h, con fecha y hora |
| `GET` | `/api/aircraft/history` | Sin cambio en `minutes` e `icao` |

La ventana de 24 h está fija en el servidor. El cliente no puede pedir más.

## UI (`/aircraft-radar`)

- Sección "Aviones en la zona (24 h)": la lista descrita arriba, con
  "visto a las HH:MM" en cada fila.
- Al seleccionar un avión: tabla con sus capturas en la zona de 24 h.
- Si no hay zona (sin GPS ni posición de referencia), mensaje en vez de lista.
- Aviso de reloj no sincronizado cuando corresponda.
- Textos en español, con las claves de i18n que ya usa la página.

## Manejo de errores

| Caso | Comportamiento |
|---|---|
| Sin posición del avión | No se marca "en la zona" y no se guarda captura en la zona |
| Sin GPS ni `ADSB_HOME_LAT/LON` | No hay zona. La lista no se llena y la UI lo dice |
| Avión que cruza el borde de la zona | Puede aparecer y desaparecer según la captura. Se documenta; no se corrige en esta versión |
| Borrado de 24 h falla | Se registra en consola; se reintenta en la siguiente hora |
| Reloj no sincronizado | Advertencia en la UI; los datos se guardan igual |

## Pruebas

El repo no tiene tests automatizados del módulo ADS-B. La validación es:

1. `npx tsc --noEmit` en `app/`.
2. Pruebas unitarias con `node:test` (misma convención que `chat-history`),
   sobre una base SQLite temporal:
   - el borrado de filas con más de 24 h
   - el filtro "en la zona" con `near`
   - la lista agrupada por avión, con la última captura de cada uno
   - las filas anteriores a la migración no entran en la lista de zona
3. En la Pi, con el receptor real: verificar que un avión en la zona aparece
   en la lista con su hora de captura; que el histórico muestra fecha y hora;
   y que una captura con más de 24 h desaparece después del siguiente
   borrado.

## Riesgos

- **Crecimiento actual sin límite.** Hoy `aircraft_seen` no se poda. La
  primera ejecución del borrado puede tardar si ya hay muchas filas; hay
  que medirlo en la Pi.
- **Radio de 10 km.** Es una decisión, no un dato medido. Si la lista queda
  vacía o llena de aviones lejanos, se ajusta con `ADSB_SIGHTING_RADIUS_KM`.
- **Posición GPS con ruido.** Un avión cerca del borde puede alternar entre
  "en la zona" y "fuera" entre capturas. Por ahora no hay histéresis.
- **Pérdida de datos por reinicio.** Las capturas de las últimas 24 h sobreviven
  a un reinicio porque están en SQLite (WAL). El borrado no corre más de una
  vez por hora.
