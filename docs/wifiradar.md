# WIFIRADAR — visualización 3D del espacio WiFi

`http://<ip-del-dispositivo>:8090/wifiradar` — una escena Three.js
fullscreen (radar militar + mapa estelar + estética cyberpunk/SOC) que
muestra, en tiempo real, las redes WiFi y dispositivos que el AR9271
detecta pasivamente alrededor del Pi. Es una página separada del panel
principal (no una pestaña más) porque el canvas WebGL ocupa toda la
pantalla — hay un link "WIFIRADAR" en la topbar de `/` para llegar a ella,
y "← AKBAL" en su propia topbar para volver.

Solo detección pasiva: nunca envía deauth, no craftea ni transmite
paquetes, no hace cracking. Es un visor de lo que ya está en el aire.

## Arquitectura

```
AR9271 (wlan1, phy1)
  → modo monitor (in-place: wlan1 down → set type monitor → up)
  → channel hopping 2.4GHz (iw dev wlan1 set channel N, cada 400ms)
  → dumpcap -w - (captura, root vía sudo, escribe a stdout — nunca a disco)
  → tshark -r - -T fields (parseo de campos, sin sudo, sin resolución de nombres)
  → parser (app/src/wifiradar/capture.ts) → RawFrameEvent
  → aggregator (app/src/wifiradar/aggregator.ts) — estado en memoria,
    detección de eventos, poda automática (sin persistencia en disco)
  → WebSocket /wifiradar/ws (2-4 snapshots/seg, nunca paquete por paquete)
  → navegador → Three.js (app/web/admin/wifiradar.js)
```

**El Pi nunca renderiza gráficos** — Three.js corre exclusivamente en el
navegador del cliente. El backend solo agrega y transmite JSON pequeño.

### Por qué `dumpcap | tshark` y no `tshark -i` directo

`tshark -i <iface> -T fields ...` (sin `-w`) igual buffer-ea internamente
por un archivo `.pcapng` temporal en `/tmp` — confirmado en este
dispositivo. Eso viola el requisito de nunca escribir PCAP a disco. La
solución real: `dumpcap -i wlan1 -w - -q` escribe los paquetes capturados
a **stdout** (un pipe, no un archivo), y `tshark -r - -T fields ...` los
lee de **stdin** para extraer los campos — nada toca el disco en ningún
punto. Solo `dumpcap` necesita root (es quien realmente abre la interfaz);
`tshark` leyendo bytes ya capturados desde un pipe no lo necesita.

Ambos procesos se lanzan como **un solo `bash -c "dumpcap ... | tshark ..."`**
en vez de conectar dos procesos de Node con `.pipe()` — se probó en este
mismo dispositivo que la relay de Node hace que `tshark` rechace su stdin
(`"The standard input is a 'special file' or socket..."`, exit code 3); un
pipe real de shell no tiene ese problema.

### Detección de hardware y modo monitor

`app/src/wifiradar/ar9271.ts` identifica la interfaz del AR9271 por su
**driver del kernel** (`ath9k_htc`, vía el symlink
`/sys/class/net/<iface>/device/driver`) en vez de por nombre de interfaz o
prefijo de MAC — ambos pueden variar entre dongles/reinicios, el driver no.

`app/src/wifiradar/monitor-control.ts` convierte esa interfaz **en su
lugar** (`ip link down` → `iw set type monitor` → `ip link up`) en vez de
agregar una interfaz virtual adicional sobre el mismo phy — el firmware
`ath9k_htc` de este dongle devolvió "Device or resource busy" al intentar
multi-vif; la conversión in-place funciona de forma confiable. **Nunca
toca `wlan0`** (la radio integrada del Pi, la que lleva Tailscale y la LAN)
— `ar9271.ts` filtra específicamente por el driver del AR9271, así que aun
si algo saliera mal, no hay forma de que la interfaz principal se vea
afectada.

Al salir (`exitMonitorMode`), la restauración a modo `managed` corre
dentro de un **scope systemd independiente**
(`systemd-run --collect --scope`) en vez de como llamadas directas del
proceso Node — `chatbot.service` usa `KillMode=control-group`, que manda
SIGTERM a todo el cgroup del servicio al mismo tiempo que a Node, y en
pruebas la secuencia de restauración se cortaba a la mitad. Un scope de
systemd aparte sigue corriendo hasta terminar aunque el cgroup del
servicio ya se esté bajando.

### Channel hopping

Solo 2.4GHz, solo los canales que el driver reporta disponibles
(`iw phy <phy> info`) — el dominio regulatorio ya lo aplica el kernel/
driver, así que filtrar por esa lista alcanza para respetarlo sin lógica
propia. Recorre secuencialmente cada ~400ms (una vuelta completa a 13
canales tarda ~5.2s).

### Demo Mode

