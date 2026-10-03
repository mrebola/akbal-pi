# akbal-pi (app/) — Agent Documentation

> **Note:** This file is intended for AI coding agents working inside `app/`.
> Please keep it updated when making architectural changes. For the project
> as a whole — why it exists, the *Cypher404: El Manifiesto* book it's named
> after, and the full docs index — see the root
> [`AGENTS.md`](../AGENTS.md) and [`README.md`](../README.md).

## Project Overview

**akbal-pi** is a 100% local AI platform for a Raspberry Pi 5, focused on
cybersecurity: voice (press button, speak, get a spoken reply) and a web
text chat, both backed by the same local LLM — but unlike a typical voice
assistant, this one also **understands and operates the device itself**.
`app/` (this directory) is the Node.js + Python application that runs on
the Pi. It's built on top of a forked `whisplay-ai-chatbot` base (still
its foundation for the voice/LCD/plugin plumbing) but has grown well past
it: WiFi Radar, Wifi Audit, Wardrive, Aircraft Radar, GNSS, the admin
web's tool-calling chat, and Akbal's editable identity are all specific to
this project, not the upstream fork.

**Key Capabilities:**
- Voice interaction (press button, speak, get spoken responses) and a web
  text chat — both hit the same local LLM (Ollama), and the web chat can
  call tools against the device's own live state (`config/admin-tools/`)
  and reply with deep links to the section it checked
- **WiFi Radar** (`wifiradar/`): passive 3D visualization of nearby access
  points/devices, real hardware or demo data
- **Wifi Audit** (`wifi-audit/`): lab handshake capture + dictionary/mask
  cracking, gated by an explicit BSSID allowlist — never network-wide,
  see `docs/lab-wireless.md`
- **Wardrive** (`wardrive/`): continuous capture while driving, GPS track,
  optional opportunistic deauth (off by default)
- **Aircraft Radar** (`services/adsb/`): nearby ADS-B traffic via a
  HackRF One
- **GNSS** (`services/gnss/`): offline-first satellite metadata
  (CelesTrak)
- Akbal's identity is editable, not hardcoded: a "soul file"
  (persona/system-prompt) plus self-knowledge for RAG — see "Akbal's
  identity and self-knowledge" further down
- Multi-provider ASR (Tencent, Volcengine, OpenAI, Gemini, Whisper, Vosk,
  local) / LLM (OpenAI, Gemini, Claude, Ollama, Qwen, Doubao, and more) /
  TTS (Google, Volcengine, Piper, espeak-ng, local) — inherited from the
  whisplay-ai-chatbot base; this deployment actually runs Ollama +
  faster-whisper + Piper, all local
- Image generation and vision understanding, RAG (Qdrant), wake word
  detection, plugin system for third-party extensions, web-based display
  simulation for development

## Technology Stack

### Core Technologies
| Component | Technology |
|-----------|------------|
| Main Runtime | Node.js 20 + TypeScript |
| Hardware Interface | Python 3 + RPi.GPIO / gpiod |
| UI Rendering | Python Pillow (PIL) + socket communication |
| Package Manager | yarn (preferred) or npm |
| Build Tool | TypeScript Compiler (tsc) |

### Key Dependencies
- **Web Framework**: Koa.js (HTTP server)
- **WebSocket**: ws (real-time communication)
- **AI SDKs**: @anthropic-ai/sdk, openai, @google/genai
- **Vector DB**: @qdrant/js-client-rest
- **Hardware**: spidev, onnxruntime-node
- **Audio**: get-audio-duration, mp3-duration

### Hardware Requirements
- Raspberry Pi Zero 2W or Pi 5 (8GB RAM recommended for offline)
- PiSugar Whisplay HAT (LCD 240x280, speaker, microphone, RGB LED, button)
- PiSugar 3 battery (1200mAh or 5000mAh for Pi 5)
- WM8960 audio codec

## Project Structure

