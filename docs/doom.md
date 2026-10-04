# DOOM en Akbal Pi

DOOM corre en la Raspberry Pi 5 con el motor DoomGeneric y se ve en la pantalla
Whisplay (horizontal, 280×240). Un celular conectado por QR funciona como control
táctil, teclado o gamepad, y opcionalmente como pantalla remota. Hay una sola
instancia del juego: la pantalla y la web son vistas y control de esa misma
partida.

Diseño: `docs/superpowers/specs/2026-10-03-doom-design.md`. Sonido, dueño del juego y
control horizontal: `docs/superpowers/specs/2026-10-03-doom-audio-mirror-design.md`.
Mapa de piezas: `docs/arquitectura.md`.

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

3. **Sonido: sintetizador y soundfont.**

   ```bash
   sudo apt install fluidsynth
   bash scripts/fetch-doom-soundfont.sh
   ```

   `fluidsynth` toca la música MIDI del juego. El script descarga el soundfont
   General MIDI (FluidR3_GM, licencia MIT) desde el paquete de Debian, verifica su
   SHA-256 y deja `soundfont.sf2` en `app/data/doom/`. No se commitea (pesa unos
   140 MB). Sin `fluidsynth` o sin el soundfont, el juego sigue sin música; el aviso viaja en
   el estado de DOOM, pero todavía no se muestra en la pantalla de la Pi.

   Los efectos no necesitan nada extra: salen por `aplay` a la tarjeta de sonido del
   HAT, la misma que usa la voz de Akbal.

4. Compila la app y reinicia el servicio como de costumbre (`whisplay update` y
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

El control del celular es horizontal, con estilo de control de SNES; cada botón dice
qué hace.

Sin controlador, la pantalla vuelve a mostrar el QR y el juego sigue corriendo.

### Dónde se juega: "Jugar aquí"

La partida tiene un solo dueño a la vez: la Pi o la web. El otro lado es espejo: ve
la partida y no manda teclas ni volumen.

- El celular toca **Jugar aquí** y toma el juego. Si el juego no está corriendo, ese
  botón lo arranca; la pantalla de la Pi queda en espejo.
- Mientras la web juega, la pantalla de la Pi muestra la partida sin controles. Si la
  web termina la partida, la Pi regresa al menú.
- Si la Pi tenía el juego y la web lo toma, la Pi pasa a espejo.

### Sonido y volumen

- Los efectos y la música salen por la bocina de la Pi.
- El volumen empieza en **60%**. Se controla desde el celular en pasos de **5%**.
- El volumen se guarda en `app/data/doom/settings.json` y se conserva entre partidas
  y reinicios.
- La voz de Akbal tiene prioridad: mientras responde por voz, el sonido de DOOM se
  pausa y se reanuda al terminar.

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

No se verificó en hardware al cerrar la implementación. Corre estos casos con el HAT
conectado y anota el resultado. Los casos 6 a 12 son del sonido, el dueño y el
espejo; el 1 a 5 son de la base.

Antes de empezar, en la Pi: `sudo apt install fluidsynth` y
`bash scripts/fetch-doom-soundfont.sh` (ver Instalación).

Casos base:

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

Sonido y dueño:

6. **Sonido por la bocina.** Entra a DOOM. Se oyen efectos al disparar y la música
   de la partida.
7. **Volumen desde el iPhone.** Sube y baja el volumen desde el celular en pasos de 5%.
   Reinicia DOOM y confirma que el volumen se conserva.
8. **Voz de Akbal durante el juego.** Con DOOM sonando, pregunta algo por voz. El
   sonido del juego se pausa mientras Akbal responde y se reanuda al terminar.
9. **Arranque desde la web con el juego apagado.** Detén DOOM desde la Pi. En el
   celular, toca **Jugar aquí**. El juego arranca, el video llega a la web y la
   pantalla de la Pi queda en espejo.
10. **Espejo cuando la web juega.** Con la web jugando, la pantalla de la Pi muestra la
    partida en espejo. Activa el video en la web y confirma que la partida se ve en el
    celular.
11. **La web termina la partida.** Termina la partida desde la web. La pantalla de la
    Pi regresa al menú.
12. **Crash con sonido activo.** Con sonido, repite el caso 5 (`pkill doom-engine`). La
    tarjeta de error se queda y el servicio sigue vivo.

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
- La web arranca el juego sin revisar si el whisplay-daemon está activo (la Pi sí lo
  revisa). Decisión pendiente con el dueño.
- El volumen de la música se aplica a la siguiente canción, no en vivo. El spec pide
  volumen en vivo; decisión pendiente con el dueño.
- El stderr de `aplay` se descarta, así que un fallo de la salida de audio no deja
  rastro en los logs.
- Los avisos de audio y música (`audioError`, `musicError` en el estado) todavía no se
  muestran en la pantalla de la Pi.
