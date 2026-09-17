# Interfaz de pantalla minimalista (video + texto)

Se reemplazó la interfaz original del Whisplay HAT (header con emoji, estado,
batería, wifi, barra de progreso de música, scroll de texto con pastillas de
herramientas) por una interfaz minimalista: un personaje animado a pantalla
completa y hasta dos líneas de texto abajo.

## Layout (pantalla 240x280)

```
┌─────────────────────────┐
│                         │
│   GIF (240x216)         │  ← "standing" en reposo, "talking" al responder
│   loop 10fps            │
│                         │
├─────────────────────────┤
│   texto (hasta 2 líneas)│  ← franja negra fija, 240x64
│   verde estilo terminal │
└─────────────────────────┘
```

- **Video**: 216 de los 280px de alto (el resto es la franja de texto). Sin
  emoji, sin header, sin iconos de batería/wifi/vpn — pantalla dedicada al
  personaje y a la respuesta.
- **Qué GIF se muestra**: `talking.gif` mientras `status` (el que manda el
  chatbot por el socket) empieza con "answer" (cubre `"answering"`,
  `"answering..."`, etc.); `standing.gif` en cualquier otro estado (sleep,
  listening, recognizing, thinking, tool calling...).
- **Texto**: verde estilo terminal (`#50FF78`, el mismo verde que ya usaba la
  interfaz para salida de comandos), sin fondo blanco ni subrayado — se decidió
  así porque texto negro sobre fondo negro (lo pedido originalmente) sería
  invisible. Solo se muestran las últimas 2 líneas del texto actual (se recorta
  desde arriba, no hace scroll).

## Cómo se generaron los GIFs

Los videos originales (`standing.mp4`, `talking.mp4`, 640x640, 24fps, ~5s) se
recortan verticalmente a la proporción del área de video (240x216) y se bajan
a 10fps para que sean livianos:

```bash
ffmpeg -i standing.mp4 -vf "crop=640:576:0:32,scale=240:216:flags=lanczos,fps=10,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" -loop 0 standing.gif
```

(mismo comando para `talking.mp4`). Resultado: ~240x216, 50 frames, 10fps,
~520-820KB cada uno. Los archivos finales están en
[`../app/python/img/standing.gif`](../app/python/img/standing.gif) y
[`../app/python/img/talking.gif`](../app/python/img/talking.gif).

Los videos originales (640x640, sin comprimir a GIF) están guardados en
[`../setup/display-source-videos/`](../setup/display-source-videos/) por si se
quieren regenerar los GIFs con otros parámetros (más fps, otro recorte, etc.)
sin depender de tener el archivo fuente en otra máquina.

Por qué el recorte es `640:576:0:32` (no todo el cuadro 640x640): el área de
video en pantalla es 240x216 (relación de aspecto 1.111), así que se recorta
el video cuadrado a esa misma relación (640x576, quitando 32px arriba y abajo)
*antes* de escalar, para no tener que hacer letterboxing/crop en tiempo real
en la Pi — el frame ya sale del tamaño exacto que necesita la pantalla.

## Cómo funciona en el código (`app/python/chatbot-ui.py`)

- `load_gif_frames()` decodifica **todos los frames una sola vez al arrancar**
  y los deja precalculados como buffers RGB565 (el formato que espera la
  pantalla SPI). Así, reproducir la animación es solo indexar una lista, no
  decodificar/escalar en cada frame — clave para que sea "muy ligero" en la
  CPU de la Pi.
- `render_idle_screen()` calcula qué frame tocar mostrar según el reloj
  (`time.time()`), no según un contador que se pueda desincronizar, y solo
  manda el frame por SPI si cambió desde el último render (evita reescribir la
  pantalla con el mismo contenido).
- El socket/protocolo hacia el proceso Node.js (puerto 12345, mismo JSON de
  siempre: `status`, `text`, `text_delta`, `RGB`, `battery_level`, etc.) **no
  cambió** — el campo `emoji` se sigue recibiendo pero ya no se dibuja en
  pantalla. Los modos de cámara (`camera_mode`) e imagen generada
  (`image_path`, para el tool de generación de imágenes) siguen funcionando
  igual que antes, sin tocar.
- Se eliminó todo el código que ya no se usa: header, iconos de estado
  (batería/wifi/vpn/rag/imagen), pastillas de herramientas, barra de progreso
  de música, scroll de texto, y el modo de aprobación del puente de Whisplay
  IM (no lo usamos en este proyecto).

## Para reemplazar los videos más adelante

1. Poner el nuevo video en el Mac (cuadrado o no, cualquier resolución).
2. Ajustar el comando ffmpeg de arriba si la relación de aspecto de origen
   cambia (el `crop` debe dar una relación 240:216 antes de escalar).
3. Sobrescribir `app/python/img/standing.gif` o `talking.gif`, copiar a
   `~/whisplay-ai-chatbot/python/img/` en la Pi, y
   `sudo systemctl restart chatbot.service`.