```
whisplay-ai-chatbot/
├── src/                          # Main TypeScript source code
│   ├── index.ts                  # Application entry point
│   ├── index-knowledge.ts        # Knowledge base indexing tool
│   ├── configure-env.ts          # Interactive .env configuration tool
│   ├── upgrade-env.ts            # Environment upgrade tool
│   ├── cloud-api/                # AI service providers
│   │   ├── interface.ts          # Common provider interfaces
│   │   ├── server.ts             # Provider factory/dispatcher
│   │   ├── proxy-fetch.ts        # Proxy-aware fetch wrapper
│   │   ├── type.d.ts             # Shared type definitions
│   │   ├── openai/               # OpenAI ASR/LLM/TTS/Vision
│   │   ├── gemini/               # Google Gemini services
│   │   ├── volcengine/           # ByteDance VolcEngine
│   │   ├── tencent/              # Tencent Cloud
│   │   ├── local/                # Local/offline providers
│   │   │   ├── ollama-*.ts       # Ollama integration
│   │   │   ├── whisper-*.ts      # Whisper ASR variants
│   │   │   ├── piper-*.ts        # Piper TTS
│   │   │   └── llm8850*.ts       # LLM8850 accelerator
│   │   └── ...
│   ├── core/                     # Core business logic
│   │   ├── ChatFlow.ts           # Main chat flow controller
│   │   ├── StreamResponsor.ts    # Streaming response handler
│   │   ├── Knowledge.ts          # RAG knowledge management
│   │   └── chat-flow/            # State machine for chat flow
│   ├── device/                   # Hardware abstraction
│   │   ├── display.ts            # LCD display controller
│   │   ├── audio.ts              # Audio playback/recording
│   │   ├── battery.ts            # Battery monitoring
│   │   ├── wakeword.ts           # Wake word detection
│   │   ├── web-display.ts        # Web-based display sim
│   │   ├── web-admin-server.ts   # LAN chat + wifi admin UI (docs/web-ui.md)
│   │   └── ...
│   ├── wifiradar/                # WiFi Radar 3D: passive capture + aggregation (docs/wifiradar.md)
│   │   ├── capture.ts            # dumpcap|tshark pipeline → RawFrameEvent
│   │   ├── aggregator.ts         # in-memory state, events, pruning
│   │   ├── oui.ts                # vendor lookup: ieee-data → curated → macvendors API
│   │   ├── ar9271.ts             # dongle detection by kernel driver (ath9k_htc)
│   │   ├── monitor-control.ts    # in-place monitor mode + channel hopping
│   │   └── demo-mode.ts          # synthetic APs/devices for demo source
│   ├── wifi-audit/               # Lab handshake capture (docs/wifi-audit.md)
│   │                             #   (renombrado de wardrive/ — era el audit de lab)
│   │   ├── service.ts            # orchestrator: allowlist security boundary
│   │   ├── discovery.ts          # targets from radar snapshot / iw scan
│   │   ├── attack.ts             # airodump/aireplay/hcxdumptool runners
│   │   ├── crack.ts              # aircrack-ng handshake validation + rockyou dict crack
│   │   └── session.ts            # ~/wardrive-sessions persistence (incl. cracked passwords)
│   ├── wardrive/                 # Driving capture: mapa + handshakes en movimiento (docs/wardrive.md)
│   │   ├── service.ts            # orchestrator: sesión, hop, deauth oportunista, GPS, exportes
│   │   ├── capture.ts            # dumpcap(+ringbuffer)|tshark → beacons/EAPOL/deauth
│   │   ├── attack.ts             # hcxpcapngtool extractor + DeauthOpRunner (bursts cortos)
│   │   ├── drive-db.ts           # SQLite: redes vistas / handshakes / sesiones / tracks
│   │   └── types.ts              # DriveStatus, DriveApView, etc.
│   ├── services/adsb/            # Aircraft Radar: ADS-B via HackRF One (docs/aircraft-radar.md)
│   │   ├── hackrf-receiver.ts    # readsb --device-type hackrf process + SBS-1 TCP client
│   │   ├── sbs-parser.ts         # SBS-1/BaseStation CSV → RawAdsbMessage
│   │   ├── aircraft-tracker.ts   # in-memory state, GPS distance/bearing, history writes
│   │   ├── aircraft-database.ts  # ICAO24 → registration/model/operator (cache + adsbdb.com)
│   │   ├── flight-resolver.ts    # callsign → route (cache + adsbdb.com), "Route unknown"
│   │   ├── history.ts            # SQLite: aircraft_seen + lookup caches
│   │   ├── demo-mode.ts          # synthetic aircraft for demo source
│   │   └── service.ts            # orchestrator: live/demo fallback, shared singleton
│   ├── services/gnss/            # GNSS satellite metadata, offline-first (docs/gnss.md)
│   │   ├── celestrak.ts          # CelesTrak GP/OMM client (proxy-fetch, never throws)
│   │   ├── db.ts                 # SQLite: metadata permanente / datos orbitales / histórico
│   │   └── service.ts            # orchestrator: cache-first snapshot + refresh en background
│   ├── plugin/                   # Plugin system
│   │   ├── types.ts              # Plugin interface definitions
│   │   ├── registry.ts           # Plugin registry
│   │   ├── loader.ts             # External plugin loader
│   │   └── builtin*.ts           # Built-in provider plugins
│   ├── config/                   # Configuration modules
│   │   ├── llm-config.ts         # LLM configuration (incl. the soul-file-backed system prompt)
│   │   ├── llm-tools.ts          # Tool definitions for the VOICE flow
│   │   ├── custom-tools/         # Custom tool templates
│   │   ├── soul-files.ts         # Backs Settings > Soul — allowlisted soul/knowledge file read+write
│   │   └── admin-tools/          # Tool definitions for the WEB CHAT (separate registry — see below)
│   ├── utils/                    # Utility functions (incl. wifi.ts — nmcli wrapper, docs/wifi.md,
│   │                             #   gps.ts — USB GPS dongle NMEA reader, docs/gps.md)
│   └── type/                     # Global TypeScript types
├── python/                       # Python hardware interface
│   ├── whisplay.py               # Hardware board abstraction (GPIO, SPI, LCD)
│   ├── chatbot-ui.py             # UI rendering server (socket-based)
│   ├── camera.py                 # Camera module integration
│   ├── whisplay_client.py        # External Whisplay daemon detection/adaptation
│   ├── wakeword.py               # Wake word detection host
│   ├── utils.py                  # Python utilities
│   ├── speech-service/           # Speech recognition hosts
│   ├── status-bar-icon/          # UI icon renderers
│   └── test/                     # Hardware test scripts
├── web/                          # Static frontends (no build step)
│   ├── whisplay-display/         # Mirrors the physical screen for dev (WHISPLAY_WEB_ENABLED)
│   └── admin/                    # LAN chat + wifi admin UI (web-admin-server.ts, docs/web-ui.md)
│       ├── i18n.js               # Translation engine (ES/EN), shared by every admin page (docs/i18n.md)
│       ├── i18n/                 # es.json / en.json dictionaries
│       ├── about.html            # "Acerca de" page — Cypher404: El Manifiesto, buy-the-book QR
│       └── img/                  # cypher404-portada.jpg, cypher404-book-qr.png (served as static files)
├── soul/                         # Akbal's persona (soul.md) — see "identity" section below
├── knowledge/                    # Self-knowledge for RAG (akbal-*.md) — see "identity" section below
├── cli/                          # Bash CLI implementation
│   ├── commands.sh               # Main command dispatcher
│   ├── plugin.sh                 # Plugin management
│   ├── plugin-create.sh          # Plugin scaffolding
│   └── service.sh                # systemd service management
├── bin/whisplay                  # CLI entry point (bash)
├── docker/                       # Docker compose for local services
│   ├── docker-compose.yml        # Ollama, faster-whisper, piper
│   ├── faster-whisper-http/      # Faster Whisper HTTP server
│   └── piper-http/               # Piper TTS HTTP server
├── packaging/pi-gen/basic/       # GitHub Actions Raspberry Pi OS basic image customization
├── wiki/                         # Documentation (GitHub wiki)
├── data/                         # Runtime data (recordings, images, knowledge)
└── patches/                      # patch-package patches
```

