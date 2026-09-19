# Comandos de voz (volumen, modelo, modo y ayuda)

## El botón único: un solo gesto por pantalla

Todo el dispositivo usa la misma gramática de botón, sin importar en qué
pantalla estés — nunca triple clic, nunca combinaciones raras:

| Dónde | Click corto | Mantener (~0.4-0.9s) | Doble clic |
|---|---|---|---|
| **Reposo** | Abre el [menú rápido](#menú-rápido) | Push-to-talk (empieza a grabar) | — |
| **Menús** (modelo, modo, menú rápido, ayuda) | Pasa a la siguiente opción/página | Confirma lo resaltado (~0.9s) | Cancela, vuelve a reposo |
| **Akbal pensando/hablando** | Corta la voz, vuelve a reposo | Interrumpe y empieza a hablar (push-to-talk) | — |

En reposo, si soltás el botón antes de ~0.4s es un click (menú rápido); si lo
mantenés más de eso ya cuenta como "mantener" y arranca a grabar — no hace
falta esperar a soltar. Mismo mecanismo, invertido, para pasar de página a
confirmar en los menús.

## Menú rápido

Click corto en reposo abre un carrusel con **Modelo → Modo → Ayuda → Cámara**
(cámara solo si `ENABLE_CAMERA=true`). Click pasa entre opciones, mantener
~0.9s confirma la resaltada y entra a esa pantalla — mismo mecanismo que el
selector de modelo/modo de abajo. Reemplaza al doble clic que antes abría la
cámara directo desde reposo; ahora todo pasa por acá.

## Lista rápida

Todo lo que se puede pedir por voz, de un vistazo (detalle y más ejemplos en
las secciones de abajo):

| Comando | Ejemplos |
|---|---|
| Subir volumen 10% | "sube el volumen", "súbele", "aumenta el volumen", "volume up", "louder" |
| Bajar volumen 10% | "baja el volumen", "bájale", "disminuye el volumen", "volume down", "quieter" |
| Poner volumen exacto | "pon el volumen en 40", "volumen al 70%", "set the volume to 50" |
| Abrir menú de modelo (sin elegir) | "cambia modelo", "cambiar modelo" |
| Cambiar de modelo directo | "modelo 3", "cambia el modelo a 1", "usa el modelo deepseek", "cambia el modelo a qwen sin censura 2" |
| Preguntar qué modelo está activo | "qué modelo usás", "qué modelo estás usando", "qué modelo tenés activo" |
| Abrir menú de modo en "modo agente" | "activa modo agente", "modo agente" |
| Abrir menú de modo en "modo local" | "activa modo local", "modo local", "desactiva modo agente" |
| Abrir menú de modo (sin decir cuál) | "cambiar modo" |
| Ver esta lista en pantalla | "ayuda" |

El volumen inicial al prender el dispositivo es **70%** por defecto
(`INITIAL_VOLUME_PERCENT` en `.env`, ver [`SETUP.md`](./SETUP.md)); estos
comandos lo ajustan después, en caliente.

Volumen y cambio de modelo se controlan por voz **sin pasar por el LLM**. Se
probó primero activar el tool-calling nativo de Ollama (`OLLAMA_ENABLE_TOOLS`)
para que el modelo interprete estos comandos, pero eso manda la descripción de
*todas* las herramientas en *cada* request — con las 7 que ya estaban activas
(volumen, imagen, búsqueda web), un simple "hola" pasó de responder en ~1s a
tardar **15.4 segundos** solo en procesar el prompt, en este hardware (CPU sin
GPU/NPU). Por eso el texto reconocido por el ASR se revisa con expresiones
regulares en `app/src/core/chat-flow/voice-commands.ts` **antes** de llegar al
LLM: si coincide con un comando, se ejecuta directo (instantáneo) y nunca se
gasta un turno de LLM; si no coincide, sigue el flujo normal sin ningún costo
extra. `OLLAMA_ENABLE_TOOLS` se dejó desactivado.

## Volumen

Funciona en español o inglés, se detecta por palabras clave (no hace falta
decir la frase exacta):

| Acción | Ejemplos que funcionan |
|---|---|
| Subir 10% | "sube el volumen", "súbele", "aumenta el volumen", "volume up", "turn up the volume", "louder" |
| Bajar 10% | "baja el volumen", "bájale", "disminuye el volumen", "volume down", "turn down the volume", "quieter" |
| Ajustar a un valor exacto | "pon el volumen en 40", "volumen al 70%", "set the volume to 50" (necesita la palabra "volumen"/"volume" + un número) |

## Cambiar de modelo

Los modelos disponibles se definen en `MODEL_ALIASES` dentro de
`voice-commands.ts`, a partir de lo que hay instalado ahora mismo
(`ollama list` en la Pi — ver [`llm-model-selection.md`](./llm-model-selection.md)):

| Nombre corto | Modelo real | Notas |
|---|---|---|
| **modelo 1** / deepseek | `deepseek-r1:1.5b` | |
| **modelo 2** / llama 3 | `llama3.2:3b` | |
| **modelo 3** / qwen 3.5 | `qwen3.5:2B` | |
| **modelo 4** / qwen sin censura | `huihui_ai/qwen3-abliterated:1.7b` | Con prompts muy cortos a veces repite el prompt en vez de responder. |
| **modelo 5** / qwen sin censura 2 | `huihui_ai/qwen3.5-abliterated:2B` | El que se usa por defecto (ver `docs/llm-model-selection.md`). |
| **modelo 6** / qwen 3 | `qwen3:1.7b` | El más rápido y estable. |

El `Qwen3.5-4B-Uncensored-GGUF` probado y descartado (lento, no corta la
generación) **no** está en esta lista — no tiene sentido ofrecerlo como opción
de voz.

**Para pedir el menú visual:** decí "cambia modelo" o "cambiar modelo" (sin
decir cuál). En vez de contestar por voz, la pantalla entra al modo de
selección — ver más abajo.

**Para cambiar directo por voz, sin pasar por el menú:** "cambia el modelo a
1", "modelo 3", "usa el modelo deepseek", "cambia el modelo a qwen sin
censura 2". Alcanza con decir "modelo" + el número o el nombre corto — no
hace falta el verbo de cambio si ya nombrás un modelo válido. Esto también
muestra la pantalla de carga (ver abajo) antes de quedar listo.

**Si no se entiende cuál pediste** (dijiste "modelo" + intención de cambio
pero el nombre no coincide con ninguno de la lista): ya **no** cambia de
modelo a ciegas — antes lo hacía, y un comando mal escuchado terminó dejando
activado un modelo peor sin que nadie lo pidiera (ver
`docs/llm-model-selection.md`). Ahora simplemente abre el mismo menú visual
para elegir a propósito.

**Para preguntar cuál está activo sin cambiar nada:** "qué modelo usás",
"qué modelo estás usando", "qué modelo tenés activo" — responde hablado
("Estoy usando el modelo X") y no toca el menú ni el modelo.

### Menú visual (botón del Whisplay HAT)

La tarjeta muestra el nombre corto del modelo, una descripción de una línea,
una pastilla **"● Activo"** si es el que está corriendo, y la posición
("2 de 4") — solo modelos que `ollama list` confirma instalados en ese
momento (ver más abajo).

- **Click corto**: pasa al siguiente modelo del carrusel.
- **Mantener presionado**: aparece un anillo de progreso real llenándose. Si
  soltás antes de ~0.9 segundos, se cancela y te quedás viendo el mismo
  modelo — nada cambia.
- **Mantener ~0.9 segundos**: confirma. La pantalla pasa a "Preparando
  modelo..." con un spinner indeterminado (Ollama no expone un % real para
  cargar un modelo ya descargado a memoria, así que no se inventa uno) y el
  nombre del modelo abajo. Cuando termina, vuelve el personaje animado con
  el texto `Modelo "..." listo para contestar.` y el flujo normal sigue
  (botón para hablar).
