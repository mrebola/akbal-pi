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

## Estructura del repo

- [`app/`](app/) — código de la aplicación que corre en la Pi (fork de trabajo de
  `whisplay-ai-chatbot`, con nuestros fixes aplicados). Se despliega copiando esta
  carpeta a `~/whisplay-ai-chatbot` en el dispositivo y siguiendo `docs/SETUP.md`.
  No incluye `.env` (usar `app/.env.template` o `setup/akbal.env.example` como base),
  `node_modules`, `dist` ni datos de runtime — todo eso se genera/instala en el
  propio dispositivo.
- [`docs/`](docs/) — bitácora de instalación y fixes encontrados en el camino.
- [`setup/`](setup/) — patches aplicados y `.env` de referencia (sin secretos).

## Estado

Primera versión completa corriendo en la Raspberry Pi, con flujo de voz de punta a
punta probado en el hardware físico (botón → graba → transcribe → responde → se
escucha): driver de audio del Whisplay HAT, LLM/ASR/TTS locales, batería PiSugar, y
el chatbot como servicio systemd (`chatbot.service`, arranque automático). Ver
[`docs/SETUP.md`](docs/SETUP.md) para el detalle, y
[`docs/whisplay-audio-fix.md`](docs/whisplay-audio-fix.md) /
[`docs/piper-tts-silent-fix.md`](docs/piper-tts-silent-fix.md) para los bugs de
hardware/software que se encontraron y arreglaron durante la instalación.

Pendiente: wake word (activación por voz sin botón).

## Notas de seguridad

Este repositorio es público. No se deben commitear credenciales, tokens, claves de API ni ningún otro dato sensible. Usar variables de entorno o archivos ignorados por git (`.gitignore`) para configuración local.
