# Setup de Akbal en la Raspberry Pi

Registro de cómo se dejó corriendo la primera versión completa del sistema, sobre
Raspberry Pi OS 64-bit (Debian Trixie), conectando por SSH al hostname Tailscale
`akbal-pi.ocicat-gecko.ts.net`.

## Stack elegido (100% local, sin APIs de pago)

| Función | Software | Notas |
|---|---|---|
| LLM | [Ollama](https://ollama.com) + `qwen3:1.7b` (Q4_K_M) | Corre en CPU, ~1.4GB en disco. `ENABLE_THINKING=false` para respuestas rápidas. |
| ASR (voz→texto) | [faster-whisper](https://github.com/SYSTRAN/faster-whisper), modelo `small` | `int8` en CPU, idioma fijo en español (`FASTER_WHISPER_LANGUAGE=es`). |
| TTS (texto→voz) | [Piper](https://github.com/OHF-Voice/piper1-gpl), voz `es_MX-claude-high` | Servido vía `piper-http` en `localhost:8805`. |
| Batería | [PiSugar Power Manager](https://github.com/PiSugar/pisugar-power-manager-rs) | Necesario para el PiSugar 3 Plus (lectura de batería en pantalla). |
| Orquestación | [whisplay-ai-chatbot](https://github.com/PiSugar/whisplay-ai-chatbot) | Clonado en `~/whisplay-ai-chatbot` en la Pi (no vive dentro de este repo). |

## Pasos realizados

1. **Driver del Whisplay HAT**: clonar `PiSugar/Whisplay`, correr `install_driver.sh`
   (auto-detecta Raspberry Pi, compila el módulo de kernel `snd-soc-whisplay-soundcard`
   e instala el overlay de device-tree).
2. **Bug de hardware encontrado y arreglado**: ver [`whisplay-audio-fix.md`](./whisplay-audio-fix.md).
   Sin este fix, la tarjeta de sonido nunca se registraba.
3. **Ollama**: instalado con el script oficial (`curl -fsSL https://ollama.com/install.sh | sh`),
   corre como servicio systemd. Modelo: `ollama pull qwen3:1.7b`.
4. **whisplay-ai-chatbot**: clonado, `bash install_dependencies.sh` (Node 20 vía apt,
   dependencias Python del proyecto, SPI habilitado). `yarn` falló por permisos
   globales de npm; el script cae automáticamente a `npm` sin problema.
5. **faster-whisper y Piper**: instalados aparte con
   `pip install faster-whisper 'piper-tts[http]' --break-system-packages`
   (no vienen en `python/requirements.txt` del proyecto, son opcionales según el
   backend de ASR/TTS elegido). Voz de Piper descargada con
   `python3 -m piper.download_voices es_MX-claude-high`.
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

## Estado verificado

- Tarjeta de sonido `whisplaysound` (WM8960) con playback y captura funcionando.
- `chatbot.service` activo y con `Restart=always`.
- Ollama, faster-whisper (puerto 8803) y Piper HTTP (puerto 8805) arrancan como
  subprocesos del propio chatbot.
- PiSugar conectado (batería visible en pantalla).

## Pendiente / posibles siguientes pasos

- Probar el flujo completo de voz (botón → grabar → responder) con el hardware físico.
- Evaluar si el modelo `small` de faster-whisper es lo bastante rápido en uso real;
  bajar a `base`/`tiny` si la latencia molesta.
- Wake word (activación por voz sin botón) — ver wiki de whisplay-ai-chatbot.
- Decidir si conviene pasar a modo headless (`startup.sh` puede rehacerse para
  deshabilitar la GUI).
