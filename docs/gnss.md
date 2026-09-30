# GNSS — metadata de satélites offline-first (CelesTrak)

Servicio backend (`app/src/services/gnss/`) que enriquece la lista de
satélites que ya lee la página GPS (`app/src/utils/gps.ts`, docs/gps.md) con
metadata cacheada en SQLite y datos orbitales de
[CelesTrak](https://celestrak.org/), sin depender de Internet para seguir
funcionando.

## Por qué existe

`utils/gps.ts` ya lee del adaptador NMEA constelación (por prefijo de
talker), PRN, SNR, azimut y elevación — eso es "dónde está el satélite
ahora mismo" y no requiere red. Lo que CelesTrak agrega es identidad
("¿quién es este satélite?": nombre, catálogo NORAD) y elementos orbitales
(OMM), puramente informativo — nunca se usa para calcular posición, esa
sigue viniendo 100% del receptor local.

## Arquitectura (offline-first)

```
utils/gps.ts (NMEA)  ──▶  services/gnss/service.ts (sweep cada 5s)
                              │
                              ├─▶ gnss_observations   (SQLite, histórico)
                              ├─▶ gnss_satellite_metadata (permanente: constelación+PRN → NORAD id + nombre)
                              └─▶ gnss_orbital_data   (OMM/JSON de CelesTrak, por NORAD id)
                              │
                              └─▶ si hay PRN sin resolver o datos > 24h,
                                  refresco en segundo plano (celestrak.ts)
                                  — nunca bloquea el snapshot que se devuelve
```

- **Metadata permanente separada de datos orbitales**: `gnss_satellite_metadata`
  (constelación, PRN, NORAD id, nombre, primera/última vez visto) vive en una
  tabla aparte de `gnss_orbital_data` (JSON del OMM + epoch + cuándo se
  descargó). Refrescar la órbita nunca toca la identidad, y viceversa.
- **Cache-first**: `GET /api/gnss/status` siempre responde con lo que hay en
  SQLite/memoria — si CelesTrak nunca respondió, los campos de metadata
  vienen en `null` en vez de bloquear o fallar.
- **Sin Internet o CelesTrak caído**: `celestrak.ts` nunca lanza — cualquier
  falla (DNS, timeout de 10s, HTTP no-200, JSON inválido) resuelve a `null` y
  el servicio sigue sirviendo lo cacheado. Reintenta como máximo cada 5 min
  por constelación (no en cada sweep de 5s).
- **Refresh**: por constelación (GPS/GLONASS/Galileo/BeiDou, vía los grupos
  públicos de CelesTrak `gps-ops`/`glo-ops`/`galileo`/`beidou`), solo cuando
  hay PRNs sin resolver o el dato orbital tiene más de 24h.
- **Vínculo PRN → NORAD id**: se extrae del campo `OBJECT_NAME` del OMM
  (patrón `PRN NN`). GPS/Galileo/BeiDou lo incluyen; GLONASS generalmente no
  — esos quedan sin nombre en vez de adivinar un match incorrecto.

## API

- `GET /api/gnss/status` — snapshot actual: por satélite, lectura en vivo
  (constelación/PRN/SNR/az/el/uso) + metadata cacheada (`{ noradId, name }`)
  + antigüedad del dato orbital (`orbital.ageMs`), más el estado del último
  intento de refresco (`lastRefreshOk`, `lastRefreshError`).
- `GET /api/gnss/history?minutes=60` — observaciones históricas
  (`gnss_observations`), para graficar SNR/visibilidad en el tiempo.

Ninguna de las dos bloquea si no hay Internet: son lecturas de SQLite +
memoria, la llamada a CelesTrak ocurre aparte y en segundo plano.

## Frontend

`web/admin/gps.js` hace polling adicional (cada 15s, mucho menos frecuente
que el fix de posición) a `/api/gnss/status` y mezcla `gnssName`/
`gnssOrbital` en los objetos de satélite antes de pasarlos al sky plot y al
globo 3D (`globe.js`) — campos aditivos, así que si CelesTrak nunca resolvió
nada la UI se ve exactamente igual que antes.

## Variables de entorno

- `GNSS_ENABLED` (default `true`): apaga el servicio (sweep timer + SQLite)
  si se pone en `false`, igual que `ADSB_ENABLED` para Aircraft Radar.

## Archivos

- `app/src/services/gnss/types.ts` — tipos compartidos.
- `app/src/services/gnss/db.ts` — SQLite (`data/gnss.db`).
- `app/src/services/gnss/celestrak.ts` — cliente HTTP a CelesTrak (vía
  `cloud-api/proxy-fetch.ts`, respeta `HTTPS_PROXY`/`HTTP_PROXY`).
- `app/src/services/gnss/service.ts` — orquestador (sweep, refresh, snapshot).
- `app/src/utils/gps.ts` — agrega el campo `constellation` a `GpsSatellite`
  (derivado del prefijo de talker NMEA), consumido por este servicio.
