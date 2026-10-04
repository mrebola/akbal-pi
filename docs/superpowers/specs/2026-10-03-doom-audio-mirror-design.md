# DOOM: sonido, dueño del juego (Pi o web) y control horizontal

Fecha: 2026-10-03
Estado: Implementado en la rama; pendiente de verificación en la Pi
Extiende: `docs/superpowers/specs/2026-10-03-doom-design.md` (el spec base).

## Objetivo

1. El juego se juega en un solo lugar a la vez: la pantalla de la Pi o la web.
   El otro lugar es espejo.
2. La web puede arrancar el juego si no está corriendo.
3. DOOM suena por la bocina de la Pi con efectos y música.
4. El volumen de DOOM empieza en 60%, se controla desde el celular en pasos de 5%
   y se guarda entre partidas.
5. El control del celular es horizontal, con estilo de control de SNES, y cada botón
   dice qué hace.

## Motivo del bug actual

El video en la web se quedó en negro porque el juego no estaba corriendo: se había
cerrado desde la Pi. El servidor no manda cuadros sin un motor activo. El nuevo modo
de dueño (abajo) cubre este caso: la web puede arrancar el juego y pedir el video.

## Decisiones (aprobadas)

| Tema | Decisión |
|---|---|
| Dónde se juega | Uno a la vez: la Pi o la web. El otro lado es espejo (solo ve). |
| Cómo se elige | Botón "Jugar aquí" en la página del celular. Quien lo presiona toma el juego. |
| Arranque desde la web | Si el juego no corre, "Jugar aquí" lo arranca. La Pi queda en espejo. |
| Sonido | Efectos y música. La música con sintetizador MIDI en la Pi (fluidsynth + soundfont). |
| Volumen inicial | 60%. |
| Pasos de volumen | 5%, de 0% a 100%, controlados desde el celular. |
| Volumen entre partidas | Se guarda en la Pi y se usa al arrancar DOOM. |
| Control | Horizontal, estilo SNES. Cada botón muestra su función en texto. |
| Orientación en iPhone | La web no puede forzarla: si el teléfono está vertical, la página pide girarlo. |

## Dueño del juego (Pi o web)

El juego tiene un **dueño**: `pi` o `web`. El dueño decide dónde se juega y qué
superficie controla.

- Estado nuevo en `DoomSession`: `owner: "pi" | "web" | null`. `null` = no hay juego.
- Entrar a DOOM desde la Pi: `owner = "pi"`, arranca el motor si no corre.
- "Jugar aquí" desde la web: si no hay juego, arranca el motor; `owner = "web"`.
  Si el juego ya corre en la Pi, toma el dueño y la Pi pasa a espejo.
- Un espejo recibe el estado y los cuadros de video, pero sus controles no mandan teclas.
- Cuando el dueño sale del juego (botón mantenido en la Pi o "Salir" en la web), el
  motor se detiene y el dueño vuelve a `null`.
- La pantalla de la Pi muestra el juego en modo espejo cuando `owner === "web"`, con
  el mismo flujo de cuadros que hoy. Sin QR en espejo.
- Solo puede haber un token de control activo a la vez (ya existe). Al cambiar de
  dueño se revoca el token anterior y se emite uno nuevo para el nuevo dueño.

Reglas de cambio:
- Cambiar de dueño suelta todas las teclas presionadas (key-up), como hoy al soltar
  el control.
- Un espejo no puede tomar el dueño sin pulsar "Jugar aquí".

## Sonido

### Motor

- Se implementa `I_InitSound`, `I_UpdateSound`, `I_InitMusic`, `I_PlaySong`,
  `I_StopSong` y el resto de la interfaz de audio de DoomGeneric en la capa de plataforma
  (`app/doom/engine/doomgeneric_akbal.c`).
- Efectos: muestras DMX de los WAD, mezcladas en el motor a 11025 Hz, 16 bits.
- Música: el motor convierte MUS a MIDI (`mus2mid.c`, que ya viene en DoomGeneric).
  El MIDI no se reproduce en el motor: se envía a un sintetizador externo.
- El PCM mezclado sale por un descriptor de salida propio (igual que los cuadros), en
  un pipe que lee Node. Así el stdout de los cuadros no se mezcla con audio.

### Sintetizador MIDI

