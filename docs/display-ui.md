# Interfaz de pantalla minimalista (íconos + video + texto)

Se reemplazó la interfaz original del Whisplay HAT (header con emoji, estado
en texto, batería, wifi, barra de progreso de música, scroll de texto con
pastillas de herramientas) por una interfaz de 3 franjas: una barra delgada
con íconos de wifi/batería arriba, un personaje animado en el medio, y hasta
dos líneas de texto abajo.

## Layout (pantalla 240x280)

```
┌─────────────────────────┐
│  📶            🔋 87%   │  ← franja de íconos, 240x20
├─────────────────────────┤
│                         │
│   GIF (240x196)         │  ← "standing" en reposo, "talking" al responder
│   cara en primer plano  │     (recorte cercano a la cara, poco cuerpo)
│   loop 10fps            │
├─────────────────────────┤
│   texto (hasta 2 líneas)│  ← franja negra fija, 240x64
│   verde estilo terminal │
└─────────────────────────┘
```

- **Barra de íconos (20px)**: wifi (si hay señal reportada) y batería
  (nivel + color), reutilizando las mismas clases `WifiStatusIcon` /
  `BatteryStatusIcon` que ya existían en `status-bar-icon/`. Sin texto de
  estado ni emoji — solo los dos íconos, alineados a la derecha. Se vuelve a
  dibujar únicamente cuando cambia el nivel de batería o de señal (no en cada
  frame de animación).
- **Video (196px)**: recorte cercano a la cara del personaje (ver abajo),
  sin header, sin emoji.
- **Qué GIF se muestra**: `talking.gif` mientras `status` (el que manda el
  chatbot por el socket) empieza con "answer" (cubre `"answering"`,
  `"answering..."`, etc.); `standing.gif` en cualquier otro estado (sleep,
  listening, recognizing, thinking, tool calling...).
- **Texto (64px)**: blanco/gris claro (`TEXT_PRIMARY`, ver rediseño más abajo),
  sin fondo blanco ni subrayado — se decidió así porque texto negro sobre
  fondo negro (lo pedido originalmente) sería invisible. Solo se muestran las
  últimas 2 líneas del texto actual (se recorta desde arriba, no hace scroll).

## Cómo se generaron los GIFs (recorte cara en primer plano)

Los videos originales (`standing.mp4`, `talking.mp4`, 594x706, 24fps, ~5s)
tienen al personaje de medio cuerpo, retrato vertical (cabeza cerca de la
parte superior del cuadro, con muy poco margen: el pelo empieza ~10-12px
debajo del borde superior del video). Se recorta la región de cabeza+cuello
(`crop=563:460:16:0`, verificado cuadro por cuadro en las dos animaciones
para que el pelo no se corte arriba ni la barbilla abajo en ningún momento)
y se escala a 240x196 — la cara llena casi toda la pantalla del HAT, con muy
poco cuerpo visible:

```bash
ffmpeg -i standing.mp4 -vf "crop=563:460:16:0,scale=240:196:flags=lanczos,fps=10,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" -loop 0 standing.gif
```

(mismo comando para `talking.mp4`). Resultado: 240x196, 50 frames, 10fps,
~1-1.1MB cada uno (más pesados que la versión anterior por el detalle del
cabello/textura del nuevo personaje). Los archivos finales están en
[`../app/python/img/standing.gif`](../app/python/img/standing.gif) y
[`../app/python/img/talking.gif`](../app/python/img/talking.gif).

Los videos originales (594x706, sin comprimir a GIF) están guardados en
[`../setup/display-source-videos/`](../setup/display-source-videos/) por si se
quieren regenerar los GIFs con otro recorte/fps sin depender de tener el
archivo fuente en otra máquina.

Por qué `563:460:16:0` y no otro recorte: el área de video en pantalla es
240x196 (relación de aspecto ≈1.224); se buscó una caja con esa misma relación
que mantuviera la cabeza (pelo incluido) y la barbilla completas, medido
píxel por píxel en frames muestreados de todo el clip (cada 3 frames) de
ambos videos — el pelo del personaje casi toca el borde superior del video
original, así que `y=0` es necesario para no cortarlo; se recorta de más
abajo del cuadro (hombros, pecho) en vez de los lados, ya que el personaje
está centrado horizontalmente.

## Cómo funciona en el código (`app/python/chatbot-ui.py`)

- `load_gif_frames()` decodifica **todos los frames una sola vez al arrancar**
  y los deja precalculados como buffers RGB565 (el formato que espera la
  pantalla SPI). Así, reproducir la animación es solo indexar una lista, no
  decodificar/escalar en cada frame — clave para que sea "muy ligero" en la
  CPU de la Pi.
- `render_idle_screen()` calcula qué frame tocar mostrar según el reloj
  (`time.time()`), no según un contador que se pueda desincronizar, y solo
  manda el frame por SPI si cambió desde el último render (evita reescribir la
  pantalla con el mismo contenido). Lo mismo aplica a `render_top_bar()`
  (solo redibuja si cambia batería/wifi) y `render_bottom_text()` (solo
  redibuja si cambia el texto visible).
- El socket/protocolo hacia el proceso Node.js (puerto 12345, mismo JSON de
  siempre: `status`, `text`, `text_delta`, `RGB`, `battery_level`,
  `wifi_signal_level`, etc.) **no cambió** — el campo `emoji` se sigue
  recibiendo pero ya no se dibuja en pantalla. Los modos de cámara
  (`camera_mode`) e imagen generada (`image_path`, para el tool de generación
  de imágenes) siguen funcionando igual que antes, sin tocar.
