# DOOM en Akbal Pi (DoomGeneric)

Fecha: 2026-10-03
Estado: Diseño aprobado por el dueño. Pendiente de revisión del spec antes del plan.

## Objetivo

Correr DOOM en la Raspberry Pi 5 y mostrarlo en la pantalla Whisplay. Un celular
conectado por QR funciona como control táctil y, opcionalmente, como pantalla
remota. La web y la pantalla muestran la misma partida: hay una sola instancia del
juego, y la web es una vista y un control de esa instancia, nunca una segunda.

## Decisiones (aprobadas)

| Tema | Decisión |
|---|---|
| Motor | DoomGeneric (`ozkl/doomgeneric`, GPL-2.0). Versión fijada en el script. El código no se commitea. |
| Datos del juego | `freedoom1.wad` (Freedoom 0.13.0, BSD-3), descargado con `app/scripts/fetch-doom-wad.sh`. No se commitea. |
| Pantalla Whisplay | Horizontal solo mientras corre DOOM: MADCTL `0xA0`, 280×240. Al salir regresa a vertical (`0xC0`). Validado en la Pi. |
| Imagen en pantalla | 320×200 escalado a 280×175, centrado. |
| Cómo llega a la pantalla | Socket de `chatbot-ui.py` (puerto 12345), con un tipo de mensaje nuevo. No usa whisplay-daemon. |
| Salir desde la Pi | Mantener el botón 900 ms (igual que el modo chat web). Una pulsación corta no sale. |
| QR | Tailscale si está arriba. Si no hay internet y el celular se conecta por WiFi directo (`akbal-pi`), `http://10.42.0.1:8090/doom`. |
| Acceso del control | Sin login. El QR lleva un token aleatorio que se genera en cada arranque de DOOM y se invalida al detener el juego. |
| Controles | Un solo control a la vez: el primero que se conecta con un token válido. Los demás ven la vista si está activa, pero sus botones no mandan nada. |
| Video en la web | Opcional, con interruptor. Apagado: el juego se ve solo en la Pi. Encendido: cuadros JPEG por WebSocket, unos 10 fps. |
| Codificación JPEG | Librería `jpeg-js` (JavaScript puro). Dependencia nueva. |

## Arquitectura

```
DoomGeneric (C, proceso hijo)
   │ stdout: cuadro 280×175 RGB565 con longitud (binario)
   │ stdin:  eventos de tecla "down|up <código>"
   ▼
DoomSession (Node, único dueño del proceso)
   ├─► renderer chatbot-ui.py (socket 12345): mensaje JSON "game_frame"
   │     con el cuadro en base64, para la pantalla Whisplay
   └─► WebSocket /ws/doom
         ├─ a clientes con video activo: JPEG binario
         └─ a todos: estado (running, controller, streaming)
             ▲
             │ claim / release / key / stream
   Página /doom (móvil y escritorio)
```

### Piezas

1. **Motor** (`app/doom/`, ignorado por git). Compilado en la Pi por
   `app/scripts/fetch-doom-engine.sh`. La capa de plataforma propia:
   - `DG_DrawFrame`: convierte el buffer a 280×175 RGB565 (vecino más cercano) y lo
     escribe por stdout con cabecera de longitud.
   - `DG_GetKey`: lee eventos de stdin y los entrega al motor.
   - Resolución interna 320×200 (`DOOMGENERIC_RESX/RESY`).
2. **DoomSession** (`app/src/doom/session.ts`). Lanza el motor solo si no corre.
   Reparte cuadros a la pantalla y a la web, y aplica la política de un control
   a la vez.
3. **Tokens** (`app/src/doom/tokens.ts`). Genera y valida el token de control.
   Función pura, sin red.
4. **Codificador de video** (`app/src/doom/frame-jpeg.ts`). Convierte RGB565 a JPEG
   con `jpeg-js` solo cuando hay clientes con video activo.
5. **Ruta WebSocket** (`app/src/device/doom-routes.ts`). Acepta `/ws/doom?t=<token>`
   para control y `/ws/doom` sin token para solo ver el estado.