- **Doble clic**: cancela y vuelve directo al reposo sin cambiar nada — la
  forma explícita de salir del menú.
- Si no se toca el botón por 20 segundos, el menú también se cierra solo y
  vuelve al reposo (red de seguridad si te alejás a mitad del menú).

El cambio de modelo (por voz directo o por el menú):
- Actualiza el modelo en memoria del proceso ya corriendo (no hace falta
  reiniciar `chatbot.service`).
- Se guarda en `OLLAMA_MODEL` dentro de `.env`, así sobrevive a un reinicio.
- Dispara un nuevo "keep-alive" para precargar el modelo elegido en Ollama.

**Solo modelos instalados:** al abrir el menú, `model-select-mode.ts` le
pregunta a Ollama (`ollama list`, vía `listOllamaModels()`) cuáles de
`MODEL_ALIASES` están realmente instalados y solo esos entran al carrusel —
si borraste un modelo con `ollama rm`, ya no aparece como opción (antes
había que acordarse de sacarlo de `MODEL_ALIASES` a mano). Si Ollama no
responde, se usa la lista completa como respaldo en vez de dejar el menú
vacío.

## Cambiar de modo (agente / local)

Además del modelo local, el dispositivo puede correr en dos modos — ver
[`agent-mode.md`](./agent-mode.md) para el diseño completo:

