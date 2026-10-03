# AGENTS.md — Guía para agentes de código (y humanos)

> Este archivo va para agentes de IA que trabajen en este repo. Mantener
> actualizado ante cambios arquitectónicos.

## Qué es este repo

**akbal-pi** es una plataforma de IA 100% local sobre Raspberry Pi 5,
enfocada en ciberseguridad: voz (presionar botón → hablar → respuesta
hablada) y chat de texto con tool-calling real sobre el propio equipo,
pantalla LCD con personaje animado, batería PiSugar, y un admin web en la
LAN/Tailnet desde donde se opera todo — WiFi Radar 3D, un laboratorio de
auditoría WiFi (handshakes, allowlist, ataques dirigidos), wardrive
(captura en movimiento + GPS), radar de aeronaves por ADS-B, y metadata
GNSS.

Nació como fork de trabajo de
[`PiSugar/whisplay-ai-chatbot`](https://github.com/PiSugar/whisplay-ai-chatbot)
(todavía su base para el chat por voz/LCD/plugins), pero ya es mucho más
que eso: un proyecto de autoaprendizaje sobre hasta dónde llega una IA local
sin bloqueos artificiales combinada con ciberseguridad real. El nombre
viene de Akbal, personaje de *Cypher404: El Manifiesto* (libro de César
Gaytán, autor también de este repo) — panorama completo, por qué existe el
proyecto y dónde conseguir el libro en [`README.md`](README.md).

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
│   │   ├── wifi-audit/    # Captura de handshakes de laboratorio (allowlist, ataques dirigidos)
│   │   ├── wardrive/      # Captura mientras se conduce (mapa + GPS + deauth oportunista)
│   │   ├── services/      # adsb/ (Aircraft Radar) y gnss/ (metadata de satélites GNSS)
│   │   ├── config/        # Tools del LLM: admin-tools/ (chat web) vs llm-tools.ts (voz)
│   │   └── utils/         # wifi (nmcli), usb, system-stats, volume
│   ├── python/            # Interfaz de hardware (GPIO/SPI/LCD, socket 12345)
│   ├── web/               # Frontends estáticos sin build: admin/ (+ i18n/) y whisplay-display/
│   ├── soul/              # Identidad editable de Akbal (soul.md) — ver app/AGENTS.md
│   ├── knowledge/         # Self-knowledge para el RAG (akbal-*.md) — ver app/AGENTS.md
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

## Deploy / actualizar el dispositivo real

Detalle completo en [`docs/deploy.md`](docs/deploy.md) — resumen para no
tener que abrirlo si solo hace falta actualizar código ya desplegado:

```bash
ssh <usuario>@<host-de-la-pi>
whisplay update           # git pull --ff-only + install_dependencies.sh + build
whisplay service restart
```

Puntos que un agente nuevo necesita saber antes de tocar esto:

- El dispositivo corre desde un **clon real de este repo** (no una copia
  por rsync) — `app/` es el `WorkingDirectory` del `chatbot.service`, pero
  la raíz del `.git` está un nivel arriba (`~/akbal-pi`, no
  `~/akbal-pi/app`). `whisplay update` ya sabe resolver esto solo
  (`resolve_update_git_root` en `app/cli/common.sh`) — no asumas que
  `app/` tiene su propio `.git`.
- `whisplay update` **no reinicia el servicio solo** — `whisplay service
  restart` (o `sudo systemctl restart chatbot.service`) es un paso aparte,
  a propósito (permite revisar que el build salió bien antes de tirar la
  sesión de voz/chat en curso).
- Si el dispositivo con el que estás trabajando todavía tiene una copia
  vieja por rsync (sin `.git`, típicamente en `~/whisplay-ai-chatbot/app`
  en vez de `~/akbal-pi/app`): no lo actualices con rsync de nuevo sin
  preguntar primero — `docs/deploy.md` tiene los pasos para migrarlo a un
  clon real sin perder `.env`/`data/`/`knowledge/`.
- Antes de cualquier cambio en un dispositivo real (rsync, `git pull`,
  reiniciar el servicio, tocar `chatbot.service`): confirmá que tenés
  acceso real (`ssh ... echo ok`) y avisá qué vas a hacer — es hardware de
  alguien corriendo en producción, no un sandbox descartable.

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