# Laboratorio wireless — AP de prueba dedicado

Entorno de pruebas aislado para desarrollar y validar las herramientas de
auditoría wifi ([wifiradar.md](./wifiradar.md),
[wardrive.md](./wardrive.md)) sin tocar redes reales.

## Regla de oro

- **El AP del lab es una red propia, autorizada explícitamente por el
  operador del dispositivo** — es el caso de uso que el allowlist de
  wardriving exige por diseño.
- La Pi (y la laptop del operador) **se conectan a internet directo**
  (hotspot/datos móviles) durante las pruebas, nunca sobre la red de casa/
  oficina.
- Por diseño el lab está vacío: no verás equipos conectados al AP salvo que
  el operador conecte uno a propósito para generar tráfico (necesario para
  probar deauth + captura de 4-way handshake). Un cliente que se conecta y
  hace handshake también genera el PMKID pasivo observable.
- Al terminar una sesión de pruebas, **restaurar la config de red de la
  laptop** (borrar la IP fija — ver abajo), o el adaptador quedará sin
  conectividad normal la próxima vez.

## Hardware: TP-LINK TL-WA730RE

AP dedicado al lab, con estas características: 2.4GHz, WPS, modos AP/range
extender/client. Precio/accesibilidad lo hacen fungible (si se rompe, se
compra otro igual).

## Configuración actual del AP (v1)

| Sección | Valor |
|---|---|
| Operation Mode | Access Point |
| SSID | `akbal_lab` |
| Seguridad | WPA/WPA2-PSK (Most Secure) |
| Password | `123456789` (lab-only, deliberadamente débil) |
| Login admin | `admin` / `admin` |
| LAN IP | `192.168.0.254` (estático) |
| DHCP Server | Disabled (por diseño — fuerza clientes a IP manual, útil para ver tráfico de red en Wireshark sin ruido DHCP) |
| WPS | Activo, PIN `72692752` |

El modem de casa soporta WEP — pendiente de probar contra `wardrive` el
rompimiento de WEP (el parser de seguridad de wifiradar ya detecta WEP en
beacons: `SecurityKind = "WEP"` en app/src/wifiradar/types.ts).

> **Nota anti-secretos**: estos valores son del lab, no de ninguna red real.
> La contraseña `123456789` y el PIN WPS `72692752` son deliberadamente
> públicos/debiluchos para poder auditarlos; NO reutilizarlos en redes
> domésticas.

## Cómo configurar el AP desde la laptop (proceso v1, repetible)

1. Laptop se pone IP fija en la subred default del AP:
   - IP: `192.168.0.10`, máscara `255.255.255.0` (gateway no hace falta
     para administrar).
2. Entrar al panel: `http://192.168.0.254/` (login `admin`/`admin`).
3. Cambiar los valores de la tabla de arriba (Operation Mode, SSID,
   seguridad, IP, DHCP off, etc.).
4. **Después de configurar, borrar la IP fija del adaptador de la laptop**
   (volver a DHCP) — si queda la IP estática puesta, el adaptador no va a
   conectar a otras redes normalmente más adelante (no está en la subred
   `192.168.0.x` y no pide DHCP).
5. Conectar un cliente de prueba al AP para generar tráfico cuando se
   quiera probar deauth/handshake.

## Cómo probar la suite contra el lab (workflow típico)

1. **Pi conectada a internet directo** (no la red de casa) — así cualquier
   captura o deauth que escape solo toca el lab.
2. Dongle AR9271 enchufado → WIFIRADAR debe reportar modo live
   (ver [wifiradar.md](./wifiradar.md)); `akbal_lab` tiene que aparecer en
   la visualización 3D con su canal y seguridad WPA2.
3. Pestaña WARDRIVING → Entrar → Escanear → `akbal_lab` debería aparecer
   con RSSI fuerte si estás cerca. Autorizar el BSSID del AP → Auditar.
4. **Para que el deauth funcione** tiene que haber un cliente asociado al
   AP (el AP no genera handshakes solo): conectar la laptop u otro equipo
   al SSID `akbal_lab`, dejarlo idle o pasando tráfico, y lanzar el
   ataque — el 4-way handshake se captura cuando el cliente se reconecta
   tras la deauth.
5. El `.hc22000` resultante se puede romper offline con hashcat y la
   contraseña conocida (`123456789`) para validar el pipeline completo
   (capture → convert → crack) sin ambigüedad.

### Casos de prueba pendientes (ideas)

- WPA2 normal con cliente → handshake por deauth dirigida (el caso feliz).
- WPS con PIN conocido (REaver/bully no integrados todavía — evaluar si
  agregar como runner alternativo en wardrive/).
- WEP en el modem — wardrive hoy no lo rompe (necesitaría `aircrack-ng`
  sobre captura de IVs, no está implementado).
- PMKID pasivo: cliente que se conecta al AP mientras la captura está
  corriendo, sin deauth.
- Deauth tab: autorizar la MAC del cliente de prueba y tirar deauth
  individual por ventana de segundos.

## Qué verificar si algo no anda

- El AP quedó con DHCP desactivado: si un cliente de prueba no levanta IP,
  es lo esperado — ponle IP estática en `192.168.0.x` a mano (la gateway es
  `192.168.0.254`).
- WPS PIN: el panel del AP lo muestra en la sección WPS; si el PIN cambió,
  actualizar la tabla de arriba.
- Reset de fábrica del AP (botón ~10s) lo devuelve a defaults y borra esta
  config — repetir el proceso de "Cómo configurar el AP" de arriba.