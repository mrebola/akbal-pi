# AGENTS.md — Guía para agentes de código (y humanos)

> Este archivo va para agentes de IA que trabajen en este repo. Mantener
> actualizado ante cambios arquitectónicos.

## Qué es este repo

**akbal-pi** es un asistente de IA 100% local sobre Raspberry Pi 5: voz
(presionar botón → hablar → respuesta hablada), pantalla LCD con personaje
animado, wifi, batería PiSugar, y un admin web en la LAN. Fork de trabajo de
[`PiSugar/whisplay-ai-chatbot`](https://github.com/PiSugar/whisplay-ai-chatbot)
con fixes propios.

**⚠️ REPO PÚBLICO EN GITHUB**: nunca commitear secretos, IPs reales de la LAN,
usuarios/hosts reales, contraseñas de wifi, ni logs con datos personales. Ver
"Checklist anti-secretos" más abajo.

## Estructura

```
akbal-pi/
├── README.md              # Guía de armado + instalación de punta a punta
├── app/                   # La app que corre en la Pi (ver app/AGENTS.md)
│   ├── src/               # TypeScript (Node.js 20+, build con tsc)
│   │   ├── core/          # ChatFlow + máquina de estados (chat-flow/)
│   │   ├── device/        # Hardware: audio, display, batería, web-admin
│   │   ├── cloud-api/     # Proveedores ASR/LLM/TTS (local/ = ollama, whisper, piper)
│   │   ├── wifiradar/     # Visualización WiFi 3D con AR9271 en modo monitor
│   │   └── utils/         # wifi (nmcli), usb, system-stats, volume
│   ├── python/            # Interfaz de hardware (GPIO/SPI/LCD, socket 12345)
│   ├── web/               # Frontends estáticos sin build: admin/ y whisplay-display/
│   ├── cli/               # CLI bash (bin/whisplay)
│   └── dist/              # Compilado (no commitear)
├── docs/                  # Bitácora: SETUP.md, fixes de hardware, decisiones
│                          # docs/lab-wireless.md = AP de pruebas dedicado
│                          # (SSID akbal_lab, red AUTORIZADA para auditoría)
└── setup/                 # Patches, env de referencia SIN secretos, videos fuente
```

Para el detalle interno de `app/` (plugin system, protocolo Node↔Python,
formato de display, comandos CLI) leer [`app/AGENTS.md`](app/AGENTS.md).

## Comandos de desarrollo

Todo se corre dentro de `app/`:

```bash
cd app
npm run build        # tsc: src/ → dist/  (verificar con: npx tsc --noEmit)
npm start            # node dist/index.js — solo corre en la Pi (necesita hardware)
```

No hay tests automatizados (`npm test` es placeholder); la validación real es
en el hardware. Desde el host solo se puede verificar compilación de
TypeScript y sintaxis de Python/bash.

## Convenciones

- **TypeScript**: ES2020, CommonJS, strict. Imports relativos dentro de `src/`.
  Archivos kebab-case, clases PascalCase. Comentarios en inglés, UI/strings de
  usuario en español.
- **Python**: PEP 8, prints con prefijos `[Server]`, `[Camera]`, etc.
- **Config**: todo por `.env` (nunca hardcodear valores de entorno). Nunca leer
  API keys de otro lado que no sea `process.env` / `ctx.env`.
- **Comentarios de código**: solo cuando aportan ("por qué", no "qué"). El
  código existente documenta decisiones de hardware con links a `docs/`.

## Checklist anti-secretos (obligatorio antes de cada commit)

Este repo es público. Antes de `git commit`:

1. **`.env` real**: nunca commitear. Solo `app/.env.template` y
   `setup/akbal.env.example` (placeholders, sin valores reales).
2. **IPs/MACs reales**: usar placeholders (`<ip-de-la-pi>`, `aa:bb:cc:dd:ee:ff`)
   o variables de entorno con default genérico. IPs `192.168.x.x`,
   `10.x.x.x`, `172.16-31.x.x` con valores reales de la LAN = no commitear.
3. **SSIDs / contraseñas de wifi** reales: no.
4. **Hostnames/usernames reales** de la red doméstica (ej. `ssh cesar@...`):
   usar placeholders.
5. **Tokens/keys**: buscar con
   `git diff | grep -inE 'key|token|secret|password'` antes de commit.
6. **`git status`**: revisar que no se estén agregando archivos de runtime
   (`chatbot.log`, `data/`, captures de wifiradar, dumps).

Si un secreto se subió por accidente: rotarlo inmediatamente (no basta con
borrar el commit) y avisar al owner del repo.