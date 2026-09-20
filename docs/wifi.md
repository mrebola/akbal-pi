# Wifi: menú "Wifi connect" y administrador desde la web

## Qué hace

El dispositivo usa wifi normal (`NetworkManager`, ya configurado en el
sistema — nada nuevo ahí) para todo el tráfico normal, incluido el modo
agente. Esto agrega dos formas de gestionarla sin entrar por SSH:

1. **Menú físico** ("Wifi connect" en el [menú
   rápido](./voice-commands.md#menú-rápido)): convierte la wifi de la propia
   Pi en un punto de acceso (`akbal-pi`) para conectarse directo desde un
   celular sin necesitar internet ni la wifi de siempre — ver
   [`chat-flow/wifi-connect-mode.ts`](../app/src/core/chat-flow/wifi-connect-mode.ts)
   y la sección de abajo. Un solo botón: click activa/desactiva, mantener
   sale del menú.
2. **Interfaz web** (ver [`web-ui.md`](./web-ui.md)): ver el estado actual,
   escanear y conectarse a redes (con contraseña si hace falta), "olvidar"
   redes guardadas, y activar/desactivar el mismo modo punto de acceso desde
   Ajustes → General.

> Antes existía un menú "Internet emergencia" que unía el dispositivo a una
> red pre-configurada en `.env`. Se quitó a favor de "Wifi connect": andaba
> mejor conectarse directo al dispositivo (sin depender de que haya wifi
> disponible cerca) que memorizar una red de respaldo.

## Wifi connect: punto de acceso directo

`app/src/utils/access-point.ts` maneja todo el ciclo vida (crear/activar/
desactivar la conexión `akbal-ap` vía `nmcli`, generar la clave, armar los
QR). El SSID es siempre `akbal-pi`; la clave se genera sola la primera vez
(`akbal` + 4 dígitos, cumple el mínimo de 8 caracteres que pide WPA) y queda
guardada en `.env` (`AP_SSID`/`AP_PASSWORD`) para no cambiar en cada reinicio.

**Importante:** la wlan0 de la Pi puede ser cliente wifi *o* punto de acceso,
no las dos cosas a la vez — activar este modo corta la conexión normal.
Se vuelve a la normalidad desactivándolo desde el mismo menú físico o desde
la web.

Pensado para cuando no hay wifi conocida al alcance: conectate directo al
dispositivo (escaneando el QR que muestra la pantalla, o a mano con el SSID/
clave que también se ven ahí), abrí la web admin, y desde ahí sumá una red
real — así no hace falta volver a este modo.

## Por qué necesita `sudo` para `nmcli`

Escanear y conectar por `nmcli` requiere un permiso de polkit
(`org.freedesktop.NetworkManager.wifi.scan` /
`.network-control`) que un proceso sin sesión de login activa —como
`chatbot.service`, corriendo como servicio systemd sin sesión gráfica— no
tiene por default, aunque el usuario esté en el grupo `netdev`. Verificado
en el dispositivo real: `nmcli dev wifi rescan` por SSH normal falla con
`not authorized`.

`app/src/utils/wifi.ts` (y `access-point.ts` para el modo punto de acceso)
corren todo a través de `sudo -n nmcli ...` (el `-n` hace que falle rápido en
vez de quedarse esperando una contraseña que nunca va a llegar). Dos formas
de que eso funcione:

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

   Este archivo no se instala solo: hay una copia lista en
   [`setup/akbal-nmcli-sudoers`](../setup/akbal-nmcli-sudoers). En la Pi:

   ```bash
   sudo install -m 0440 -o root -g root setup/akbal-nmcli-sudoers /etc/sudoers.d/akbal-nmcli
   sudo visudo -c -f /etc/sudoers.d/akbal-nmcli
   ```

## Qué hace cada cosa en `app/src/utils/wifi.ts`

- `getWifiStatus()`: si hay conexión activa y a qué red.
- `scanWifiNetworks()`: re-escanea y lista lo que hay al alcance, deduplicado
  por SSID (nmcli lista una fila por BSSID), marcando cuáles ya están
  guardadas.
- `connectToWifi(ssid, password?)`: sin contraseña, primero intenta activar
  una conexión ya guardada con ese nombre; si no, intenta como red abierta.
  Con contraseña, se la pasa directo a `nmcli dev wifi connect`.
- `forgetWifi(ssid)`: borra una conexión guardada — solo lo usa la interfaz
  web, el menú físico no tiene esta opción (no hace falta ahí).

## El menú físico (`chat-flow/wifi-connect-mode.ts`)

Mismo click/mantener/doble-clic que el resto de los menús, pero con una sola
acción posible en vez de una lista para recorrer:

| Acción | Hace |
|---|---|
| Click | Activa el punto de acceso si estaba apagado, o lo desactiva si estaba prendido |
| Mantener / doble clic | Sale del menú (deja el punto de acceso como esté) |

Mientras está activo, la pantalla muestra el SSID, la clave y un QR
(`WIFI:T:WPA;S:...;P:...;;`) para unirse escaneando en vez de tipear. 60
segundos sin tocar el botón cierran el menú y vuelven a reposo (más que el
resto de los menús, para dar tiempo a escanear el QR).
