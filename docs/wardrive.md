# WARDRIVE v2 — captura de handshakes para laboratorio/tesis

Módulo de captura de material WPA (handshakes 4-way y PMKID) sobre la misma
radio del WiFi Radar. Es una función de **uso de laboratorio/tesis**: solo
opera contra redes que el operador autorizó explícitamente, una por una.
Documenta la implementación vigente (app/src/wardrive/).

## Novedades v2

- **Modo live-only**: `enter()` exige un adaptador USB en modo monitor. Sin
  dongle el modo no se activa ("No hay adaptador WiFi USB conectado") — la
  fuente demo del WIFIRADAR ya no aplica a wardriving (capturar handshakes
  de datos sintéticos no tendría sentido).
- **Validación real del handshake** (v2): "capturado" de hcxpcapngtool solo
  prueba que hay material EAPOL (un M1 suelto o un PMKID cuentan como
  "escrito"). La v2 agrega `crack.ts`: corre `aircrack-ng` contra el `.cap`
  con una contraseña candidata y solo `KEY FOUND` prueba que el 4-way
  handshake está completo y crackeable.
  - Validación **automática**: con `WARDRIVE_LAB_PASSWORD=<pass>` en
    `.env`, todo objetivo capturado se verifica solo al capturarse
    (`autoValidate`, service.ts) — el status muestra `verified: true`.
  - Validación **manual** desde la UI: cada resultado capturado muestra un
    campo de contraseña + botón "Verificar" (`POST /api/wardrive/validate`).
    La contraseña va por stdin a aircrack, nunca en argv ni a disco.
