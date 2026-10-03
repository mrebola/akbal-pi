# Avistamientos de aeronaves con historial de 24 h — Aircraft Radar

Fecha: 2026-10-03
Estado: borrador, pendiente de revisión (hay un supuesto abierto, ver "Por confirmar")

## Objetivo

Que en `http://akbal-pi.border-bonito.ts.net:8090/aircraft-radar` siempre se
pueda ver qué aviones pasaron cerca de Akbal. Pasan pocos aviones, así que
cada avistamiento se guarda con fecha y hora, y se puede consultar después
desde la misma pantalla.

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

## Por confirmar

**"Misma ubicación"** puede significar tres cosas. Esta especificación asume
la primera; hay que confirmarla:

1. **Avión dentro de un radio de Akbal** (propuesta: 10 km, configurable con
   `ADSB_SIGHTING_RADIUS_KM`). Solo esos avistamientos se marcan como
   "cerca" y muestran hora.
2. Cualquier avión que Akbal reciba con posición (es lo que hoy se guarda).
3. Solo aviones que pasan por encima de Akbal (altitud y rumbo, no solo
   distancia).

La opción 1 es la que mejor encaja con "estamos en la misma ubicación".
La opción 2 es más simple, pero llena la lista de aviones lejanos.

## Decisiones

| Tema | Decisión |
|---|---|
| Qué se guarda | Reutilizar `aircraft_seen`; no hay tabla nueva |
| Cuándo se marca "cerca" | Avión con posición dentro del radio (ver "Por confirmar") |
| Hora de avistamiento | El último `timestamp` de `aircraft_seen` del avión, mostrado en hora local |
| Histórico por avión | Lista de avistamientos del avión con fecha y hora, dentro de las últimas 24 h |
| Retención | Se borran las filas con `timestamp` anterior a 24 h. Corre cada hora y al arrancar |
| Lookup de registro y ruta | No se borra; es caché de otra tabla (`aircraft_lookup_cache`, `route_lookup_cache`) |

## Comportamiento

**Hora de avistamiento.** En la lista de la pantalla, cada avión "cerca"
muestra "visto a las HH:MM" (hora local de la Pi). Si el avión no está
cerca, la lista muestra solo su última posición conocida, sin hora de
avistamiento cercano.

**Histórico por avión.** Al seleccionar un avión, la pantalla muestra sus
avistamientos de las últimas 24 h, con fecha y hora de cada uno, más
altitud y velocidad. Ordenados del más reciente al más antiguo.

**Retención de 24 h.** Las filas con `timestamp < ahora - 24 h` se borran.
El borrado corre al arrancar el servicio y después cada hora. Así el
historial nunca pasa de 24 h, aunque la Pi haya estado apagada.

**Reloj de la Pi.** Las horas dependen del reloj del sistema. Si la Pi no
tiene hora sincronizada (NTP o RTC), los avistamientos quedan con hora
incorrecta y el borrado de 24 h puede borrar datos de más o de menos. La
pantalla muestra una advertencia si el reloj no está sincronizado.

## Modelo de datos

Sin cambios de esquema. `aircraft_seen` ya tiene índices por `icao` y por
`timestamp`, que cubren las dos consultas nuevas.

Se agrega una columna solo si se confirma la opción 1:

- `near INTEGER NOT NULL DEFAULT 0`: 1 si el avistamiento está dentro del
  radio en el momento de grabarse. Así la consulta "cerca" no recalcula
  distancias sobre toda la tabla.

La migración sigue el patrón aditivo de `history.ts` (`ALTER TABLE` si la
columna no existe).

## API

| Método | Ruta | Cambio |
|---|---|---|
| `GET` | `/api/aircraft/history` | Sin cambio en `minutes` e `icao`. Agrega `near=1` para filtrar avistamientos cercanos |
| `GET` | `/api/aircraft/sightings?icao=` | Nuevo. Avistamientos del avión en las últimas 24 h, con fecha y hora |

La ventana de 24 h está fija en el servidor. El cliente no puede pedir más.

## UI (`/aircraft-radar`)

- Lista de aviones: "visto a las HH:MM" para los avistamientos cercanos.
- Al seleccionar un avión: tabla con sus avistamientos de 24 h (fecha,
  hora, altitud, velocidad, distancia).
- Aviso de reloj no sincronizado cuando corresponda.
- Textos en español, con las claves de i18n que ya usa la página.

## Manejo de errores

| Caso | Comportamiento |
|---|---|
| Sin posición del avión | No se marca "cerca" y no se guarda avistamiento cercano |
| Sin GPS ni `ADSB_HOME_LAT/LON` | No hay referencia para el radio. La opción 1 no marca ningún avistamiento "cerca" y la UI lo dice |
| Borrado de 24 h falla | Se registra en consola; se reintenta en la siguiente hora |
| Reloj no sincronizado | Advertencia en la UI; los datos se guardan igual |

## Pruebas

El repo no tiene tests automatizados del módulo ADS-B. La validación es:

1. `npx tsc --noEmit` en `app/`.
2. Pruebas unitarias del borrado de 24 h y del filtro "cerca" con
   `node:test` (misma convención que `chat-history`), usando una base SQLite
   temporal.
3. En la Pi, con el receptor real: verificar que aparece "visto a las HH:MM"
   para un avión cercano, que el histórico muestra fecha y hora, y que una
   fila con más de 24 h desaparece después del siguiente ciclo de borrado.

## Riesgos

- **Crecimiento actual sin límite.** Hoy `aircraft_seen` no se poda. La
  primera ejecución del borrado puede tardar si ya hay muchas filas; hay
  que medirlo en la Pi.
- **Radio mal elegido.** Un radio muy grande vuelve la marca "cerca" poco
  útil. 10 km es una propuesta, no un dato medido; se ajusta con la
  experiencia real.
- **Pérdida de datos por reinicio.** Los avistamientos de las últimas 24 h
  deben sobrevivir a un reinicio. Como están en SQLite (WAL), sobreviven.
  El borrado no debe correr más de una vez por hora.