Si el AR9271 no está conectado, no tiene interfaz asociada, o el modo
monitor falla por cualquier razón, WIFIRADAR cae automáticamente a
**DEMO MODE**: `app/src/wifiradar/demo-mode.ts` genera APs/dispositivos/
eventos sintéticos pero realistas, alimentando el **mismo aggregator**
que usaría captura real — la detección de eventos (NEW_AP, red abierta,
WEP, SSID duplicado, ráfaga de deauth, AP perdido) es exactamente la misma
lógica en ambos casos, no una versión simulada aparte. La UI muestra un
badge **DEMO** visible en la topbar cuando está en este modo.

**Auto-recuperación**: el modo demo no es un estado final. Un retry cada
15s (`app/src/wifiradar/service.ts`) vuelve a intentar la captura real —
así enchufar el dongle (o sacar wardrive de la radio) restaura el modo
live solo, sin reiniciar el servicio. Al pasar de demo a live el
aggregator se resetea para que las redes sintéticas del demo no se
mezclen con las reales. El retry se detiene mientras wardrive tiene la
radio (`stopWifiRadarService()` lo cancela).

### El dongle y NetworkManager

NetworkManager gestiona por default toda interfaz wifi, incluido el
dongle USB — y se pelea con el modo monitor/channel hopping (la
interfaz "duerme", `setChannel` falla en cadena, la captura se vacía).
Dos capas de defensa (ambas aplicadas en esta Pi):

1. **Persistente**: `/etc/NetworkManager/conf.d/akbal-usb-wifi.conf`
   marca el dongle como unmanaged por MAC:

   ```ini
   [keyfile]
   unmanaged-devices=mac:9C:EF:D5:FC:8B:F7
   ```

   (la MAC es la del dongle de este dispositivo; cambiar si se usa otro).
   Requiere `sudo systemctl reload NetworkManager` una vez tras crearlo —
   en esta Pi eso pide password de sudo, alternativa sin password:
   `sudo -n nmcli device set wlan1 managed no` (efectivo hasta reiniciar NM).

2. **Código**: el escaneo wifi del admin (`app/src/utils/wifi.ts`) fija
   `ifname wlan0` en todos los comandos nmcli — sin eso, nmcli puede
   escanear/conectar por el dongle en vez de la radio interna, mostrando
   listas incorrectas. Overridable con `WIFI_IFNAME` en `.env`.

### Privacidad

- BSSID/MAC anonimizados por defecto: `AA:BB:CC:••:••:••`. Mostrar la MAC
  completa requiere pasar `?fullMac=1` explícitamente al conectar el
  WebSocket — no hay ninguna opción en la UI actual para activarlo (se
  dejó el soporte del lado del servidor por si se agrega un toggle más
  adelante).
- Cada AP/dispositivo también lleva un `id` — un hash de una sola vía
  (SHA-256, primeros 12 caracteres) de la MAC real. Existe porque
  anonimizar a solo el prefijo de vendor puede hacer que dos dispositivos
  reales de la misma marca colapsen al mismo string anonimizado; el `id`
  le da al frontend una clave estable sin exponer la MAC real.
- No se guardan payloads de tráfico, nunca. El parser solo extrae headers
  802.11 (BSSID, SSID, canal, señal, flags de seguridad) — el contenido
  cifrado de otros dispositivos ni se intenta leer.
- No se persiste nada a disco: todo el estado (APs, dispositivos, eventos)
  vive en memoria del proceso Node y se poda automáticamente (AP sin
  beacon en 60s → evento "AP perdido"; sin actividad 5 min → se elimina de
  memoria del todo).

## Perfil de recursos (medido en este dispositivo, Pi 5 8GB)

Con captura real activa y ~30 APs/tráfico normal de vecindario:

| Proceso | RAM (RSS) | CPU |
|---|---|---|
| `dumpcap` | ~6-7 MB | ~0% |
| `tshark` | ~150-160 MB | ~1% |
| Overhead en el proceso Node (aggregator + WebSocket) | pocos MB | despreciable |

CPU total del backend bien por debajo del 10% objetivo. La RAM de `tshark`
(el motor completo de disección de Wireshark) es lo que domina el
footprint — ligeramente por encima del ideal de <150MB adicionales, pero
cómodamente debajo del máximo de 250MB. Cero escritura a disco en todo
momento (verificado con `lsof`/`find` durante una sesión de captura larga).

## Dependencias de Linux

```bash
sudo apt-get update
sudo apt-get install -y iw tshark ieee-data
```

- **`iw`** (`/usr/sbin/iw` en Debian/Raspberry Pi OS) — control de modo
  monitor y channel hopping. Puede no estar en el `PATH` de un usuario
  normal (vive en `/usr/sbin`); el código lo invoca por ruta absoluta.
- **`tshark`** — trae `dumpcap` consigo (mismo paquete). Instalar `tshark`
  via `apt` puede preguntar si usuarios no-root pueden capturar paquetes
  (grupo `wireshark`) — no hace falta responder que sí, porque WIFIRADAR
  siempre invoca `dumpcap` a través de `sudo -n`, no directamente.
