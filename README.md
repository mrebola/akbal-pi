# akbal-pi

**Akbal** es un asistente de IA local que corre sobre una Raspberry Pi 5, sin depender de servicios en la nube para su funcionamiento principal.

El proyecto toma como base el repositorio [PiSugar/whisplay-ai-chatbot](https://github.com/PiSugar/whisplay-ai-chatbot), adaptándolo y extendiéndolo sobre el hardware descrito abajo.

## Hardware

| Cant. | Componente | Enlace |
|---|---|---|
| 1 | Raspberry Pi 5 8GB, 2.4GHz, 64-bit Quad Core Arm Cortex-A76 | https://link.amazon/B03bybrSv |
| 1 | Enfriador activo oficial para Raspberry Pi 5 | https://link.amazon/B0ayM2bge |
| 1 | PiSugar 3 Plus, 5000mAh / 18.5Wh (batería + UPS) | https://link.amazon/B06tTp9WF |
| 1 | Whisplay HAT (placa de expansión de audio + display) | https://link.amazon/B01MuBxtv |
| 1 | SanDisk Extreme PRO 64GB U3/V30 (microSD) | https://link.amazon/B083nCjU0 |

## Sistema operativo

Raspberry Pi OS 64-bit, basado en Debian Trixie.

## Stack de software (100% local)

| Función | Software |
|---|---|
| LLM | [Ollama](https://ollama.com) con `qwen3:1.7b` |
| Voz→texto (ASR) | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (modelo `small`, español) |
| Texto→voz (TTS) | [Piper](https://github.com/OHF-Voice/piper1-gpl) (voz `es_MX-claude-high`) |
| Batería | [PiSugar Power Manager](https://github.com/PiSugar/pisugar-power-manager-rs) |
| Orquestación | [whisplay-ai-chatbot](https://github.com/PiSugar/whisplay-ai-chatbot) |

Detalle completo del setup en [`docs/SETUP.md`](docs/SETUP.md).

## Estado

Primera versión completa corriendo en la Raspberry Pi: driver de audio del Whisplay
HAT, LLM/ASR/TTS locales, batería PiSugar, y el chatbot como servicio systemd
(`chatbot.service`, arranque automático). Ver [`docs/SETUP.md`](docs/SETUP.md) para
el detalle y [`docs/whisplay-audio-fix.md`](docs/whisplay-audio-fix.md) para un bug
de hardware que se encontró y arregló durante la instalación.

Pendiente: probar el flujo de voz completo con el hardware físico (botón, mic,
altavoz) y evaluar wake word.

## Notas de seguridad

Este repositorio es público. No se deben commitear credenciales, tokens, claves de API ni ningún otro dato sensible. Usar variables de entorno o archivos ignorados por git (`.gitignore`) para configuración local.