- `fluidsynth` en modo CLI, con un soundfont General MIDI. El soundfont se descarga con
  un script verificado (SHA-256), igual que el WAD. No se commitea.
- El MIDI que escribe el motor se envía a fluidsynth por su entrada MIDI.
- La salida de audio de fluidsynth y de los efectos pasa por el mismo volumen de DOOM.
- Instalación en la Pi: paquete del sistema (`fluidsynth`), que requiere permiso
  explícito del dueño antes de ejecutarse.

### Salida en la Pi

- Efectos y música salen por la tarjeta de sonido del HAT, con `aplay` a un dispositivo
  ALSA fijo (el mismo que usa la voz de Akbal, detectado como hoy en `audio.ts`).
- Mientras Akbal habla (respuesta de voz), el audio de DOOM se pausa y se reanuda al
  terminar. Así la voz y el juego no se mezclan ni se cortan.

### Volumen

- El volumen se aplica en el motor (escala del PCM), no en el sistema de la Pi. Así no
  cambia el volumen de Akbal.
- Valor: entero de 0 a 100 en pasos de 5. Inicial: 60.
- Persistencia: archivo `app/data/doom/settings.json`, con `{ "volume": 60 }`. Se escribe
  al cambiar y se lee al arrancar el motor.
- El celular manda `{ "type": "volume", "value": <0-100> }`. Solo el dueño puede cambiar
  el volumen. La Pi también puede cambiarlo desde el dueño "pi"; ese control queda para
  una fase posterior.

## Control horizontal estilo SNES

- Página `/doom` con layout horizontal en iPhone: D-pad a la izquierda, botones de acción
  a la derecha, estilo de control de SNES.
- Cada botón muestra su texto: FIRE "Disparar", USE "Abrir/usar", WEAPON "Cambiar arma",
  RUN "Correr", MENU "Menú". Los números 1-7 aparecen en el teclado de escritorio.
- Control de volumen: `−` y `+` en pasos de 5%, con el valor actual visible.
- Si el teléfono está vertical, la página muestra "Gira tu iPhone a horizontal" y no
  deja jugar hasta girarlo.
- Botón "Jugar aquí" visible en la página, con el estado del dueño (Pi, web, o sin juego).
- Espejo: la página muestra el juego y los controles deshabilitados.

## Protocolo (cambios)

Cliente → servidor:
- `{ "type": "play-here" }`: pide ser dueño. Responde con estado y token nuevo si aplica.
- `{ "type": "volume", "value": n }`: cambia el volumen (solo dueño).

Servidor → cliente, en `state`:
- `owner`: `"pi" | "web" | null`.
- `mirror`: `true` si este cliente es espejo.
- `volume`: valor actual.

## Errores

| Caso | Respuesta |
|---|---|
| `fluidsynth` no instalado | Tarjeta de error: "Falta fluidsynth: instálalo en la Pi". El juego corre sin música. |
| Soundfont no descargado | Mensaje: "Falta el soundfont: corre scripts/fetch-doom-soundfont.sh". Sin música. |
| Falla el audio de la tarjeta | El juego sigue sin sonido, con aviso en el estado. |
| Voz de Akbal habla | El audio de DOOM se pausa y reanuda. Si la voz falla, se reanuda igual. |

## Pruebas

- Unitarias (node:test): transiciones de dueño (pi ↔ web, null), suelta de teclas al cambiar
  de dueño, validación de volumen (0-100, pasos de 5), persistencia de `settings.json`.
- En la Pi (manual): efectos y música por la bocina; volumen desde el iPhone; "Jugar aquí"
  desde la web con el juego apagado y encendido; voz de Akbal durante el juego.

## Riesgos

- **CPU y RAM:** el sintetizador MIDI consume CPU y comparte RAM con el modelo de IA.
  Medir con el modelo cargado antes de dar por bueno el sonido.
- **Tarjeta compartida:** la voz y el juego usan la misma salida. El diseño pausa el
  juego durante la voz; hay que confirmar que no hay cortes audibles.
- **Licencia del soundfont:** elegir uno con licencia que permita uso y redistribución.
  No se commitea.

## Fuera de alcance

- Control de volumen desde la Pi (queda para después).
- Más de un juego o más de un WAD.
- Más de un jugador a la vez.