## Build and Development Commands

### Initial Setup
```bash
# Install all dependencies (Node.js, Python, fonts)
bash install_dependencies.sh

# Create environment file
cp .env.template .env
# Edit .env with your API keys and configuration
```

### Build Commands
```bash
# Build TypeScript (compiles src/ to dist/)
npm run build
# or
yarn build

# Full rebuild with dependencies
bash build.sh

# CI image build inputs
# See packaging/pi-gen/basic/ for the basic Raspberry Pi OS release image customization
```

### Run Commands
```bash
# Start the chatbot service
bash run_chatbot.sh

# Start with npm/yarn directly (after build)
npm start
# or
yarn start
```

### CLI Commands
The `whisplay` CLI is installed to `/usr/local/bin/whisplay` during setup:

```bash
# Plugin management
whisplay plugin create                    # Create new plugin from template
whisplay plugin install <github-url>      # Install plugin from GitHub
whisplay plugin remove <plugin-name>      # Remove installed plugin
whisplay plugin list                      # List installed plugins
whisplay plugin update <name|--all>       # Update plugin(s)

# Service management
whisplay service install                  # Install systemd service
whisplay service uninstall                # Remove systemd service
whisplay service start|stop|restart       # Control service
whisplay service status                   # Check service status

# Utilities
whisplay update                           # Pull latest code, install deps, build
whisplay configure                        # Interactively manage .env by category
whisplay index-knowledge                  # Index knowledge base
whisplay upgrade-env                      # Upgrade .env to latest template
whisplay help                             # Show help
```

