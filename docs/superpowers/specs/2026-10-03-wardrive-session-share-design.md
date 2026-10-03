# Compartir sesiones de wardriving en archivos `.akbal`

Fecha: 2026-10-03
Estado: Terminado y desplegado. Exportar, importar, listar y borrar desde la pestaña Compartir de Wardriving. Pendiente de la spec: los puntos de ruta guardan lat, lon y tiempo (sin velocidad, rumbo ni HDOP), y las redes salen por sesión según la consulta existente.

## Objetivo

Que cada sesión de wardriving se pueda descargar desde la sección Wardriving como un
archivo comprimido con extensión `.akbal`, para compartirlo con colaboradores. Ese archivo
debe contener la información del viaje y todo lo capturado en la sesión. También debe
poder cargarse en otra instancia de Akbal Pi para verla.

## Estado actual (referencia)

- Cada sesión es una fila en `drive_sessions` (`app/data/wardrive-drive.db`) con
  distancia, puntos, redes y handshakes, y una carpeta en `~/wardrive-sessions/<id>/`
  (`src/wardrive/drive-db.ts`, `DRIVE_SESSIONS_ROOT`). La carpeta tiene `session.json`,
  capturas y el anillo de paquetes (`ring/`).
- Datos por sesión en la base: `track_points` (ruta con lat, lon, velocidad, rumbo, hdop),
  `networks_seen` (redes por BSSID, con posición y canal), `handshakes` (capturas,
  archivos `.cap` y `.hc22000`, y la contraseña si se descifró).
- Hoy ya existen exportes parciales: `GET /api/wardrive/drive/export/csv`,
  `/export/gpx`, `/export/historial`, y `/drive/files/download`. No cubren la sesión
  completa ni son reimportables.
- En la Pi hay 21 sesiones, 6.392 puntos de ruta, 9.260 redes vistas y 247 handshakes.

## Credenciales y handshakes (decidido)

Una sesión puede incluir contraseñas descifradas y archivos de handshake de redes de
terceros. Compartirlos da acceso a esas redes.

- **Por defecto el `.akbal` incluye contraseñas y handshakes.**
- Antes de exportar, la UI muestra una casilla "Incluir contraseñas y handshakes",
  marcada por defecto. Desmarcarla exporta sin ellas.
- Sin credenciales, el archivo conserva la existencia de cada captura (BSSID, SSID,
  fecha, método), para que el colaborador sepa qué se capturó.
- El manifiesto declara `contiene_credenciales: true|false`, y la carga muestra ese
  dato antes de importar.

## Formato `.akbal`

Un `.akbal` es un archivo ZIP con extensión propia. Contiene:

```
manifest.json          versión del formato, id de sesión, fechas, conteos, sha256 de cada archivo,
                       contiene_credenciales (true/false), origen (hostname de la instancia)
session.json           el mismo que genera la sesión (id, inicio, fin)
drive.json             fila de drive_sessions (distancia, puntos, redes, handshakes)
track.json             puntos de ruta (ts, lat, lon, speed_kmh, heading, hdop)
networks.json          redes vistas en la sesión (ssid, bssid, seguridad, canal, RSSI, posición, veces vistas)
handshakes.json        metadatos de handshakes (sin contraseña ni archivos, salvo opción de credenciales)
captures/              solo si la opción de credenciales está activa: .cap y .hc22000
```

- Los JSON son UTF-8 y se pueden leer sin Akbal.
- `manifest.json` lleva un sha256 por cada archivo. Al cargar, cualquier diferencia se
  rechaza.
- El nombre del archivo es `<id-de-sesion>.akbal`. El id ya es único (carpeta de sesión).

## Descarga

- En Wardriving, cada sesión tiene un botón "Descargar .akbal".
- `GET /api/wardrive/drive/sessions/:id/export.akbal?credentials=0|1`
- `credentials=1` es el valor por defecto: incluye contraseñas y handshakes. La casilla
  de la UI manda `credentials=0` para exportar sin ellas.
- La generación ocurre en el servidor, en una carpeta temporal del sistema de datos, y
  se borra al terminar la descarga.

## Carga

- En Wardriving, botón "Cargar .akbal" que sube un archivo.
- `POST /api/wardrive/drive/sessions/import` (multipart, un archivo, límite de 200 MB).
- Antes de escribir nada, el servidor valida:
  1. que sea un ZIP legible y que no tenga rutas que salgan de su carpeta (ni `..`
     ni rutas absolutas);
  2. que `manifest.json` exista, que la versión del formato sea soportada, y que
     el sha256 de cada archivo coincida;
  3. que el id de sesión no exista ya en esta instancia. Si existe, responde 409 y no
     sobrescribe nada.
- Las sesiones importadas se guardan en tablas separadas (`shared_drive_sessions`,
  `shared_track_points`, `shared_networks`, `shared_handshakes`), para no mezclarlas con
  las capturas propias. Se marcan con el `origen` del manifiesto.
- Una sesión importada se ve en la lista con una etiqueta "compartida"; no se puede
  reanudar ni atacar desde ella.

## Seguridad

- Límite de tamaño de la carga y del descompresionado (zip bomb). Por ejemplo 200 MB
  comprimido y 1 GB descomprimido.
- Solo se leen las entradas que el manifiesto declara. Cualquier entrada extra se
  rechaza.
- Las rutas de descarga y de carga se validan igual que las de `/api/wardrive/...`
  existentes, y solo con sesión de admin.
- La carga de un `.akbal` no ejecuta ningún archivo que contenga.

## API

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/api/wardrive/drive/sessions/:id/export.akbal` | Descarga la sesión. `credentials=1` por defecto; `0` la exporta sin contraseñas ni handshakes |
| `POST` | `/api/wardrive/drive/sessions/import` | Carga un `.akbal` como sesión compartida |
| `GET` | `/api/wardrive/drive/shared` | Lista las sesiones compartidas importadas |
| `POST` | `/api/wardrive/drive/shared/delete` | Borra una sesión compartida importada |

## Pruebas

El repo no tiene tests del módulo de wardriving. La validación es:

1. Pruebas unitarias con `node:test` del exportador y del validador de carga, sobre
   una base temporal:
   - el zip contiene todos los archivos del manifiesto, con sha256 correcto
   - con `credentials=0`, no hay contraseñas ni archivos de handshake en el zip; con `credentials=1` sí
   - una carga con un archivo alterado se rechaza
   - una carga con rutas `../` se rechaza
   - una carga de un id ya existente responde conflicto y no escribe
   - un zip que descomprime más del límite se rechaza
2. En la Pi: exportar una sesión, descargarla, cargarla en una copia de la instancia y
   revisar que aparece como compartida.

## Riesgos

- **Credenciales por defecto.** El archivo que sale por defecto contiene accesos a redes
  ajenas si no se desmarca la casilla. La UI debe dejarlo visible antes de descargar, y
  el colaborador debe saber que el archivo los trae.
- **Tamaño.** Una sesión larga con anillo de paquetes puede pesar cientos de MB. Hay que
  medirlo en la Pi antes de fijar el límite de 200 MB.
- **Formato.** Un cambio de versión del formato debe seguir leyendo los archivos viejos,
  por eso el manifiesto lleva la versión.
