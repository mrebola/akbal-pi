# Selección de voz de Piper (con verificación real, no por el nombre)

El nombre de una voz de Piper (`ald`, `davefx`, `carlfm`, `claude`...) no es
garantía de género — son nombres de datasets/hablantes y a veces ni siquiera
corresponden a una persona real. Para no adivinar, medimos la frecuencia
fundamental (F0) real de cada muestra sintetizada: la voz humana masculina
típica cae en ~85–180 Hz, la femenina típica en ~165–255 Hz (hay solape, pero
sirve como señal fuerte).

## Metodología

1. Descargar la voz: `python3 -m piper.download_voices <voz>`
2. Sintetizar una frase de prueba con el CLI de Piper (sin tocar el servicio
   en producción):
   ```bash
   echo "Hola, esta es una prueba de voz." | piper --model ~/piper/<voz>.onnx --output_file /tmp/test.wav
   ```
3. Estimar F0 por autocorrelación (script en
   [`../setup/estimate-f0.py`](../setup/estimate-f0.py)):
   ```bash
   python3 setup/estimate-f0.py /tmp/test.wav
   ```
4. Solo después de confirmar género y calidad, escuchar por el altavoz real
   (`sox ... | aplay -D playback ...`) y decidir.

## Voces probadas

| Voz | Región | Calidad | F0 medido | Veredicto |
|---|---|---|---|---|
| `es_MX-claude-high` | México | high | ~176 Hz | Ambiguo/agudo para "voz de hombre". Primera voz usada. |
| `es_MX-ald-medium` | México | medium | ~166 Hz | Confirmado hombre por el dataset (`Speaker: Aldo`), pero F0 alto y feedback real: **"la voz es mala"**. |
| `es_ES-carlfm-x_low` | España | x_low (16kHz) | ~127 Hz | Masculino claro, pero calidad muy baja/robótica (descartada). |
| `es_ES-davefx-medium` | España | medium | ~118 Hz | **La que usamos.** Masculino claro y buena calidad. |

## Voz actual

```
PIPER_HTTP_MODEL=/home/akbal/piper/es_ES-davefx-medium
```

## Si se quiere probar otra voz

1. Buscar candidatas: `curl -s https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json | jq 'keys[] | select(startswith("es_"))'`
2. Repetir la metodología de arriba antes de asumir nada por el nombre.
3. Cambiar `PIPER_HTTP_MODEL` en `.env` y `sudo systemctl restart chatbot.service`.
