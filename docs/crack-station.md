# Crack Station — inventario único de handshakes (`/crack-station`)

Página propia del admin web, separada tanto de **Wifi Audit** (`/` pestaña
Wifi Audit) como de **Wardrive** (`/wardrive`): junta en una sola tabla
todos los handshakes que el dispositivo conoce, vengan de uno u otro
módulo, y es donde se crackean — por diccionario o por máscara. Ninguno de
los dos módulos ofrece crackeo propio; ambos enlazan para acá.

Implementación: `app/web/admin/crack-station.{html,js,css}` (frontend) +
`app/src/wifi-audit/service.ts` (`handshakeInventory()`, el merge) +
rutas en `app/src/device/web-admin-server.ts`.

## Inventario unificado

`handshakeInventory()` arma la lista en este orden:

1. La sesión de **Wifi Audit** activa (si hay una en curso).
2. Cada carpeta de sesión pasada de Wifi Audit (`session.json` en
   `~/wardrive-sessions/`).
3. Los handshakes de **Wardrive** (tabla SQLite, `driveDb.listHandshakes()`)
   que ningún `session.json` de Wifi Audit ya cubra.

Un BSSID capturado por los dos módulos aparece una sola vez — gana el
registro de Wifi Audit. La columna **Origen** distingue de dónde vino cada
fila.

## Columnas de la tabla

| Columna | Contenido |
|---|---|
| SSID | con badge "EN VIVO" si la captura es de la sesión activa |
| MAC | BSSID |
| Origen | Wifi Audit / Wardrive |
| Fecha | fecha de captura (abreviada, tooltip con fecha+hora completa) |
| GPS | 📍 abre el mapa en la posición de la captura (solo si hay coordenadas) |
| Handshake | `✓ .cap` si hay archivo capturado, o "sin archivo" |
| Contraseña | ver abajo |
| Estado | progreso del ataque corriendo, si hay uno en curso sobre esa fila |
| Ataques | rockyou / weakpass / máscara… |
| Archivos | botón "Ver archivos" — mismo file browser que usa Wifi Audit, con rutas resueltas y chequeadas contra path traversal |

### Columna Contraseña: parcial + reveal inline

Sin modal — el reveal es parte de la fila:

- **Crackeada**: muestra el parcial (3 primeros caracteres + `…`) en
  monospace. El botón **👁** revela la contraseña completa **en la misma
  celda** (texto verde); un segundo click (**🙈**) la vuelve a enmascarar.
- **Sin archivo**: metadata sobrevivió pero el `.cap`/`.hc22000` ya no
  existe en disco (sesión borrada a mano, o purgada) — la celda muestra
  `—` y no hay botones de ataque en esa fila.
- **Sin crackear**: hay archivo pero todavía ninguna contraseña encontrada
  — aparecen los tres botones de ataque.

El chequeo de archivo (`capOnDisk` en `wifi-audit/service.ts`) revisa el
`.cap` real en disco, incluyendo dentro del `ring/` de Wardrive — no
confía solo en los metadatos de `session.json`/SQLite.

## Ataques disponibles por fila

- **rockyou**: diccionario `rockyou.txt` (~14M claves).
- **weakpass**: wordlist `weakpass_wifi_1`, streameada desde su `.gz` sin
  descomprimirla entera a disco (ruta configurable con
  `WARDRIVE_WORDLIST_WEAKPASS` en `.env`, default
  `~/wordlists/weakpass_wifi_1.gz`).
- **máscara…**: fuerza bruta con un patrón (ej. `@@@@` + sufijo MAC) en vez
  de diccionario — ver abajo.

Solo corre un ataque (diccionario o máscara) a la vez en todo el
dispositivo — comparten la misma CPU. La contraseña candidata nunca va por
argv ni se escribe a disco; todo entra por stdin a `aircrack-ng` (mismo
criterio de seguridad que la validación manual de Wifi Audit).

## Administrar máscaras (segundo subtab)

Presets de máscara con CRUD propio, persistidos en
`~/wardrive-sessions/crack-station.json` (fuera del árbol git, igual que
el resto de datos de sesión). Cada preset tiene:

- **Nombre** y **descripción**.
- **Patrón** de máscara (sintaxis de `aircrack-ng`/`hashcat`, ej. `@@@@`
  para 4 caracteres cualquiera).
- **Sufijo MAC**: si está activo, agrega los últimos 4 hex del BSSID al
  patrón al lanzar el ataque — pensado para contraseñas default que
  incluyen parte de la MAC del AP (ej. routers Axtel/Totalplay tipo
  `AXTEL XTREMO`, donde `@@@@` se expande a `@@@@6EE8`).

Los presets *built-in* no se pueden borrar, solo los agregados a mano.

## Deep link desde Wifi Audit

Al capturar un handshake, el modal de celebración de Wifi Audit
("¡HANDSHAKE CAPTURADO!") muestra el botón **"Abrir Crack Station →"**,
que navega directo a `/crack-station?bssid=<bssid>` — la fila
correspondiente queda resaltada y la página hace scroll automático hasta
ella.

## Higiene de datos

Las filas de Crack Station dependen de que los archivos/metadatos sigan
existiendo. Dos purgas corren al iniciar una sesión de Wardrive
(`beginSession`, `app/src/wardrive/drive-db.ts`):

- `purgeOrphanSessions`: borra filas de sesión cuya carpeta ya no existe
  en disco (sesiones "fantasma" que antes seguían apareciendo en el
  listado).
- `purgeOrphanHandshakes`: borra la fila de un handshake cuyo
  `session_dir`/`cap_file` ya no existe, y limpia el flag de handshake del
  SSID en `networks_seen` si ninguna otra captura lo sigue cubriendo — así
  la red vuelve a quedar disponible para cazar en vez de marcada
  "ya capturada" para siempre por una fila huérfana.

Wifi Audit no tiene una purga equivalente por handshake individual (solo
purga sesiones completas vencidas); por eso una carpeta de sesión de Wifi
Audit borrada a mano puede dejar una fila "sin archivo" en Crack Station
hasta que se borre también el `session.json` que la referencia.

## API (bajo el mismo prefijo `/api/wardrive/*` de Wifi Audit)

```
GET  /api/wardrive/handshakes            # inventario unificado (Wifi Audit + Wardrive)
POST /api/wardrive/dict/start            # {"bssid","cap","wordlist":"rockyou"|"weakpass"}
POST /api/wardrive/dict/stop
POST /api/wardrive/dict/clear
GET  /api/wardrive/dict/status
GET  /api/wardrive/dict/events

GET  /api/wardrive/mask/status
POST /api/wardrive/mask/run              # {"bssid","cap","pattern","macSuffix"}
POST /api/wardrive/mask/stop
POST /api/wardrive/mask/clear
GET  /api/wardrive/mask/presets
POST /api/wardrive/mask/presets          # crear preset
POST /api/wardrive/mask/presets/update
POST /api/wardrive/mask/presets/remove
```

Al encontrar la contraseña (diccionario o máscara), se persiste en el
`session.json`/`info.txt` del target — incluso si es una sesión vieja de
Wifi Audit (`persistPastSessionPassword`) — y pasa a mostrarse con 👁 en
la fila correspondiente.