| Modo | Qué hace |
|---|---|
| **Modo local** | Contesta con el proveedor de `LLM_SERVER` (Ollama, por defecto). Es el modo normal. |
| **Modo agente** | Manda lo que se dice a un OpenClaw externo por el bridge `whisplay-im`, y contesta lo que ese agente responda (con tool calls, aprobaciones, etc.). |

**Para abrir el menú visual:** "activa modo agente" o "modo agente" lo abre
pre-posicionado en "Modo agente (OpenClaw)". "activa modo local", "modo
local" o "desactiva modo agente" lo abre pre-posicionado en "Modo local". Un
"cambiar modo" genérico (sin decir cuál) lo abre en el modo que ya está
activo.

**A diferencia del modelo, no hay atajo de voz directo** — decir "modo
agente" nunca cambia el modo por sí solo, siempre pasa por el mismo menú
visual de abajo con el mantené-presionado-para-confirmar. Cambiar a modo agente
significa que todo lo que se dice sale del dispositivo hacia un proceso
externo; vale la confirmación explícita con el botón.

### Menú visual

Mismo mecanismo y misma tarjeta que el selector de modelo (ver arriba):
click corto pasa entre "Modo agente" / "Modo local" (cada uno con su
descripción de una línea), mantener ~0.9 segundos confirma (con
"● Activo" en el que está corriendo), doble clic cancela, 20 segundos sin
tocar el botón cierra el menú solo. El título de la tarjeta dice "MODO" en
vez de "MODELO" — es la principal seña visual de que estás en un menú
distinto (ver [`display-ui.md`](./display-ui.md)).

El cambio se guarda en `DEVICE_MODE` dentro de `.env`, así sobrevive a un
reinicio — igual que el cambio de modelo se guarda en `OLLAMA_MODEL`.

## Pantalla de ayuda

Decir **"ayuda"** (manteniendo presionado el botón, como cualquier otro
comando de voz) o elegir "Ayuda" en el [menú rápido](#menú-rápido) abre un
resumen de comandos de a lo sumo **2 pantallas** — etiqueta + frase por
comando, en dos tonos (etiqueta clara, frase apagada).

- **Click corto**: pasa a la otra página (son solo 2, así que alterna entre
  ambas).
- **Mantener ~0.9 segundos**: sale y vuelve a la pantalla normal de Akbal —
  no hay una pantalla "SALIR" separada, mantener el botón *es* la salida,
  igual que confirmar en cualquier otro menú.
- **Doble clic**: sale directo en cualquier momento.
- Si no se toca el botón por 20 segundos, la ayuda se cierra sola (mismo
  mecanismo que el resto de los menús).

El contenido se define en el array `HELP_ENTRIES` de
`app/src/core/chat-flow/help-mode.ts` — a lo sumo `ENTRIES_PER_PAGE * 2`
entradas (hoy 3×2=6) para no pasarse de las 2 pantallas; para agregar o
cambiar una línea, editarlo ahí (hay una nota sobre cuánto puede medir cada
línea sin desbordar la pantalla), recompilar (`npm run build`) y reiniciar
`chatbot.service`.

## Si se agrega o se borra un modelo con `ollama pull` / `ollama rm`

Editar el array `MODEL_ALIASES` en `voice-commands.ts` (nombre corto,
sinónimos que dispara el reconocimiento, tag exacto de `ollama list`, y una
etiqueta corta para la respuesta hablada), recompilar (`npm run build`) y
reiniciar `chatbot.service`.