- **Fix de conversión**: el regex de `convertCapture` ahora matchea el
  formato real de hcxpcapngtool 6.3.5 ("EAPOL pairs written to 22000 hash
  file...: N") — antes no matcheaba nada y toda captura válida terminaba
  marcada como failed.
- **Hallazgo del lab**: contra el TL-WA730RE, `hcxdumptool` no consigue
  handshake (el AP rechaza sus associations); el pipeline clásico
  `airodump-ng` + `aireplay-ng` con deauth dirigida a clientes reales
  captura el 4-way completo de forma confiable. Ver
  [`lab-wireless.md`](./lab-wireless.md).

## Modelo de seguridad (el allowlist ES la frontera)

- Un BSSID es atacable **únicamente** si el operador lo agregó al allowlist
  (`POST /api/wardrive/allowlist`). No existe ningún código que autorice en
  masa "todas las redes descubiertas" — ver comentario en
  `app/src/wardrive/service.ts:24`.
- El deauth dirigido (pestaña Deauth) tiene su **propia allowlist de MACs de
  clientes** (`deauthAllowlist`): cada dispositivo requiere autorización
  individual, un click por MAC, sin camino de "deauth a todos".
- Contra objetivos del modo DEMO los ataques son inertes: los BSSIDs
  sintéticos del generador demo nunca son visibles para una radio real, así
  que el ataque termina en "ya no visible".
- La UI nunca ofrece "atacar todo lo descubierto": "Todo" significa
  "todo lo que está en el allowlist Y visible ahora" (service.ts:458).
- Nada de esto corre por defecto: el modo wardrive se entra y se sale
  explícitamente desde el admin web.

## Arquitectura

```
AR9271 (wlan1) — la misma radio del WiFi Radar, exclusión mutua por diseño
  enter(): detectMonitorAdapter() → stopWifiRadarService() → modo monitor
  → descubrimiento de objetivos (del snapshot del radar, o iw scan fallback)
  → operador autoriza BSSIDs (allowlist)
  → ciclo de ataque por objetivo (ver abajo)
  → exit(): restore a managed → startWifiRadarService() (devuelve la radio)
```

- `app/src/wardrive/service.ts` — orquestador (singleton compartido, una
  sola radio). Estados: `inactive | ready | scanning | attacking`.
- `app/src/wardrive/discovery.ts` — NO corre su propio scanner: lee el
  snapshot vivo del WiFi Radar (misma foto del aire). Fallback: un
  `iw dev wlan0 scan` de un solo tiro si el radar está parado. Modo demo:
  lee el pool del generador demo del radar.
- `app/src/wardrive/attack.ts` — runners de procesos externos
  (`PmkidRunner`, `AirodumpCapture`, `DeauthRunner`, `scanTarget`), cada
  uno mata su grupo de procesos al parar (mismo patrón detached+group-kill
  que wifiradar/capture.ts).
- `app/src/wardrive/monitor.ts` — modo monitor propio (ciclo de vida
  distinto al del radar: sostiene la sesión completa, no por corrida).
  Conversión in-place y restore via `systemd-run --scope` — mismos motivos
  que wifiradar/monitor-control.ts.
- `app/src/wardrive/rf.ts` — `iw dev <iface> set channel <N>`.
- `app/src/wardrive/session.ts` — persistencia por sesión.
- `app/src/core/chat-flow/wardrive-mode.ts` — espejo del estado en la
  pantalla LCD del dispositivo mientras el modo está activo.

## Ciclo de ataque contra un objetivo (`runTarget`, service.ts:572)

Orden real de los pasos, con los comandos exactos que se ejecutan:

### 1. Escaneo previo — canal real y clientes

El canal que reporta el radar puede ser un artefacto del channel hopping
(la interfaz escuchando, no la del AP). Se resuelve desde el aire:

```bash
sudo -n airodump-ng --bssid <BSSID> -w <prefix>-scan --output-format csv --write-interval 1 wlan1
# corre 9 segundos, se mata, y se parsea el CSV:
#   sección AP: canal real del objetivo
#   sección Station: clientes asociados (seedClients)
```

### 2. Fijar canal

```bash
sudo -n /usr/sbin/iw dev wlan1 set channel <canal_real>
```

### 3. Captura con airodump-ng (toda la sesión en un solo .cap)

```bash
sudo -n airodump-ng --bssid <BSSID> -c <canal> -w <prefix> --output-format pcap,csv --write-interval 1 wlan1
```

- El stdout se ignora a propósito: airodump dibuja una tabla curses que si
  se pipea y no se drena llena el buffer de 64KB y **bloquea el proceso
  silenciosamente** dejando un `.cap` de 0 bytes (comentario en attack.ts:210).
- Solo stderr se pipea, para el log.
- `AirodumpCapture.associatedClients()` parsea el `.csv` en vivo para
  dirigir deauths a clientes reales.

### 4. Ráfagas de deauth dirigidas (aireplay-ng)

Hasta `DEAUTH_MAX_ATTEMPTS = 5` intentos; en cada uno deauth dirigido a
cada cliente asociado **más una ráfaga broadcast**:

```bash
sudo -n aireplay-ng --deauth 64 -a <BSSID> -c <MAC_CLIENTE> -D wlan1   # dirigida
sudo -n aireplay-ng --deauth 64 -a <BSSID> -D wlan1                    # broadcast
```

- `DEAUTH_BURST = 64` por ráfaga, `DEAUTH_SETTLE_MS = 12s` de ventana tras
  cada ráfaga esperando el reconect del cliente (doble si no hay clientes
  detectados). Pausa de 2s entre intentos.
- `-D` evita esperar el trigger ARP/ap-request: empuja de inmediato.
- Sin clientes reales, se usa el snapshot del radar como fuente (`pickClientFor`).

### 5. Validación con hcxpcapngtool (lo único que cuenta como éxito)

```bash
hcxpcapngtool -o <prefix>.hc22000 <prefix>-01.cap
```

Solo cuenta como "captured" si hcxpcapngtool reporta EAPOL/PMKID escritos
> 0 (`convertCapture` en session.ts:127). Una captura sin handshake no se
marca como éxito jamás. Se aceptan entradas `.pcapng` (hcxdumptool) y
`.cap` (airodump).

### 6. Fallback PMKID pasivo

Si el deauth no produjo handshake, se mantiene la captura fijada al canal
y se espera `PMKID_PASSIVE_MS = 20s` por un frame PMKID pasivo (redes
WPA3/SAE no hacen 4-way handshake pero emiten PMKID al conectarse un
cliente). Si tampoco: validación final y marca de "failed" con motivo.

> Nota: `PmkidRunner` (attack.ts:18) con `hcxdumptool --target_ap
> --disable_deauth` existe y está cableado, pero el flujo v1 de `runTarget`
> no lo invoca — el fallback PMKID actual es pasivo sobre la captura de
> airodump. Quedó como runner disponible para experimentos separados.

### Otros parámetros

| Constante | Valor | Qué es |
|---|---|---|
| `PMKID_TIMEOUT_MS` | 45s | timeout nominal del método PMKID |
| `PMKID_POLL_MS` | 3s | polling de validación |
| `DEAUTH_SETTLE_MS` | 12s | ventana de reconexión tras ráfaga |
| `DEAUTH_BURST` | 64 | deauths por ráfaga |
| `DEAUTH_MAX_ATTEMPTS` | 5 | intentos del ciclo deauth |
| `PMKID_PASSIVE_MS` | 20s | ventana pasiva de fallback |
| `BETWEEN_TARGETS_MS` | 1.5s | pausa entre objetivos secuenciales |

## Deauth independiente (pestaña Deauth)

Además del ciclo de captura hay un deautheo dirigido a clientes suelto:

- `GET /api/wardrive/devices` — vista read-only de los clientes vistos en
  el aire (funciona incluso con wardrive inactivo; solo el ataque está
  gated).
- `POST /api/wardrive/deauth/authorize` — autoriza UNA MAC.
- `POST /api/wardrive/deauth/attack` — ráfagas repetidas por una ventana
  de segundos (2–60, default 10) fijando antes el canal del AP asociado:

  ```bash
  sudo -n aireplay-ng --deauth 128 -a <BSSID> -c <MAC> -D wlan1
  ```

- `POST /api/wardrive/deauth/stop` — corta el deauth de esa MAC.
- Políticas: el cliente debe estar visible y asociado en el aire; no se
  permite deauth a un cliente cuyo AP esté siendo atacado por la sesión de
  captura (service.ts:284); nunca broadcast en esta pestaña (solo dirigida).

## Sesiones y archivos

Cada entrada al modo crea `~/wardrive-sessions/<YYYYMMDD-HHMMSS>/`
(fuera del árbol git, en el dispositivo — session.ts:13):

```
~/wardrive-sessions/20260924-191732/
├── session.json                        # metadatos + estado por objetivo
├── <bssid-sin-dos-puntos>.log          # log de texto del ataque
├── progress-<bssid>.jsonl              # progreso paso a paso (reconexión UI)
├── <bssid>.cap                         # captura cruda (airodump-ng)
├── <bssid>.hc22000                     # hash convertido (formato hashcat 22000)
└── (archivos -scan temporales del escaneo previo, se borran)
```

- Antes de cada ataque se borran los outputs stale del mismo prefix para no
  confundir un handshake de una corrida anterior con el actual
  (service.ts:583).
- El file browser web (`/api/wardrive/files*`) resuelve toda ruta vía
  `resolveSessionPath()` — no hay escape del root ni path traversal
  (realpath check, service.ts:824).

## Validación del handshake (v2, crack.ts)

`crackCheck(capPath, password, bssid)` corre:

```bash
aircrack-ng -w - -b <BSSID> <prefix>-01.cap   # la contraseña entra por stdin
```

Y clasifica:

| Verdict | Significado |
|---|---|
| `verified` | `KEY FOUND` — handshake completo y crackeable con esa contraseña |
| `handshake_wrong_password` | handshake real presente, contraseña no matchea |
| `no_handshake` | el `.cap` no tiene pares EAPOL utilizables |
| `error` | aircrack falló (timeout, archivo corrupto, etc.) |

- La contraseña viaja **por stdin** (`-w -`, wordlist de stdin), nunca en
  argv (visible en `ps`) ni en archivos temporales.
- `verified` se reporta por target en el status (`verified: true`) y en la
  UI como "VALIDADO".
- El `.cap` de airodump es el formato que aircrack lee directo — los
  `.pcapng` de hcxdumptool NO los acepta este build de aircrack (Debian),
  por eso la captura del ciclo es siempre `.cap`.
- Output de aircrack se limpia de escapes ANSI (redibuja pantalla curses)
  antes de mostrarse en el log de la UI.

## API HTTP (bajo sesión de cookie del admin)

```
GET  /api/wardrive/status               # estado completo + targets + allowlist
POST /api/wardrive/enter                # toma la radio, modo monitor (live-only v2)
POST /api/wardrive/exit                 # restaura radio, devuelve control al radar
POST /api/wardrive/source               # {"source":"live"|"demo"} (radar only)
POST /api/wardrive/refresh              # re-escaneo de objetivos
POST /api/wardrive/allowlist            # {"bssid":"AA:BB:..."} — AUTORIZACIÓN
POST /api/wardrive/allowlist/remove
POST /api/wardrive/attack/one           # {"bssid":"..."} — un objetivo
POST /api/wardrive/attack/many          # {"bssids":[...]} — secuenciales
POST /api/wardrive/attack/cancel
POST /api/wardrive/validate             # {"bssid":"...","password":"..."} — v2: valida handshake con aircrack
GET  /api/wardrive/progress?bssid=...   # historial del stepper
GET  /api/wardrive/devices              # clientes vistos (Deauth tab)
POST /api/wardrive/deauth/authorize | deauthorize | attack | stop
GET  /api/wardrive/files?path=...       # file browser
GET  /api/wardrive/files/download?path=...
POST /api/wardrive/files/delete
```

## Exclusión mutua con el WiFi Radar

La AR9271 es una sola radio. Al entrar, wardrive llama
`stopWifiRadarService()` (y su retry loop queda cancelado) para tomarla;
al salir la restaura a modo managed y llama `startWifiRadarService()` —
el radar se recupera solo. En modo demo-source el radar se deja en demo
(no se detiene) y al salir se vuelve a live. El hook de shutdown
(`registerShutdown`, index.ts:33) restaura la interfaz aunque el proceso
muera a mitad de sesión.

## RAM

Al entrar se descarga el modelo LLM de Ollama de memoria
(`unloadModel()`, service.ts:44) — wardriving necesita headroom y el LLM
no sirve mientras la radio está ocupada. Al salir el flujo normal lo
recarga. El flag `modelsUnloaded` en el status lo refleja.

## Dependencias

```bash
sudo apt-get install -y aircrack-ng hcxtools iw
```

- `airodump-ng` / `aireplay-ng` (paquete `aircrack-ng`) — captura y deauth.
- `hcxpcapngtool` (paquete `hcxtools`) — conversión y validación.
- `hcxdumptool` — solo necesario para el runner PMKID activo (no usado en
  el flujo v1 de runTarget).
- El usuario del servicio ya tiene `sudo -n` completo (ver
  [`wifi.md`](./wifi.md)); no hay regla de sudoers adicional.

## Cómo usarlo (desde el admin web)

1. Entrar a `http://<ip-del-dispositivo>:8090`, loguearse
   ([web-ui.md](./web-ui.md)) y abrir la pestaña **WARDRIVING**.
2. Botón **Entrar** — la radio pasa a wardrive (el radar se detiene, el
   LCD del dispositivo muestra la pantalla WARDRIVE).
3. **Escanear** lista las redes visibles; **Autorizar** agrega el BSSID al
   allowlist (paso obligatorio, es el security boundary).
4. **Auditar** corre el ciclo completo contra ese BSSID con progreso paso
   a paso en un modal (scan → lock → capture → deauth → validate → done).
   "Todo" lanza la secuencia sobre todos los autorizados visibles.
5. Los archivos capturados se listan abajo y se descargan desde la web.
6. Botón **REAL/DEMO** cambia la fuente de descubrimiento (ensayo sin
   hardware).
7. **Salir** restaura la radio y devuelve el control al radar.

Verificación por log:

```bash
grep -i wardrive ~/whisplay-ai-chatbot/chatbot.log | tail -10
# "[wardrive] mode ON (iface=wlan1, session=20260919-024533)" → activo
# "[wardrive] mode OFF" → restaurado
```