- **Overlay de menú (modelo / modo / menú rápido)**: cuando `model_ui` viene
  en `"select"`, `"confirm"` o `"loading"`, `render_model_ui_screen()`
  reemplaza el GIF del personaje por una tarjeta genérica — la misma función
  sirve a los tres selectores (`chat-flow/model-select-mode.ts`,
  `mode-select-mode.ts`, `quick-menu-mode.ts`), diferenciados solo por
  `model_ui_title` ("MODELO" / "MODO" / "MENÚ"). Campos: `model_ui_label`
  (nombre corto), `model_ui_description` (una línea), `model_ui_active`
  (pastilla "● Activo"), `model_ui_index`/`model_ui_total` (texto "N de M",
  ya no puntitos). En `"confirm"` (manteniendo presionado) se dibuja un
  anillo de progreso real con `model_ui_percent`; en `"loading"` no se manda
  percent — Ollama no tiene API de progreso real para cargar un modelo ya
  descargado a memoria, así que se anima un spinner indeterminado a partir
  del reloj (`_draw_spinner`), no un número inventado. `model_ui: ""` (cadena
  vacía, no `null` — mismo criterio que `image: ""`, porque Python no puede
  distinguir "campo ausente" de "campo en null" en el JSON) vuelve a mostrar
  el GIF normal. Ver [`voice-commands.md`](./voice-commands.md) para el
  detalle de gestos (click/mantener/doble clic) de cada menú.
- Se eliminó el código que ya no se usa: header con texto de estado,
  pastillas de herramientas, barra de progreso de música, scroll de texto, y
  el modo de aprobación del puente de Whisplay IM (no lo usamos en este
  proyecto). Los íconos de wifi/batería sí se reincorporaron (franja superior
  delgada); los de VPN/RAG/imagen-generada no, para mantener la barra mínima.

## Para reemplazar los videos más adelante

1. Poner el nuevo video en el Mac (cuadrado o no, cualquier resolución).
2. Extraer varios frames a lo largo del clip y revisar visualmente dónde cae
   la cara, para elegir un `crop=w:h:x:y` que la mantenga completa en todo el
   video (no solo en un frame).
3. Ajustar el `scale` final para que su relación de aspecto sea 240:196
   (o los valores que tenga `VIDEO_WIDTH`/`VIDEO_HEIGHT` en `chatbot-ui.py`
   si se cambia el layout).
4. Sobrescribir `app/python/img/standing.gif` o `talking.gif`, copiar a
   `~/whisplay-ai-chatbot/python/img/` en la Pi, y
   `sudo systemctl restart chatbot.service`.

## Íconos de wifi/batería: tamaño y posición

Dos bugs encontrados al verificar los íconos en el hardware real:

- **`WifiStatusIcon.measure()` no reflejaba el escalado real**: el ícono se
  dibuja escalado 1.4x (`NETWORK_ICON_CENTER_SCALE` en `icon_constants.py`)
  respecto al PNG fuente para compensar que el propio PNG tiene bastante
  relleno transparente, pero `measure()` devolvía el tamaño *sin* escalar. Eso
  hacía que `render_top_bar()` reservara menos espacio del que el ícono
  realmente ocupaba al dibujarse, produciendo recorte/solape con el ícono de
  batería. Se corrigió en `status-bar-icon/wifi_icon.py` para que
  `measure()` reporte el tamaño real del bitmap ya escalado.
- **El bisel de la carcasa tapa el borde derecho del panel** (~10% del ancho).
  Aunque los íconos se dibujen sin recorte dentro de la imagen renderizada,
  quedaban parcialmente ocultos físicamente. Se agregó
  `SAFE_AREA_RIGHT_INSET_PCT = 0.10` en `chatbot-ui.py` — ya no es solo para
  la barra de íconos, es el inset global que respeta cualquier contenido que
  se dibuje cerca del borde derecho (barra superior, tarjetas de menú, texto
  inferior), para que nada quede detrás del bisel en ninguna pantalla.

## Rediseño: paleta oscura con verde como acento, no como color base

La interfaz original pintaba prácticamente todo el texto en verde terminal
(`#50FF78` en todas partes: texto de respuesta, títulos de menú, nombres de
modelo, puntos de paginación) — se sentía más a terminal de hacker que a un
dispositivo de voz. Se separaron los roles en `chatbot-ui.py`:

| Constante | Uso |
|---|---|
| `TEXT_PRIMARY` (blanco/gris claro) | Texto principal: respuestas, nombres de modelo/modo, encabezados de tarjeta |
| `TEXT_SECONDARY` (gris apagado) | Texto secundario: descripciones, pistas de botón, posición ("2 de 4") |
| `ACCENT_GREEN` | Solo acentos: pastilla "Activo", anillo/spinner de progreso, la etiqueta "AGENTE" en la barra superior |
| `ACCENT_DIM` | Fondo apagado de los indicadores de progreso (el anillo/spinner sin llenar) |

También se sacó el prefijo `>_` de los títulos de menú (venía del estilo
terminal original) y se dejó de forzar el nombre del modelo a mayúsculas.

## Indicador de modo en la barra superior

La barra superior (wifi/batería) ahora también muestra, a la izquierda, una
etiqueta chica **LOCAL** (gris) o **AGENTE** (verde acento) según
`isAgentMode()` — ver `top_bar_mode` en `Status` (`app/src/device/display.ts`)
y `render_top_bar()`. Se actualiza al entrar a "sleep" y al confirmar un
cambio de modo (`mode_loading` en `states.ts`), así siempre refleja el modo
real sin tener que abrir el menú de modo para saberlo.
