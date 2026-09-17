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

## Estado

Proyecto en etapa inicial. Próximos pasos: montar el hardware, flashear el OS, y adaptar el chatbot de referencia (whisplay-ai-chatbot) para correr como asistente local en la Pi.

## Notas de seguridad

Este repositorio es público. No se deben commitear credenciales, tokens, claves de API ni ningún otro dato sensible. Usar variables de entorno o archivos ignorados por git (`.gitignore`) para configuración local.