- **`ieee-data`** (opcional pero recomendado) — el registro completo de
  OUIs del IEEE (~35k fabricantes) en `/usr/share/ieee-data/oui.csv`. El
  backend lo carga una sola vez al arrancar y lo usa para resolver la
  marca de cada AP/dispositivo; sin él cae a una tabla corta curada a mano
  (~50 entradas) y muchas redes muestran "Desconocido". No añade
  subprocessos ni costo por consulta (dict lookup en memoria).
- El usuario que corre `chatbot.service` (`akbal` en este dispositivo) ya
  tiene sudo sin contraseña completo (`(ALL:ALL) ALL`, ver
  [`wifi.md`](./wifi.md)) — no hace falta una regla de sudoers adicional
  para `iw`, `ip`, `dumpcap` ni `systemd-run`.

## Cómo verificar que el AR9271 está conectado

```bash
# 1. ¿Lo ve el bus USB? (Qualcomm Atheros Communications AR9271 802.11n)
lsusb | grep -i "0cf3:9271"

# 2. ¿Tiene una interfaz de red asociada, y con qué driver?
for i in /sys/class/net/*/device/driver; do
  echo "$(dirname $(dirname $i)) -> $(basename $(readlink -f $i))"
done
# la línea del AR9271 va a decir "... -> ath9k_htc"

# 3. ¿Soporta modo monitor ese phy?
iw dev   # anota el nombre de interfaz (ej. wlan1) y su "phy#N"
iw phy phyN info | grep -A 10 "Supported interface modes"
# debe listar "monitor" en la lista
```

Si `lsusb` no lo ve: revisar el cable/puerto USB — el AR9271 a veces
necesita un hub USB 2.0 alimentado si el puerto no da suficiente
corriente. Si lo ve pero no aparece ninguna interfaz `ath9k_htc`, revisar
`dmesg | tail -50` en busca de errores de carga de firmware
(`ath9k_htc` necesita `ath9k_htc/htc_9271.fw`, normalmente ya incluido en
`firmware-atheros` de Debian).

Sin el AR9271 (o si el modo monitor falla por cualquier motivo), WIFIRADAR
arranca automáticamente en DEMO MODE — no hace falta nada especial para
probar la interfaz visual sin el hardware.

## Cómo iniciar WIFIRADAR

No requiere un paso de arranque separado — corre como parte del mismo
`chatbot.service` que todo lo demás:

```bash
# En el dispositivo:
sudo systemctl restart chatbot.service
# Confirmar que arrancó en modo real (o cayó a demo):
grep -i wifiradar ~/whisplay-ai-chatbot/chatbot.log | tail -5
# "[wifiradar] Live capture started on wlan1 (phy1), 13 channels" → real
# "Real capture unavailable, using DEMO MODE: <razón>" → demo
```

Desde el navegador: entrar a `http://<ip-del-dispositivo>:8090`, loguearse
(ver [`web-ui.md`](./web-ui.md)), y click en **WIFIRADAR** en la topbar (o
navegar directo a `/wifiradar`).

### Controles

- **drag**: rotar cámara · **wheel**: zoom
- **click** en un nodo: panel lateral con SSID, BSSID (anonimizado),
  vendor, RSSI, canal, seguridad, primera/última vez visto, frames y
  clientes observados
- **buscar** por SSID/BSSID: atenúa todo lo que no matchea
- **LIVE/PAUSE**: pausa la aplicación de nuevos snapshots (la escena sigue
  animada, los datos se congelan)
- **RESET VIEW**: vuelve la cámara a la posición inicial
- **2D/3D**: alterna entre vista orbital libre y vista cenital fija
  (el radar visto desde arriba)
- **AUTO/LOW/MEDIUM/HIGH**: calidad gráfica — AUTO monitorea FPS y baja un
  nivel si el promedio cae debajo de 30 por un rato sostenido, sube si
  se mantiene arriba de 55

### RSSI como referencia visual únicamente

La distancia de cada nodo al núcleo central es una función de su RSSI
(más fuerte = más cerca), **nunca una distancia real** — no hay forma de
convertir RSSI en metros con precisión sin calibración específica del
entorno, y la UI no pretende serlo.

## Frontend

`app/web/admin/wifiradar.html` + `wifiradar.js` + `wifiradar.css` — Three.js
se usa como módulo ES, vendorizado localmente (no depende de una CDN en
tiempo de ejecución) en `app/web/admin/vendor/`:
`three.module.min.js` (r169) y `OrbitControls.js` (control de cámara
drag/zoom). Sin paso de build — mismo criterio que el resto de
`app/web/admin/`.

Presupuesto gráfico: máx. 30 APs visibles, 50 dispositivos (como
`InstancedMesh` orbitando su AP), 100 efectos/partículas en pool
reutilizable. Sin sombras dinámicas, sin postprocesado de bloom real (el
glow del núcleo es un par de esferas semitransparentes con blending
aditivo — mucho más liviano que un pase de `UnrealBloomPass`), render loop
pausado por completo si la pestaña está oculta
(`document.visibilitychange`).