### Knowledge Base Indexing
```bash
# Index documents for RAG
bash index_knowledge.sh
# or via CLI
whisplay index-knowledge
```

### Akbal's identity and self-knowledge (soul file + knowledge/)
- **`soul/akbal.md`** is the editable persona/system-prompt source of
  truth (`config/llm-config.ts` reads it via `utils/dir.ts`'s
  `soulFilePath`, override with `SOUL_FILE` in `.env`). Keep it short — it
  is sent in full on every turn, voice and web chat alike. HTML comments
  in it are stripped before use, so editing notes can live at the top of
  the file without costing tokens.
- **`knowledge/akbal-identidad.md`** / **`akbal-capacidades.md`** are
  self-knowledge for RAG (read-only grounding, not sent every turn —
  retrieved only when relevant via `core/Knowledge.ts`). Update them when
  a section's actual capabilities change; re-run `whisplay index-knowledge`
  (only re-embeds files whose content hash changed) afterward.
- **`knowledge/akbal-bitacora.md`** is a curated changelog in plain
  language ("qué hizo Akbal"), not a 1:1 mirror of `git log` — add a dated
  entry when something worth Akbal being able to talk about ships. Keep
  dates real (from `git log --date=short`, not guessed). This is
  deliberately manual/curated rather than an automatic self-journal: an
  LLM-summarized log of its own actions risks folding in a wrong summary
  as if it were a verified fact about itself.
