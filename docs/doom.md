# DOOM en Akbal Pi

DOOM corre en la Raspberry Pi 5 con el motor DoomGeneric y se ve en la pantalla
Whisplay (horizontal, 280×240). Un celular conectado por QR funciona como control
táctil, teclado o gamepad, y opcionalmente como pantalla remota. Hay una sola
instancia del juego: la pantalla y la web son vistas y control de esa misma
partida.

Diseño: `docs/superpowers/specs/2026-10-03-doom-design.md`. Mapa de piezas:
`docs/arquitectura.md`.

## Instalación

Todo se corre desde `app/`. Los dos scripts son de una sola vez; si el archivo ya
existe, no vuelven a descargar ni recompilar.

1. **WAD de datos (Freedoom 0.13.0, BSD-3).**

   ```bash
   bash scripts/fetch-doom-wad.sh
   ```

   Descarga la release oficial, verifica su SHA-256 y deja `freedoom1.wad` en
   `app/data/doom/` (o en `DOOM_WAD_DIR` si lo defines). No se commitea.

2. **Motor DoomGeneric.**

   ```bash
   bash scripts/fetch-doom-engine.sh
   ```

   Clona DoomGeneric en un commit fijo, compila `doom-engine` en `app/doom/bin/` con
   `gcc` y la capa de plataforma de Akbal Pi. Requiere `build-essential` y `git`:

   ```bash
   sudo apt install build-essential
   ```

   El código del motor no se commitea (`app/doom/` está ignorado).

3. Compila la app y reinicia el servicio como de costumbre (`whisplay update` y
   `whisplay service restart`).

## Uso

1. En la pantalla, abre el menú rápido y elige **DOOM**.
2. La pantalla muestra el QR. Escanéalo con el celular.
   - Con Tailscale arriba, el QR apunta a `http://<host-tailscale>:<puerto>/doom`.
   - Sin internet y conectado al WiFi directo de la Pi (`akbal-pi`), apunta a
     `http://10.42.0.1:<puerto>/doom`.
3. El celular abre `/doom`. El token de control viene en el QR (`?t=`). El primer
   celular que se conecta con un token válido toma el control; el juego pasa a
   pantalla completa en la Pi.
4. Controles: flechas o WASD para moverse, Ctrl o Espacio para disparar, E para usar,
   Shift para correr, 1–7 para armas, ESC para el menú. Los botones táctiles usan el
   mismo mapa.
5. El interruptor de video en la web muestra la partida en el celular (unos 10 fps).
   Está apagado por defecto.
6. Para salir, mantén el botón de la Pi 900 ms. Una pulsación corta no sale. La
   pantalla regresa a vertical y al menú.

Sin controlador, la pantalla vuelve a mostrar el QR y el juego sigue corriendo.

## Errores comunes

| Mensaje (pantalla y web) | Causa | Qué hacer |
|---|---|---|
| `Falta el WAD: corre scripts/fetch-doom-wad.sh` | No existe `freedoom1.wad` en el directorio de datos. | Corre el script de WAD. Akbal sigue vivo. |
| `Falta el motor: corre scripts/fetch-doom-engine.sh` | No existe `app/doom/bin/doom-engine`. | Instala `build-essential` y corre el script del motor. |
| `DOOM requiere la pantalla directa; el daemon está activo` | El whisplay-daemon controla el panel y no puede girarlo para DOOM. | Detén el daemon antes de entrar a DOOM. |
| Token inválido o vencido | El QR es de un arranque anterior, o DOOM ya se detuvo. | Vuelve a entrar a DOOM y escanea el QR nuevo. |
| El control no responde, pero se ve la página | Otro celular ya tiene el control. | Ese celular debe soltar el control (o desconectarse). |
| La pantalla vuelve al menú con error | El motor se cayó. `state.error` trae el motivo. | Reintenta desde el menú. |

## Verificación en la Pi (checklist del dueño)

No se verificó en hardware al cerrar la implementación. Corre estos cinco casos
con el HAT conectado y anota el resultado:

1. **WAD faltante.** Renombra `freedoom1.wad` temporalmente, entra a DOOM. La
   pantalla y la web muestran el mensaje de corrección y Akbal sigue respondiendo.
   Restaura el nombre.
2. **Dos entradas seguidas.** Entra a DOOM, sal y vuelve a entrar. Debe haber un
   solo proceso: `pgrep -fc doom-engine` devuelve `1`.
3. **Token viejo.** Detén DOOM, luego conecta un celular con el QR anterior. El
   control debe rechazarlo.
4. **Desconexión libera el control.** Un celular tiene el control; desconéctalo
   (cierra la página o apaga datos). Otro celular debe poder tomarlo.
5. **Motor muerto.** Con DOOM corriendo, ejecuta `pkill doom-engine`. La pantalla
   muestra la tarjeta de error en vertical y se queda ahí; mantener el botón 900 ms sale
   del modo y regresa al menú.

Además, la rotación a horizontal (MADCTL `0xA0`) y el regreso a vertical (`0xC0`)
están validados en la Pi desde el diseño; confírmalos en cada prueba.

Si algún caso falla, abre una prueba roja antes de tocar el código.

## Limitaciones conocidas

- El video (`/ws/doom` sin token) está abierto a cualquier celular de la LAN. Lo
  permite el spec; el control sigue protegido por el token.
- El estado no dice quién tiene el control. La página no puede distinguir a su
  propio celular de otro.
- No hay control de contrapresión en el envío de JPEG (`bufferedAmount`). Un
  celular lento puede acumular cuadros.
- El botón derecho del mouse puede soltar una tecla que se mantiene con el izquierdo.
- Puede dibujarse un cuadro viejo justo después de apagar el video.
- El bucle del gamepad corre aunque no haya ningún control conectado.
- `display.ts` registra un manejador de `uncaughtException` que apaga el servicio
  ante cualquier excepción no capturada. Es preexistente y DOOM no lo cambia; un
  error en DOOM puede tumbar Akbal por esa vía.
