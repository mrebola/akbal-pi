# Fix: Akbal transcribía y respondía, pero no se escuchaba nada

## Síntoma

El flujo de voz funcionaba hasta el LLM: se escuchaba el ASR transcribir bien y el
LLM generar la respuesta (visible en `chatbot.log` y en pantalla), pero no salía
ningún audio por el altavoz, sin importar el volumen (probado incluso al 90%).

## Diagnóstico

En `chatbot.log` aparecía, para cada respuesta:

```
Sox process exited with code 2
Error processing Piper output: "..." Error: Sox process exited with code 2
[TTS] Empty audio result, retrying (1/1)...
...
No audio data to play, skipping playback.
```

O sea: no era un problema de volumen ni de la tarjeta de sonido — el TTS nunca
llegaba a generar un archivo de audio válido, así que no había nada que reproducir.

Reproduciendo a mano la llamada que hace `whisplay-ai-chatbot` al servidor HTTP de
Piper (`src/cloud-api/local/piper-http-tts.ts`):

```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{ "text": "prueba", "length_scale": 1 }' \
  -o test.wav localhost:8805
# -> HTTP 405 Method Not Allowed
```

El archivo resultante era una página HTML de error, no un WAV. `sox` fallaba
(exit code 2) al intentar convertir esa página HTML como si fuera audio, y como
el código no capturaba el stderr de `sox`, el log solo mostraba el código de
salida sin la razón real.

## Causa raíz

`piper-http-tts.ts` hace el POST a la raíz del servidor
(`http://localhost:8805`), pero el paquete `piper-tts` actual (el que se instala
hoy desde PyPI, usado por `python3 -m piper.http_server`) solo acepta peticiones
de síntesis en **`POST /synthesize`** — la raíz (`/`) es una página web de solo
lectura (`GET`). Es un desajuste de versión entre el cliente de
`whisplay-ai-chatbot` (escrito contra una versión más vieja de `piper-tts`, donde
la raíz sí aceptaba el POST) y el servidor que se instala ahora.

## Fix

Un cambio de una línea: agregar `/synthesize` a la URL. Ver el patch completo en
[`../setup/piper-http-synthesize-fix.patch`](../setup/piper-http-synthesize-fix.patch).

```diff
-      `${piperHttpHost}:${piperHttpPort}`
+      `${piperHttpHost}:${piperHttpPort}/synthesize`
```

Aplicado en `~/whisplay-ai-chatbot/src/cloud-api/local/piper-http-tts.ts` en la
Pi, seguido de `bash build.sh` y `sudo systemctl restart chatbot.service`.

De paso se fijó `INITIAL_VOLUME_PERCENT=90` en `.env` (antes no estaba seteado,
así que cada reinicio del servicio volvía el volumen a 80% por default,
independientemente de lo que se ajustara a mano con `alsamixer`/`amixer`).

## Nota para futuras actualizaciones

Si se actualiza `whisplay-ai-chatbot` desde el repo original (`git pull`), este
fix se pierde y hay que reaplicarlo (o abrir un PR/issue upstream — no se
reportó todavía).