- RAG is wired into both the voice flow (`core/chat-flow/states.ts`) and
  the web admin chat (`device/web-admin-server.ts`'s `/api/chat`) — both
  call `getSystemPromptWithKnowledge()`. It's a no-op when `enableRAG`
  (`cloud-api/knowledge.ts`) is false, which it is unless RAG's env vars
  are configured.

## Code Style and Conventions

### TypeScript
- **Target**: ES2020, CommonJS modules
- **Strict mode**: Enabled
- **Path resolution**: Use relative imports within src/
- **File naming**: kebab-case for files, PascalCase for classes

### Python
- **Style**: PEP 8
- **Hardware abstraction**: `python/whisplay.py` provides cross-platform GPIO
- **Platform support**: Raspberry Pi (RPi.GPIO) and Radxa (gpiod)

### Key Conventions
1. **Environment variables**: All configuration via `.env` file, accessed through `process.env`
2. **Audio files**: Stored in `data/recordings/`, auto-cleaned on startup if configured
3. **Plugin development**: Always read config from `ctx.env`, never `process.env` directly
4. **Error handling**: Use try-catch with meaningful error messages; hardware errors should be non-fatal where possible
5. **Logging**: Use `console.log/time/timeEnd` for debugging; Python side uses print with prefixes like `[Server]`, `[Camera]`
6. **API keys/tokens**: never hardcoded, never committed — always read from `.env`
   (e.g. `MACVENDORS_API_KEY` in `src/wifiradar/oui.ts`). Templates
   (`.env.template`, `setup/akbal.env.example`) carry placeholders only, with a
   note telling each user to get their own key.

## Plugin System Architecture

### Plugin Types
| Type | Interface | Environment Variable |
|------|-----------|---------------------|
| ASR | `ASRProvider.recognizeAudio()` | `ASR_SERVER` |
| LLM | `LLMProvider.chatWithLLMStream()` | `LLM_SERVER` |
| TTS | `TTSProvider.ttsProcessor()` | `TTS_SERVER` |
| Image Generation | `ImageGenerationProvider.addImageGenerationTools()` | `IMAGE_GENERATION_SERVER` |
| Vision | `VisionProvider.addVisionTools()` | `VISION_SERVER` |
| LLM Tools | `LLMToolsProvider.getTools()` | *(all active)* |

### Plugin Loading Order
1. Built-in plugins registered
2. `plugins/` directory (alphabetical)
3. `whisplay-plugin-*` npm packages (alphabetical)
4. Later plugins override earlier ones with same name

### Creating a Plugin
```bash
# Use CLI for scaffolding
whisplay plugin create

# Or manual: create in plugins/my-plugin/index.js
module.exports = {
  name: "my-plugin",
  displayName: "My Plugin",
  version: "1.0.0",
  type: "tts", // or "asr", "llm", etc.
  activate(ctx) {
    // ctx.env - merged global + plugin env
    // ctx.pluginEnv - plugin-only env
    // ctx.imageDir - output directory for images
    // ctx.ttsDir - temp directory for TTS
    return {
      async ttsProcessor(text) {
        // Implementation
        return { buffer, duration };
      }
    };
  }
};
```

## Hardware Abstraction Layer

### WhisplayBoard Class (`python/whisplay.py`)
Cross-platform hardware abstraction supporting Raspberry Pi and Radxa boards:

```python
whisplay = WhisplayBoard()  # Auto-detects platform
whisplay.set_rgb(r, g, b)   # RGB LED control
whisplay.set_backlight(brightness)  # LCD backlight (0-100)
whisplay.draw_image(x, y, w, h, rgb565_data)  # Display buffer
whisplay.on_button_press(callback)
whisplay.on_button_release(callback)
```

### Communication Protocol
- **Node.js** (TypeScript) ↔ **Python** (UI renderer) via TCP socket on port 12345
- JSON messages with newline delimiter
- Key message types: `button_pressed`, `button_released`, `camera_capture`, display updates

### Optional Hardware Daemon
- The optional local-only `whisplay-daemon` service now lives in the separate `Whisplay` driver repository, not in this repo.
- IPC transport: Unix domain socket, fixed default path `/tmp/whisplay-daemon.sock`
- Protocol: line-delimited JSON with `version: 1`
- Core commands expected by this repo: `health.ping`, `app.register`, `app.list`, `app.launch`, `app.focus.acquire`, `app.focus.release`, `framebuffer.acquire`, `events.subscribe`
- `python/chatbot-ui.py` performs daemon auto-detection/adaptation through `python/whisplay_client.py`, maps the shared RGB565 framebuffer directly when foregrounded, and falls back to the legacy embedded `python/whisplay.py` board path when the daemon is unavailable
- The daemon owns the button globally and reserves 4 rapid clicks as app-exit gesture; foreground apps receive normal press/release events only while focused
- The framebuffer support is userspace shared-memory/mmap handoff; it does not create a real `/dev/fb*` kernel device

### Display Update Format
```typescript
display({
  status: "listening" | "thinking" | "answering",
  emoji: "🤔",
  text: "Display text",
  RGB: "#ff6800",        // LED color
  brightness: 100,        // Backlight level
  scroll_speed: 3,        // Text scroll speed
  scroll_sync: {          // Sync scroll with TTS
    char_end: 50,
    duration_ms: 2000
  },
  battery_level: 85,
  battery_color: "#34d351",
  image: "/path/to/image.png"
});
```

## State Machine

The chat flow uses a finite state machine (`src/core/chat-flow/stateMachine.ts`):

| State | Description |
|-------|-------------|
| `sleep` | Idle, waiting for button press or wake word |
| `wake_listening` | Wake word activated, listening for speech |
| `listening` | Button pressed, recording audio |
| `recognizing` | ASR processing |
| `thinking` | LLM generating response |
| `answering` | TTS playing response |
| `camera_mode` | Camera preview active |
| `external_answer` | IM bridge receiving external message |
| `mode_select` | On-screen menu to switch between "modo agente" (OpenClaw via the `whisplay-im` bridge) and "modo local" (see `docs/agent-mode.md`) |
| `mode_loading` | Confirms the agent/local mode switch and persists it to `.env` (`DEVICE_MODE`) |
| `audio_output_select` | On-screen menu to switch TTS/chime output between the onboard Whisplay HAT speaker (default) and a paired Bluetooth speaker (see `chat-flow/audio-output-select-mode.ts`, `config/audio-output.ts`) |
| `audio_output_loading` | Confirms the speaker switch and persists it to `.env` (`AUDIO_OUTPUT`); also settable from the web admin (`/api/audio-output/select`) |
| `help` | Voice-command cheat sheet, opened by saying "ayuda" while holding the button, or from the quick menu (see `docs/voice-commands.md`) |
| `quick_menu` | Short click from "sleep" — carousel of Modelo/Modo/Audio/OST/Volumen/Ayuda/Cámara/WiFi directo/Conexión web/WiFi Radar/Radar de Aviones/Wardrive (see `chat-flow/quick-menu-mode.ts`) |
| `volume_adjust` | Physical volume control from the quick menu — click bumps +10% live, hold/double-click exits (see `chat-flow/volume-adjust-mode.ts`) |
| `wifi_connect` | Toggles the Pi's own wifi into a direct access point (SSID `akbal-pi`, QR on screen) from the quick menu's "WiFi directo" — same feature as the web's Ajustes > General > "WiFi directo (punto de acceso)" (see `chat-flow/wifi-connect-mode.ts`, `docs/wifi.md`) |
| `aircraft_radar` | Simplified physical radar for nearby ADS-B traffic (HackRF One), from the quick menu's "Radar de Aviones" (see `chat-flow/aircraft-radar-mode.ts`, `docs/aircraft-radar.md`) |

State transitions are triggered by button events, wake word detection, or completion of async operations.

## Testing Strategy

### Unit Testing
- Currently minimal test coverage (`npm test` returns placeholder)
- Test scripts in `python/test/` for hardware validation

### Integration Testing
```bash
# Test hardware components
python3 python/test/led.py      # RGB LED test
python3 python/test/key.py      # Button test
python3 python/test/socket-test.py  # Socket communication test
# The daemon test client now lives in the separate Whisplay repo:
# python3 ../Whisplay/example/whisplay_daemon_client.py ping

# Test VLM multi-turn
python3 python/test/test_vlm_multiturn.py
```

### Web Display for Development
Enable web-based display simulation without physical hardware:
```bash
# .env
WHISPLAY_WEB_ENABLED=true
WHISPLAY_WEB_PORT=17880
WEB_AUDIO_ENABLED=true      # Use browser mic/speaker
WEB_CAMERA_ENABLED=true     # Use browser camera
```

## Deployment Process

See `docs/deploy.md` for the full picture (git clone + `whisplay update`,
replacing the old rsync-only flow — rsync still works as a fallback for
devices without GitHub access). Short version:

### Systemd Service Setup
```bash
# Install and enable auto-start
bash startup.sh
# or
whisplay service install

# Service file location: /etc/systemd/system/chatbot.service
# If whisplay-daemon.service exists, startup.sh refuses to install chatbot.service.
# In that case the chatbot should be launched and managed by whisplay-daemon instead.
# startup.sh resolves its own real path (PROJECT_DIR) instead of assuming
# ~/whisplay-ai-chatbot — WorkingDirectory/ExecStart/logs all follow
# wherever this checkout actually lives (e.g. ~/akbal-pi/app). Logs:
# $PROJECT_DIR/chatbot.log (this directory, next to run_chatbot.sh).

# View logs
tail -f chatbot.log
sudo journalctl -u chatbot.service -f
```

### Updating
```bash
whisplay update   # git pull --ff-only (at the real repo root, even if
                   # this checkout is app/ nested inside a monorepo — see
                   # resolve_update_git_root in cli/common.sh) + deps + build
whisplay service restart
```

### Docker Services (Optional)
For local AI services without cloud dependencies:
```bash
cd docker
docker-compose up -d  # Starts Ollama, faster-whisper, piper-http
```

### Environment Upgrade
When `.env.template` changes:
```bash
whisplay upgrade-env
# or
bash upgrade-env.sh
```

## Security Considerations

1. **API Keys**: Store all API keys in `.env` file only; never commit to git
2. **Plugin Isolation**: Plugins receive scoped environment via `ctx.env`; cannot access other plugins' `.env` files
3. **Network**: HTTP proxy support via `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` environment variables
4. **Local Services**: Ollama and local speech services bind to localhost by default
5. **File Permissions**: Service runs as user with `audio`, `video`, `gpio` groups

## Common Development Tasks

### Adding a New AI Provider
1. Create provider files in `src/cloud-api/<provider>/`
2. Implement interface from `src/cloud-api/interface.ts`
3. Add to `src/cloud-api/server.ts` dispatcher
4. Add type definitions to `src/type/index.ts`
5. Document in `.env.template`

### Adding a New Tool for LLM
For the **voice** flow (every conversation, so keep this list short — see
the performance note in `cloud-api/local/ollama-llm.ts`):
1. Define tool schema in `src/config/llm-tools.ts`
2. Implement handler function
3. Or create `llm-tools` plugin for third-party tools

For the **web admin chat only** (its own registry, doesn't add weight to
voice turns): add an `AdminToolDescriptor` in a `src/config/admin-tools/*.ts`
sibling file (see `aircraft-radar-tools.ts` there for the pattern) and
register it in `admin-tools/registry.ts`.

### Web Search
The chatbot supports web search functionality via multiple providers:

**Supported Providers:**
| Provider | API Key Required | Features |
|----------|------------------|----------|
| Tavily | `TAVILY_API_KEY` | AI-optimized search, recommended |
| SerpAPI | `SERP_API_KEY` | Google Search results |
| Bing | `BING_SEARCH_API_KEY` | Microsoft Bing Search |
| Google | `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_CX` | Custom Search API |

**Configuration:**
```bash
# Enable web search
WEB_SEARCH_ENABLED=true

# Select provider (default: tavily)
WEB_SEARCH_PROVIDER=tavily

# Optional: max results (default: 5)
WEB_SEARCH_MAX_RESULTS=5

# Optional: enable image search
WEB_SEARCH_INCLUDE_IMAGES=false
```

**Usage:** Once enabled, LLM automatically uses `webSearch` tool when users ask about current events, news, or time-sensitive information.

### Modifying UI/Display
1. Python rendering: `python/chatbot-ui.py` (RenderThread class)
2. Status icons: `python/status-bar-icon/` directory
3. Node.js controller: `src/device/display.ts`

### Troubleshooting
- **Audio issues**: Check `amixer` output, verify WM8960 driver loaded
- **Display not updating**: Check socket connection on port 12345
- **GPIO errors**: Verify user in `gpio` group, check platform detection
- **Build errors**: Ensure Node.js 20, run `bash build.sh` to reset

## Data Directories

| Directory | Purpose | Cleanup |
|-----------|---------|---------|
| `data/recordings/` | Audio recordings | Auto-clean on start if configured |
| `data/images/` | Generated images | Manual cleanup |
| `data/knowledge/` | RAG document storage | Manual cleanup |
| `data/db/` | Qdrant vector database | Manual cleanup |

Set `CLEAN_DATA_FOLDER_ON_START=true` in `.env` to clear recordings on startup.

---

## Resources

- **This project's docs**: [`../README.md`](../README.md) (full picture,
  usage guide) and [`../docs/`](../docs/) (one file per feature/fix)
- **The book this project is named after**: *Cypher404: El Manifiesto*,
  by César Gaytán — https://cypher404.com/book/
- **Upstream base (fork origin)**:
  - Project Wiki: https://github.com/PiSugar/whisplay-ai-chatbot/wiki
  - Hardware Docs: https://docs.pisugar.com/
  - Discord: https://discord.gg/NMpCMP8RS8
- **License**: GPL-3.0
