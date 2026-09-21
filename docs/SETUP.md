# Setup de Akbal en la Raspberry Pi

Registro de cómo se dejó corriendo la primera versión completa del sistema, sobre
Raspberry Pi OS 64-bit (Debian Trixie), conectando por SSH al hostname Tailscale
`akbal-pi.ocicat-gecko.ts.net`.

## Stack elegido (100% local, sin APIs de pago)

| Función | Software | Notas |
|---|---|---|
| LLM | [Ollama](https://ollama.com) + `huihui_ai/qwen3.5-abliterated:2B` | Corre en CPU, ~1.9GB en disco, ~9 tok/s. `ENABLE_THINKING=false` para respuestas rápidas. Ver [`llm-model-selection.md`](./llm-model-selection.md) para por qué se cambió del `qwen3:1.7b` original y qué otro modelo se descartó. |
| ASR (voz→texto) | [faster-whisper](https://github.com/SYSTRAN/faster-whisper), modelo `base` | `int8` en CPU, `beam_size=1`, idioma fijo en español (`FASTER_WHISPER_LANGUAGE=es`). ~1.8s por transcripción, ver [`performance-tuning.md`](./performance-tuning.md). |
| TTS (texto→voz) | [Piper](https://github.com/OHF-Voice/piper1-gpl), voz `es_ES-davefx-medium` (hombre, español de España) | Servido vía `piper-http` en `localhost:8805`. Ver [`piper-voice-selection.md`](./piper-voice-selection.md) para cómo se eligió. |
| Batería | [PiSugar Power Manager](https://github.com/PiSugar/pisugar-power-manager-rs) | Necesario para el PiSugar 3 Plus (lectura de batería en pantalla). |
| Orquestación | [whisplay-ai-chatbot](https://github.com/PiSugar/whisplay-ai-chatbot) | Clonado en `~/whisplay-ai-chatbot` en la Pi (no vive dentro de este repo). |
| Pantalla | UI propia en `python/chatbot-ui.py` | Minimalista: video de personaje a pantalla completa + 2 líneas de texto. Ver [`display-ui.md`](./display-ui.md). |

## Pasos realizados

1. **Driver del Whisplay HAT**: clonar `PiSugar/Whisplay`, correr `install_driver.sh`
   (auto-detecta Raspberry Pi, compila el módulo de kernel `snd-soc-whisplay-soundcard`
   e instala el overlay de device-tree).
2. **Bug de hardware encontrado y arreglado**: ver [`whisplay-audio-fix.md`](./whisplay-audio-fix.md).
   Sin este fix, la tarjeta de sonido nunca se registraba. Tiene dos partes:
   el overlay con el códec ES8389 deshabilitado (patch en `setup/`), y —la
   causa raíz real, encontrada después— aislar con cinta los pogo-pins de
   SDA/SCL (pines 3 y 5) de la PiSugar 3, cuyo MCU corrompe el bus I2C
   compartido con el WM8960 del HAT.
3. **Ollama**: instalado con el script oficial (`curl -fsSL https://ollama.com/install.sh | sh`),
   corre como servicio systemd. Modelo: `ollama pull qwen3:1.7b`.
4. **whisplay-ai-chatbot**: clonado, `bash install_dependencies.sh` (Node 20 vía apt,
   dependencias Python del proyecto, SPI habilitado). `yarn` falló por permisos
   globales de npm; el script cae automáticamente a `npm` sin problema.
5. **faster-whisper y Piper**: instalados aparte con
   `pip install faster-whisper 'piper-tts[http]' --break-system-packages`
   (no vienen en `python/requirements.txt` del proyecto, son opcionales según el
   backend de ASR/TTS elegido). Voz de Piper descargada con
   `python3 -m piper.download_voices es_ES-davefx-medium` (voz de hombre,
   español de España; ver [`piper-voice-selection.md`](./piper-voice-selection.md)
   para cómo se eligió y otras opciones probadas).
6. **PiSugar Power Manager**: instalado con el script oficial de PiSugar para que
   el chatbot pueda leer el nivel de batería (puerto TCP 8423).
7. **Configuración**: `.env` armado a partir de `.env.template` — ver
   [`setup/akbal.env.example`](../setup/akbal.env.example) para las variables
   relevantes (el resto se deja en default/comentado).
8. **Build y servicio**: `bash build.sh` (compila TypeScript), luego
   `bash startup.sh` para crear `chatbot.service` (systemd, arranque automático,
   logs en `~/whisplay-ai-chatbot/chatbot.log`). Se optó por **no** deshabilitar
   la interfaz gráfica de la Pi (el script lo ofrece); el servicio corre igual
   sobre `graphical.target`.

9. **Bug de software encontrado y arreglado**: el flujo de voz completo (ASR → LLM)
   funcionaba pero no se escuchaba la respuesta. Ver
   [`piper-tts-silent-fix.md`](./piper-tts-silent-fix.md) — el cliente de Piper HTTP
   del chatbot le pega a la URL equivocada del servidor de síntesis.
10. **Optimización de velocidad del ASR**: el modelo `small` tardaba ~5.2s en
    transcribir un audio de ~2.9s (peor que tiempo real). Se bajó a `base` y se
    ajustaron `beam_size`/`cpu_threads`, quedando en ~1.8s (~3x más rápido). El
    LLM (Ollama) y el TTS (Piper) ya corrían como servicios HTTP persistentes de
    fábrica en `whisplay-ai-chatbot`, así que no necesitaron cambios. Detalle
    completo en [`performance-tuning.md`](./performance-tuning.md).
11. **Cambio de voz (1)**: se reemplazó `es_MX-claude-high` por `es_MX-ald-medium`
    a pedido (voz de hombre en español de México). Confirmado por el dataset de
    entrenamiento (`Speaker: Aldo`), no por el nombre de la voz.
12. **Cambio de voz (2)**: feedback real fue que `es_MX-ald-medium` sonaba mal.
    Se probaron varias voces midiendo la frecuencia fundamental (F0) real de
    cada una en vez de adivinar por el nombre, y se cambió a
    `es_ES-davefx-medium` (hombre, español de España, F0 ~118 Hz, calidad
    `medium`). Metodología completa, mediciones y todas las voces probadas en
    [`piper-voice-selection.md`](./piper-voice-selection.md).
13. **Rediseño de la interfaz de pantalla**: se reemplazó el header con
    emoji/batería/wifi y el texto con scroll por una interfaz minimalista:
    un personaje animado (GIF, generado a partir de dos videos cortos) a
    pantalla completa, con hasta 2 líneas de texto en verde estilo terminal
    abajo. `standing.gif` en reposo, `talking.gif` mientras responde. Detalle
    completo, cómo se generaron los GIFs y cómo reemplazarlos en
    [`display-ui.md`](./display-ui.md).
14. **Ajuste de la interfaz**: se recuperaron los íconos de wifi y batería
    (franja delgada arriba, sin texto de estado ni emoji) y se recortaron los
    GIFs para que la cara del personaje se vea más grande y en primer plano,
    con mucho menos cuerpo visible (`crop=490:400:75:0` en vez del recorte
    original). Verificado cuadro por cuadro en ambos videos para que la
    cabeza no se salga de encuadre. Detalle en
    [`display-ui.md`](./display-ui.md).
15. **Fix de los íconos de wifi/batería**: `WifiStatusIcon.measure()` reportaba
    el tamaño del ícono sin escalar mientras que `render()` sí lo dibujaba
    escalado (1.4x), lo que desalineaba el ancho reservado para cada ícono en
    la barra superior. Se corrigió para que `measure()` refleje el tamaño real
    del bitmap ya escalado. Además, el borde derecho del panel físico queda
    tapado por el bisel de la carcasa (~10% del ancho), así que el clúster de
    íconos se corrió esa misma proporción hacia la izquierda
    (`SAFE_AREA_RIGHT_INSET_PCT` en `chatbot-ui.py`, luego generalizado a
    safe-area global de toda la interfaz) para que se vean completos.
16. **Cambio de modelo LLM**: se probó `hf.co/mradermacher/Qwen3.5-4B-Uncensored-GGUF:Q4_K_M`
    y se descartó (muy lento y no cortaba la generación); se adoptó
    `huihui_ai/qwen3.5-abliterated:2B` en su lugar. Detalle completo,
    benchmarks y metodología en [`llm-model-selection.md`](./llm-model-selection.md).
17. **Comandos de voz (volumen y modelo)**: se probó primero el tool-calling
    nativo de Ollama y se descartó (misma razón que arriba: manda todas las
    herramientas en cada request, ~15x más lento en *toda* la conversación).
    Se implementó en su lugar un matcher por expresiones regulares que
    intercepta el texto del ASR antes de llegar al LLM, en
    `src/core/chat-flow/voice-commands.ts`. Detalle completo, ejemplos de
    frases y menú de modelos en [`voice-commands.md`](./voice-commands.md).

## Estado verificado

- Tarjeta de sonido `whisplaysound` (WM8960) con playback y captura funcionando.
- `chatbot.service` activo y con `Restart=always`.
- Ollama, faster-whisper (puerto 8803) y Piper HTTP (puerto 8805) arrancan como
  subprocesos del propio chatbot.
- PiSugar conectado (batería visible en pantalla).
- Flujo de voz completo probado con el hardware físico: botón → graba → transcribe
  → responde → se escucha por el altavoz. `INITIAL_VOLUME_PERCENT=90` fijado en
  `.env` para que no se resetee a 80% en cada reinicio del servicio.
- Interfaz de pantalla minimalista (video + texto) probada en vivo en el
  hardware físico durante un ciclo completo (botón → escuchar → responder →
  reposo), sin errores.

## Pendiente / posibles siguientes pasos

- Wake word (activación por voz sin botón) — ver wiki de whisplay-ai-chatbot.
- Decidir si conviene pasar a modo headless (`startup.sh` puede rehacerse para
  deshabilitar la GUI).
