# Wifi: menú "Internet emergencia" y administrador desde la web

## Qué hace

El dispositivo usa wifi normal (`NetworkManager`, ya configurado en el
sistema — nada nuevo ahí) para todo el tráfico normal, incluido el modo
agente. Esto agrega dos formas de gestionarla sin entrar por SSH:

1. **Menú físico** ("Internet emergencia" en el [menú
   rápido](./voice-commands.md#menú-rápido)): ver el estado actual, re-
   escanear, conectarse a una red de emergencia pre-configurada, o a
   cualquier red abierta/ya guardada que esté al alcance. No puede escribir
   una contraseña nueva — no hay con qué, en un dispositivo de un solo botón
   — así que una red segura que nunca se guardó antes solo se puede sumar
   desde la interfaz web.
2. **Interfaz web** (ver [`web-ui.md`](./web-ui.md)): lo mismo, más poder
   escribir contraseñas de redes nuevas y "olvidar" redes guardadas.

## Red de emergencia: configurarla

`EMERGENCY_WIFI_SSID` / `EMERGENCY_WIFI_PASSWORD` en el `.env` del
dispositivo — **nunca en este repo**. El template (`.env.template`) solo
tiene las claves comentadas, sin valor. Para configurarla:

```bash
# en la Pi, editando ~/whisplay-ai-chatbot/.env
EMERGENCY_WIFI_SSID=el-nombre-de-tu-red
EMERGENCY_WIFI_PASSWORD=la-contraseña
```

y reiniciar `chatbot.service`. Sin esto configurado, la opción "Emergencia"
simplemente no aparece en el menú de wifi (el resto — ver estado, conectar a
otras redes — sigue funcionando igual).

Pensado para algo así como el hotspot de un celular, para cuando la wifi de
siempre se cae — con el dispositivo pudiendo conectarse él solo apenas se lo
pidas desde el menú, sin necesitar una laptop ni SSH.

## Por qué necesita `sudo` para `nmcli`

Escanear y conectar por `nmcli` requiere un permiso de polkit
(`org.freedesktop.NetworkManager.wifi.scan` /
`.network-control`) que un proceso sin sesión de login activa —como
`chatbot.service`, corriendo como servicio systemd sin sesión gráfica— no
tiene por default, aunque el usuario esté en el grupo `netdev`. Verificado
en el dispositivo real: `nmcli dev wifi rescan` por SSH normal falla con
`not authorized`.

`app/src/utils/wifi.ts` corre todo a través de `sudo -n nmcli ...` (el `-n`
hace que falle rápido en vez de quedarse esperando una contraseña que nunca
va a llegar). Dos formas de que eso funcione:

1. **El usuario del servicio ya tiene sudo sin contraseña para todo**
   (confirmalo con `sudo -n -l` — si no pide contraseña y el resultado
   incluye algo como `(ALL : ALL) ALL`, ya está). Es el caso de esta Pi
   (`akbal` viene así por default, el mismo criterio que el usuario `pi` en
   Raspberry Pi OS) — no hizo falta tocar nada más.
2. **Si no la tiene**, una regla en `/etc/sudoers.d/` acotada solo a
   `nmcli` (no sudo general, así que el resto del sistema no queda más
   expuesto que antes):

   ```
   # /etc/sudoers.d/akbal-nmcli
   akbal ALL=(root) NOPASSWD: /usr/bin/nmcli
   ```

   Este archivo no se instala solo — hay que crearlo a mano en el
   dispositivo, validarlo con `visudo -c -f <archivo>` antes de copiarlo a
   `/etc/sudoers.d/`, y darle permisos `0440`.

## Qué hace cada cosa en `app/src/utils/wifi.ts`

- `getWifiStatus()`: si hay conexión activa y a qué red.
- `scanWifiNetworks()`: re-escanea y lista lo que hay al alcance, deduplicado
  por SSID (nmcli lista una fila por BSSID), marcando cuáles ya están
  guardadas.
- `connectToWifi(ssid, password?)`: sin contraseña, primero intenta activar
  una conexión ya guardada con ese nombre; si no, intenta como red abierta.
  Con contraseña, se la pasa directo a `nmcli dev wifi connect`.
- `connectToEmergencyWifi()`: envoltorio de lo anterior usando
  `EMERGENCY_WIFI_SSID`/`EMERGENCY_WIFI_PASSWORD`.
- `forgetWifi(ssid)`: borra una conexión guardada — solo lo usa la interfaz
  web, el menú físico no tiene esta opción (no hace falta ahí).

## El menú físico (`chat-flow/wifi-manager-mode.ts`)

Mismo click/mantener/doble-clic que el resto de los menús, con la
diferencia de que "mantener" hace algo distinto según qué entrada esté
mostrando en vez de siempre "confirmar una selección":

| Entrada | Mantener hace |
|---|---|
| Estado actual (SSID o "Sin conexión") | Vuelve a escanear |
| "Emergencia" (si está configurada) | Conecta a la red de emergencia |
| Red guardada o abierta | Conecta |
| Red segura sin guardar | No conecta — muestra "Necesita contraseña, usa la web" |

Doble clic, o 30 segundos sin tocar el botón (un poco más que el resto de
los menús, para dar tiempo a leer los resultados del escaneo), cierran el
menú y vuelven a reposo.