6. **Página** (`app/web/admin/doom.html`, `doom.js`, `doom.css`). Ruta pública
   `/doom`; no pasa por el login del admin.
7. **Estado de pantalla** (`app/src/core/chat-flow/doom-mode.ts`). Estado nuevo
   `doom` en el menú rápido: muestra el QR, luego el juego a pantalla completa.

## Protocolo

Cliente → servidor (JSON):

- `{ "type": "claim" }`: pide el control. Responde con `state` y `controller: true`
  o `controller: false` si ya hay otro.
- `{ "type": "release" }`: suelta el control.
- `{ "type": "key", "code": "<nombre>", "down": true|false }`: solo lo acepta el
  controlador.
- `{ "type": "stream", "on": true|false }`: activa o apaga el video de este cliente.

Servidor → cliente:

- `{ "type": "state", "running", "controller", "streaming", "url", "error" }`
  cada vez que cambia algo.
- Mensaje binario: un JPEG de 280×175. Solo para clientes con `stream` activo.

Mapeo de teclas del navegador a códigos de DOOM: flechas y WASD para moverse,
CTRL o Espacio para FIRE, E para USE, Shift para RUN, 1–7 para armas, ESC para
MENU. El mismo mapa se usa en los botones táctiles.

## Política de control

- Un solo controlador. Si el controlador se desconecta, el control queda libre
  de inmediato.
- Un cliente sin token nunca puede tomar el control, aunque esté en la misma red.
- Mientras no haya controlador, la pantalla muestra el QR; al conectarse uno, el
  QR se oculta y el juego pasa a pantalla completa. Si el controlador se va, el QR
  vuelve a mostrarse y el juego sigue corriendo.

## Errores

| Caso | Respuesta |
|---|---|
| No existe `freedoom1.wad` | La pantalla y la web muestran: `Falta el WAD: corre scripts/fetch-doom-wad.sh`. |
| No existe el binario del motor | Muestran: `Falta el motor: corre scripts/fetch-doom-engine.sh`. |
| El motor se cae | `state.error` con el motivo. La pantalla vuelve al menú; se puede reintentar. |
| Token inválido o vencido | Rechaza el `claim` con `controller: false` y un error corto. |
| Video sin JPEG disponible | El cliente sigue con el control; solo pierde la imagen. |

## Pruebas

Unitarias (`node:test`, con `dist/`):

- el mapa de teclas cubre las teclas del spec y no tiene duplicados;
- tokens: se generan con longitud fija, se validan, y expiran al detener el juego;
- política de control: un solo controlador, liberación al desconectar;
- el codificador devuelve un JPEG del tamaño correcto para un cuadro de 280×175.

En la Pi (manual, con el HAT a la mano):

- el motor arranca, la pantalla gira a horizontal y muestra el juego;
- el QR abre `/doom` desde el celular por Tailscale y por WiFi directo;
- control táctil y teclado en la web, y la Pi refleja los cambios;
- video activado y desactivado desde la web;
- mantener el botón 900 ms sale del juego y la pantalla regresa a vertical.

## Riesgos y medición

- **Ancho de banda por socket.** Un cuadro de 280×175 RGB565 en base64 pesa unos
  130 KB. Hay que medir la tasa de cuadros real antes de fijar 15 fps en pantalla.
- **CPU de `jpeg-js`.** Hay que medir el tiempo por cuadro en la Pi 5 antes de
  fijar 10 fps en la web.
- **Memoria.** El motor es pequeño, pero comparte la RAM con el modelo de IA. Hay
  que revisar que DOOM no provoque OOM mientras el modelo está cargado.
- **`akbal.local`.** No se usa en el QR; la URL es Tailscale o la IP de WiFi directo.

## Fuera de alcance

- Audio de DOOM.
- Más de un juego o más de un WAD.
- Multijugador o varios controles a la vez.
- Guardado de partidas persistente entre reinicios.
