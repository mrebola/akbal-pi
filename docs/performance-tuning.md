# Optimización de velocidad (ASR/LLM/TTS)

Un video sobre optimizar un asistente de voz en Raspberry Pi 5 sugería tres
cambios: (1) servir el ASR como proceso HTTP persistente en vez de cargar el
modelo por request, (2) mantener el LLM "caliente" en memoria, y (3) servir el
TTS como proceso HTTP persistente también. Investigamos cuáles de esos tres ya
aplicaban a nuestro setup y cuáles no.

## Qué ya teníamos resuelto

`whisplay-ai-chatbot` ya implementa las tres cosas de fábrica:

1. **ASR persistente**: `faster-whisper-host.py` es un servidor Flask que carga
   el modelo una sola vez al arrancar el chatbot y queda escuchando en
   `localhost:8803`; cada transcripción es solo un POST HTTP, no un proceso
   nuevo. Ver `app/python/speech-service/faster-whisper-host.py`.
2. **LLM caliente**: `ollama-llm.ts` hace un request de "calentamiento" al
   arrancar (`keep_alive: -1`) y todas las llamadas de chat también mandan
   `keep_alive: -1`, así que Ollama nunca descarga el modelo de memoria entre
   respuestas. Ver `app/src/cloud-api/local/ollama-llm.ts`.
3. **TTS persistente**: `piper-http-tts.ts` levanta
   `python3 -m piper.http_server` una sola vez al arrancar el chatbot; cada
   síntesis es un POST a ese servidor ya corriendo. Medido en producción:
   **350–405ms** por frase, ya mejor que el benchmark del video (~500ms).

O sea: la arquitectura de "servicios persistentes" que proponía el video ya
viene así en el proyecto base — no hubo que cambiar nada ahí.

## Lo que sí era un cuello de botella: el modelo de ASR

Medido en producción, el ASR tardaba **~5.2 segundos** en transcribir un audio
de ~2.9 segundos (peor que tiempo real). Eso no tenía que ver con la
arquitectura (ya era un servidor persistente), sino con la elección de modelo
y parámetros de decodificación.

### Benchmark (mismo audio de prueba, Raspberry Pi 5, CPU, `int8`)

| Modelo | `beam_size=1` | `beam_size=5` (default) |
|---|---|---|
| `small` (el que usábamos) | 5.22s | 5.79s |
| `base` | 1.74s | 1.97s |
| `tiny` | 0.95s | 1.09s |

Conclusiones:

- **`beam_size` casi no importa** en este hardware (diferencia de ~0.1–0.5s).
  No es el cuello de botella que uno esperaría; se dejó en `1` de todas formas
  porque no cuesta nada y es marginalmente más rápido.
- **El tamaño del modelo sí importa, y mucho**: `small` es ~3x más lento que
  `base` y ~5x más lento que `tiny` en este CPU — no escala linealmente con el
  tamaño del modelo, así que vale la pena medir en vez de asumir.

### Cambios aplicados

En `app/python/speech-service/faster-whisper-host.py`:

```diff
-  cpu_threads=3,   # Limit CPU threads for Pi
+  cpu_threads=4,   # Limit CPU threads for Pi
```

```diff
     segments, info = model.transcribe(
       audio_path,
       language=language,
-      vad_filter=True
+      vad_filter=True,
+      beam_size=1
     )
```

Y en `.env`: `FASTER_WHISPER_MODEL_SIZE_OR_PATH` de `small` a `base`.

### Resultado end-to-end (servidor real, mismo audio de prueba)

| | Antes (`small`) | Después (`base`) |
|---|---|---|
| Tiempo de transcripción | ~5.2s | ~1.8s |

~3x más rápido, en línea con lo que reportaba el video (~1.5s), sin hardware
adicional.

## Nota sobre el trade-off

`base` es menos preciso que `small` para español, especialmente con acentos,
ruido de fondo o frases largas. Si la precisión baja demasiado en uso real,
las opciones son (de más a menos rápido): `tiny` < `base` < `small`. Cambiar
solo requiere editar `FASTER_WHISPER_MODEL_SIZE_OR_PATH` en `.env` y reiniciar
`chatbot.service` (descarga el modelo nuevo automáticamente la primera vez).
