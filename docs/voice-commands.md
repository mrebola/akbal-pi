# Comandos de voz (volumen y modelo)

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

| Nombre corto | Modelo real | Cuándo usarlo |
|---|---|---|
| **uno** / one | `qwen3:1.7b` | El más rápido y estable. Fallback automático si algo falla. |
| **dos** / two | `huihui_ai/qwen3.5-abliterated:2B` | El que se usa por defecto ahora. |

El `Qwen3.5-4B-Uncensored-GGUF` probado y descartado (lento, no corta la
generación) **no** está en esta lista — no tiene sentido ofrecerlo como opción
de voz.

**Para pedir el menú:** decí algo como "qué modelos hay", "opciones de
modelo" o simplemente "cambiar modelo" (sin decir cuál) — el asistente
responde con los nombres cortos y cómo pedir el cambio.

**Para cambiar:** "cambia el modelo a uno", "cambia el modelo a dos", "usa el
modelo uno", "switch to model two". Hace falta decir la palabra
"modelo"/"model" + un verbo de cambio ("cambia", "usa", "pon", "switch",
"change"...) + el nombre corto.

**Si falla o no se entiende cuál pediste** (dijiste "modelo" + intención de
cambio pero el nombre no coincide con ninguno de la lista): el asistente dice
que no reconoció el modelo, **deja activado el modelo 1** (`qwen3:1.7b`, el
más estable) y repite el menú. También revisa contra `ollama list` en tiempo
real antes de cambiar — si el modelo pedido ya no está instalado, aplica el
mismo fallback.

El cambio de modelo:
- Actualiza el modelo en memoria del proceso ya corriendo (no hace falta
  reiniciar `chatbot.service`).
- Se guarda en `OLLAMA_MODEL` dentro de `.env`, así sobrevive a un reinicio.
- Dispara un nuevo "keep-alive" para precargar el modelo elegido en Ollama.

## Si se agrega o se borra un modelo con `ollama pull` / `ollama rm`

Editar el array `MODEL_ALIASES` en `voice-commands.ts` (nombre corto,
sinónimos que dispara el reconocimiento, tag exacto de `ollama list`, y una
etiqueta corta para la respuesta hablada), recompilar (`npm run build`) y
reiniciar `chatbot.service`.
