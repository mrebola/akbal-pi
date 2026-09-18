# Comandos de voz (volumen, modelo y modo)

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

El volumen inicial al prender el dispositivo es **60%** por defecto
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

Con la pantalla en modo selección (fondo negro, texto verde estilo terminal):

- **Click corto**: pasa al siguiente modelo del carrusel (se ve el nombre,
  `[ACTIVO]` si es el que está corriendo, y puntitos de paginación `●○○○○○`).
- **Mantener presionado**: aparece una barra de progreso llenándose. Si
  soltás antes de 3 segundos, se cancela y te quedás viendo el mismo modelo
  — nada cambia.
- **Mantener 3 segundos**: confirma. La pantalla pasa a "CARGANDO MODELO" con
  una barra y el porcentaje de carga, y el nombre del modelo abajo. Cuando
  termina, vuelve el personaje animado con el texto `Modelo "..." listo para
  contestar.` y el flujo normal sigue (botón para hablar).
- **Doble clic**: cancela y vuelve directo al reposo sin cambiar nada — la
  forma explícita de salir del menú.
- Si no se toca el botón por 20 segundos, el menú también se cierra solo y
  vuelve al reposo (red de seguridad si te alejás a mitad del menú).

El cambio de modelo (por voz directo o por el menú):
- Actualiza el modelo en memoria del proceso ya corriendo (no hace falta
  reiniciar `chatbot.service`).
- Se guarda en `OLLAMA_MODEL` dentro de `.env`, así sobrevive a un reinicio.
- Dispara un nuevo "keep-alive" para precargar el modelo elegido en Ollama;
  la pantalla de carga simula el progreso (Ollama no expone un % real para
  cargar un modelo ya descargado a memoria, solo para descargas) pero nunca
  llega a 100% hasta que Ollama confirma que el modelo respondió.

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
visual de abajo con el mantené-presionado-3-segundos. Cambiar a modo agente
significa que todo lo que se dice sale del dispositivo hacia un proceso
externo; vale la confirmación explícita con el botón.

### Menú visual

Mismo mecanismo que el selector de modelo (ver arriba): click corto pasa
entre "Modo agente (OpenClaw)" / "Modo local", mantener 3 segundos confirma
(con `[ACTIVO]` en el que está corriendo), doble clic cancela, 20 segundos
sin tocar el botón cierra el menú solo.

El cambio se guarda en `DEVICE_MODE` dentro de `.env`, así sobrevive a un
reinicio — igual que el cambio de modelo se guarda en `OLLAMA_MODEL`.

## Si se agrega o se borra un modelo con `ollama pull` / `ollama rm`

Editar el array `MODEL_ALIASES` en `voice-commands.ts` (nombre corto,
sinónimos que dispara el reconocimiento, tag exacto de `ollama list`, y una
etiqueta corta para la respuesta hablada), recompilar (`npm run build`) y
reiniciar `chatbot.service`.
