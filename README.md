# akbal-pi

**Akbal** es una plataforma de IA 100% local sobre Raspberry Pi 5, enfocada en
ciberseguridad: conversa por voz y por texto, y además **entiende y opera el
propio equipo** — radar WiFi 3D, un laboratorio de auditoría WiFi (handshakes,
diccionario/máscara, allowlist), captura en movimiento (wardrive), radar de
aeronaves por ADS-B, y metadata GNSS — todo desde un admin web en tu LAN o
Tailnet, sin depender de servicios en la nube para funcionar.

Empezó como un fork de trabajo de
[PiSugar/whisplay-ai-chatbot](https://github.com/PiSugar/whisplay-ai-chatbot)
(que sigue usándose como base del chat por voz/LCD/plugins), pero ya es algo
mucho más grande y específico: un proyecto de autoaprendizaje sobre hasta
dónde puede llegar una IA local **sin bloqueos artificiales** combinada con
ciberseguridad real, operando sobre hardware físico — no una demo ni un
producto terminado.

## De dónde viene el nombre: Cypher404 — El Manifiesto

<p align="center">
  <img src="app/web/admin/img/cypher404-portada.jpg" alt="Portada de Cypher404: El Manifiesto" width="220" />
</p>

> **TODO SISTEMA PUEDE SER HACKEADO.**
>
> Nexora es una ciudad donde el hacking, la inteligencia artificial, la
> vigilancia masiva y las corporaciones tecnológicas gobiernan cada aspecto
> de la vida.
>
> Cuando **Akbal** comienza a manipular infraestructura, información y
> personas, Cypher, Namna y Aichi serán arrastrados a una guerra invisible
> donde el verdadero peligro no es la tecnología…
>
> sino el error humano.
>
> — De **César Gaytán**, creador de Hackwise y Director General en Dactima y
> Galditi. Autor también de este repositorio.

Este asistente toma su nombre e inspiración de Akbal, personaje de
**Cypher404: El Manifiesto**. Este proyecto existe para promover el libro —
**consíguelo y léelo en [cypher404.com/book](https://cypher404.com/book/)** —
y para servir de ejercicio práctico de estudio: entender, con código real
corriendo en hardware real, hasta dónde llega el cruce entre IA local sin
restricciones y ciberseguridad. Está pensado como inspiración abierta — si
te interesa este tipo de exploración, el repo es público y las
contribuciones son bienvenidas.

La misma reseña (con portada + QR para comprar el libro) está disponible
dentro del propio dispositivo: pantalla física (menú rápido → **Acerca de**)
y web admin (pestaña **Acerca de**, `/about`).

## Índice

| | Sección | Contenido |
|---|---|---|
| **El proyecto** | | |
| — | [De dónde viene el nombre](#de-dónde-viene-el-nombre-cypher404--el-manifiesto) | Cypher404: El Manifiesto, por qué existe este repo |
| **Instalación y referencia** | | |
| — | [Hardware](#hardware) | Componentes y enlaces de compra |
| — | [Sistema operativo](#sistema-operativo) | Qué OS corre el dispositivo |
| — | [Stack de software](#stack-de-software-100-local) | Qué usa cada pieza (LLM, voz, wifi...) |
| — | [Instalación desde cero](#instalación-cómo-montar-todo-desde-cero) | Los 10 pasos: armado → flasheo → drivers → app → systemd |
| — | [Estructura del repo](#estructura-del-repo) | Qué vive en `app/`, `docs/`, `setup/` |
| — | [Estado del proyecto](#estado) | Qué está probado y qué falta |
| **Uso del dispositivo** | | |
| — | [Conversación por voz](#conversación-por-voz-uso-principal) | El flujo principal: botón → hablar → respuesta |
| — | [Comandos de voz](#comandos-de-voz-instantáneos-no-gastan-turno) | Atajos instantáneos ("ayuda", volumen, modelo...) |
| — | [Menú rápido](#menú-rápido-click-corto-en-reposo) | Los 13 modos de la app física y sus gestos |
| — | [WiFi Radar en pantalla](#wifi-radar-pantalla) | Radar de redes en la LCD física |
| — | [Aircraft Radar en pantalla](#aircraft-radar-pantalla) | Radar de aeronaves (ADS-B) en la LCD física |
| **Sitio web** (`http://<ip>:8090`) | | |
| — | [Chat](#chat) | Chat escrito con el LLM local — entiende y opera el equipo (tool-calling), responde con enlaces a cada sección y renderiza markdown |
| — | [WiFi](#wifi-pestaña-sub-pestañas-conexión-redes) | Conexión, redes, punto de acceso |
| — | [WIFIRADAR 3D](#wifiradar-wifiradar-link-radar-wi-fi) | Radar 3D con toggle REAL/DEMO |
| — | [Aircraft Radar](#aircraft-radar-aircraft-radar-link-radar-de-aviones) | Tráfico aéreo (ADS-B) vía HackRF One |
| — | [Wifi Audit](#wifi-audit-pestaña) | Auditoría de laboratorio: allowlist, ataques, sesiones |
| — | [Wardrive](#wardrive-wardrive) | Captura mientras se conduce: mapa GPS + deauth oportunista |
| — | [GPS](#gps-página-gps) | Posición en vivo + satélites (GNSS, cacheado y offline-first) |
| — | [OST](#ost-pestaña-ost) | Jukebox de música |
| — | [Dispositivos](#dispositivos-pestaña-usb) | USB, montaje, adaptadores WiFi |
| — | [Ajustes](#ajustes) | Volumen, bocina Bluetooth, respaldos, identidad de Akbal (Soul) |
| — | [Acerca de](#acerca-de-about) | Cypher404: El Manifiesto, portada + QR para comprar el libro |
| — | [API HTTP](#api-http-para-integraciones) | Endpoints para integraciones |
| — | [Idioma (ES/EN)](#idioma-esen) | Selector siempre visible en el topbar |
| **Documentación completa** (`docs/`) | | |
| — | [Índice de `docs/`](#documentación-docs) | Las 21 guías: features, fixes de hardware/software, decisiones de diseño |

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
| LLM | [Ollama](https://ollama.com) con `huihui_ai/qwen3.5-abliterated:2B` por defecto, cambiable por voz o desde un menú en pantalla ([`docs/llm-model-selection.md`](docs/llm-model-selection.md), [`docs/voice-commands.md`](docs/voice-commands.md)) |
| Voz→texto (ASR) | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (modelo `base`, español) |
| Texto→voz (TTS) | [Piper](https://github.com/OHF-Voice/piper1-gpl) (voz `es_ES-davefx-medium`, hombre, español de España) |
| Batería | [PiSugar Power Manager](https://github.com/PiSugar/pisugar-power-manager-rs) |
| Orquestación | [whisplay-ai-chatbot](https://github.com/PiSugar/whisplay-ai-chatbot) |
| Pantalla | UI propia minimalista: íconos de wifi/batería arriba, personaje animado (cara en primer plano) al medio, texto verde terminal abajo ([`docs/display-ui.md`](docs/display-ui.md)); pantalla dedicada estilo terminal para elegir/cargar modelo de LLM ([`docs/voice-commands.md`](docs/voice-commands.md)) |
| Comandos de voz | Volumen, cambio/consulta de modelo de LLM y modo agente/local, resueltos por expresiones regulares antes de llegar al LLM — instantáneo, sin gastar un turno. Decir "ayuda" con el botón presionado muestra un resumen de todos estos comandos en pantalla ([`docs/voice-commands.md`](docs/voice-commands.md)) |
| Wifi | Menú físico "WiFi directo" (AP directo + QR, ver [`docs/wifi.md`](docs/wifi.md)) + interfaz web con chat a los modelos locales, wifi completo (buscar, conectar con contraseña, olvidar redes), USB y batería/CPU/RAM en vivo en `http://<ip-del-dispositivo>:8090` ([`docs/web-ui.md`](docs/web-ui.md)) |
| WiFi Radar | Visualización 3D (Three.js) del espacio WiFi alrededor del Pi, capturado pasivamente con cualquier adaptador USB en modo monitor (detección genérica; probado con Atheros AR9271 y Ralink RT5372) — toggle real/demo y caída a demo con datos simulados si no hay hardware conectado. Fabricantes resueltos del registro IEEE local (ieee-data), con fallback opcional a la API de macvendors.com ([`docs/wifiradar.md`](docs/wifiradar.md)) |
| Wifi Audit | Captura de handshakes para laboratorio/tesis: allowlist explícita de BSSIDs como único mecanismo de autorización, ataques pmkid/deauth con aircrack-ng, sesiones con artifacts descargables desde la web, contraseñas crackeadas visibles por sesión (ojo con revelado) y dictionary attack (rockyou) desde el listado de sesiones — probado contra un AP de laboratorio dedicado ([`docs/wifi-audit.md`](docs/wifi-audit.md), [`docs/lab-wireless.md`](docs/lab-wireless.md)) |
| Wardrive | Captura mientras se conduce, sobre la misma radio: registro pasivo continuo de redes/handshakes por SSID (SQLite), deauth oportunista opcional (apagado por defecto, con varios frenos de seguridad), track GPS y mapa en vivo, export CSV (WiGLE)/GPX — módulo aparte de Wifi Audit, nunca corren a la vez ([`docs/wardrive.md`](docs/wardrive.md)) |
| GPS + GNSS | Mapa mundial con la posición en vivo del dongle GPS USB: marcador, precisión, sky plot de satélites (en fix / visibles / necesarios) — [`docs/gps.md`](docs/gps.md). Cada satélite se enriquece con metadata cacheada en SQLite + datos orbitales de CelesTrak (nombre, catálogo NORAD): offline-first, nunca bloquea la UI si falla Internet — [`docs/gnss.md`](docs/gnss.md) |
| Aircraft Radar | Aeronaves cercanas por ADS-B (1090MHz, decodificado con `readsb`) con un HackRF One en modo RX-only: mapa real en modo oscuro con cada avión moviéndose por su posición real, o radar circular por distancia/rumbo (vía el GPS del Pi); identidad (matrícula/modelo/aerolínea) y ruta resueltas por caché local + adsbdb.com, historial en SQLite y caída a demo si no hay HackRF conectado ([`docs/aircraft-radar.md`](docs/aircraft-radar.md)) |
| Idioma (i18n) | Selector ES/EN siempre visible en el topbar de la web admin: detecta el idioma del navegador en la primera visita, la selección manual persiste y tiene prioridad — [`docs/i18n.md`](docs/i18n.md) |
| Identidad de Akbal (Soul) | Personalidad/system-prompt y lo que Akbal sabe de sí mismo en archivos de texto editables (`app/soul/akbal.md`, `app/knowledge/akbal-*.md`), con su propia pestaña en Ajustes → Soul para editarlos desde el navegador — se aplica sin reiniciar el servicio. |
| Chat con tool-calling | El chat web no solo conversa: puede consultar el estado real de WiFi Radar, Wifi Audit, Wardrive, Aircraft Radar y GNSS, y responde con enlaces directos a la sección correspondiente — registro propio en `app/src/config/admin-tools/`, separado del de voz por performance en el Pi. |

Detalle completo del setup en [`docs/SETUP.md`](docs/SETUP.md).

## Instalación: cómo montar todo desde cero

Guía completa para replicar el dispositivo, desde el armado físico hasta tener el
chatbot respondiendo por voz. Asume una Raspberry Pi 5 nueva y acceso por SSH
(en nuestro caso, vía Tailscale).

### 1. Armado físico

1. Inserta la microSD en la Raspberry Pi 5 (se flashea en el paso 2, puede ir antes o después de armar).
2. Monta el enfriador activo oficial sobre el SoC de la Pi 5 (pads térmicos + conector del ventilador al header `FAN`).
3. Monta el **PiSugar 3 Plus** en la parte de abajo de la Pi (se conecta por pogo-pins, no ocupa el header GPIO) y conecta la batería 5000mAh al conector JST del PiSugar.
   **Antes de montarlo**, tapa con un trocito de cinta aislante los dos pogo-pins que
   tocan los pines **3 (SDA1) y 5 (SCL1)** del header — deja libres los de 5V/GND. En
   esta unidad el MCU de la PiSugar corrompe el bus I2C que comparte con el códec de
   audio del Whisplay HAT y la tarjeta de sonido nunca se registra; aislarlo lo
   resuelve conservando la batería (se pierde solo la lectura de nivel por software).
   Diagrama de pines, fotos del antes/después y diagnóstico completo en
   [`docs/whisplay-audio-fix.md`](docs/whisplay-audio-fix.md#qué-pines-se-tapan-diagrama).
4. Monta el **Whisplay HAT** sobre el header GPIO de 40 pines, encima de todo el stack.
5. Antes de encender, revisa la documentación oficial de cada componente por si hay detalles de tu revisión de hardware específica:
   - [Whisplay HAT — docs oficiales](https://docs.pisugar.com/docs/product-wiki/whisplay/intro)
   - [PiSugar 3 Plus — docs oficiales](https://www.pisugar.com)
   - Video tutorial (build offline en RPi 5): https://youtu.be/kFmhSTh167U

### 2. Flashear el sistema operativo

Con [Raspberry Pi Imager](https://www.raspberrypi.com/software/):

1. Elegir OS: **Raspberry Pi OS (64-bit)** — basado en Debian Trixie.
2. En "Configuración avanzada" (⚙️): activar SSH (con contraseña o llave pública),
   configurar usuario, y WiFi si no se va a usar cable.
3. Flashear la microSD, insertarla en la Pi y encender.

### 3. Primer acceso

```bash
ssh <usuario>@<host-o-ip-de-la-pi>
sudo apt-get update && sudo apt-get install -y nodejs npm git ffmpeg alsa-utils \
    python3-pip python3-venv build-essential ieee-data
```

### 4. Driver del Whisplay HAT (audio + pantalla + botón)

```bash
git clone https://github.com/PiSugar/Whisplay.git --depth 1 ~/Whisplay
cd ~/Whisplay
sudo bash install_driver.sh   # detecta Raspberry Pi automáticamente
```

**Importante:** si tu Whisplay HAT usa el códec **WM8960** (revísalo con
`i2cdetect -y 1` después del primer reboot: debe aparecer un dispositivo en
`0x1a` y nada en `0x10`), vas a toparte con un bug del driver que impide que la
tarjeta de sonido se registre (`lost arbitration` / `Failed to enable LRCM` en
`dmesg`). El fix — deshabilitar el nodo de device-tree del códec ES8389, que no
existe en esta variante — está en
[`setup/whisplay-soundcard-wm8960-fix.patch`](setup/whisplay-soundcard-wm8960-fix.patch).
Detalle completo del diagnóstico en
[`docs/whisplay-audio-fix.md`](docs/whisplay-audio-fix.md).

```bash
cd ~/Whisplay/audio/whisplay-soundcard/src/dts
patch < /ruta/a/whisplay-soundcard-wm8960-fix.patch
dtc -I dts -O dtb -@ -o /tmp/whisplay-soundcard.dtbo whisplay-soundcard.dts
sudo install -m 644 /tmp/whisplay-soundcard.dtbo /boot/firmware/overlays/whisplay-soundcard.dtbo
sudo reboot
```

Verificar tras el reboot:

```bash
cat /proc/asound/cards        # debe listar "whisplaysound"
aplay -l                      # debe listar el dispositivo de playback
arecord -l                    # debe listar el dispositivo de captura
```

### 5. Batería (PiSugar Power Manager)

```bash
wget https://cdn.pisugar.com/release/pisugar-power-manager.sh
bash pisugar-power-manager.sh -c release
```

Esto instala `pisugar-server` (systemd) y habilita la lectura de batería que usa
el chatbot para mostrarla en pantalla.

**Nota:** si aislaste los pogo-pins de I2C de la PiSugar (paso 1.3),
`pisugar-server` va a reportar `I2C not connected` y la pantalla no mostrará el
nivel de batería. Es esperado e inofensivo; puedes deshabilitarlo con
`sudo systemctl disable --now pisugar-server` para que no llene el journal.

### 6. LLM local (Ollama)

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull huihui_ai/qwen3.5-abliterated:2B
```

`huihui_ai/qwen3.5-abliterated:2B` (Q4_K_M, ~1.9GB) es el que mejor balance
velocidad/calidad dio en CPU para un Pi 5 de 8GB, de varios modelos medidos —
ver [`docs/llm-model-selection.md`](docs/llm-model-selection.md) para la
metodología y por qué se descartaron los otros. Se puede cambiar por otro
modelo de [ollama.com/library](https://ollama.com/library) ajustando
`OLLAMA_MODEL` en el `.env`, o en caliente por voz / desde el menú en
pantalla sin reiniciar el servicio — ver
[`docs/voice-commands.md`](docs/voice-commands.md).

### 7. ASR y TTS locales (faster-whisper + Piper)

```bash
pip install faster-whisper 'piper-tts[http]' --break-system-packages
mkdir -p ~/piper && cd ~/piper
python3 -m piper.download_voices es_ES-davefx-medium   # hombre, español de España; ver docs/piper-voice-selection.md para más opciones
```

Estos dos paquetes no vienen en `python/requirements.txt` de la app: son
opcionales según qué backend de ASR/TTS elijas en el `.env` (aquí se usan los
locales, sin depender de APIs de nube).

### 8. La app (Akbal)

Cloná el repo completo directo en la Pi (ya incluye los fixes aplicados,
como el de Piper HTTP — ver
[`docs/piper-tts-silent-fix.md`](docs/piper-tts-silent-fix.md) — y la interfaz
de pantalla minimalista con los GIFs de personaje ya generados, ver
[`docs/display-ui.md`](docs/display-ui.md); no hace falta ningún paso extra
para la pantalla). Esto deja `whisplay update` funcionando de una — un
`git pull` alcanza para la próxima actualización, en vez de repetir un
rsync a mano cada vez; detalle completo (y la alternativa por rsync si tu
Pi no tiene salida a GitHub) en [`docs/deploy.md`](docs/deploy.md):

```bash
ssh <usuario>@<host-de-la-pi>
git clone https://github.com/mrebola/akbal-pi.git ~/akbal-pi
cd ~/akbal-pi/app
touch use_npm            # si yarn falla por permisos globales de npm, se usa npm
bash install_dependencies.sh
source ~/.bashrc
```

Configura el `.env` usando [`setup/akbal.env.example`](setup/akbal.env.example)
como referencia (o `.env.template` para ver todas las opciones disponibles):

```bash
cp .env.template .env
# editar .env con los valores de setup/akbal.env.example (ASR/LLM/TTS server,
# modelo de Ollama, ruta de la voz de Piper, ENABLE_THINKING=false, etc.)
```

Compilar:

```bash
bash build.sh
```

### 9. Arranque automático (systemd)

```bash
bash startup.sh
```

Crea `chatbot.service` (con `Restart=always`) y lo deja arrancando en cada boot.
El script pregunta si quieres deshabilitar la interfaz gráfica (recomendado para
uso 100% headless, opcional). Detecta solo la ruta real del proyecto (no asume
`~/whisplay-ai-chatbot`) — logs en `~/akbal-pi/app/chatbot.log`.

### 10. Verificación de punta a punta

```bash
systemctl status chatbot.service
tail -f ~/akbal-pi/app/chatbot.log
```

Con el botón del Whisplay HAT: presionar y hablar → debería transcribir, pensar,
y responder por el altavoz. Si transcribe y "piensa" pero no se escucha nada,
revisar [`docs/piper-tts-silent-fix.md`](docs/piper-tts-silent-fix.md) (ya
corregido en `app/`, pero relevante si se actualiza desde el repo original de
PiSugar).

## Estructura del repo

- [`app/`](app/) — código de la aplicación que corre en la Pi. Nació como fork
  de trabajo de `whisplay-ai-chatbot` (todavía su base para voz/LCD/plugins)
  y creció muy por encima de eso: WiFi Radar, Wifi Audit, Wardrive, Aircraft
  Radar, GNSS, el admin web con chat de tool-calling, e identidad editable
  (Soul) son enteramente de este proyecto, no del fork original. Se despliega
  clonando este repo entero en el dispositivo (ver [`docs/deploy.md`](docs/deploy.md))
  y corriendo todo desde `app/` — `whisplay update` sabe que el repo real
  está un nivel arriba de `app/`, no confundirlo con la instalación
  original de PiSugar (esa sí espera clonarse directo en la raíz).
  No incluye `.env` (usar `app/.env.template` o `setup/akbal.env.example` como base),
  `node_modules`, `dist` ni datos de runtime — todo eso se genera/instala en el
  propio dispositivo.
- [`docs/`](docs/) — bitácora de instalación, features y fixes encontrados en
  el camino. Índice completo en la sección [Documentación](#documentación-docs)
  más abajo.
- [`setup/`](setup/) — patches aplicados, `.env` de referencia (sin secretos), y
  los videos originales del personaje en
  [`setup/display-source-videos/`](setup/display-source-videos/).

## Documentación (`docs/`)

Cada feature y cada bug de hardware/software encontrado en el camino tiene su
propio doc. Agrupado por tipo:

**Features (qué hace cada cosa, cómo está construida):**

| Doc | Contenido |
|---|---|
| [`web-ui.md`](docs/web-ui.md) | La interfaz web completa: chat, wifi, USB, WIFIRADAR |
| [`wifiradar.md`](docs/wifiradar.md) | WIFIRADAR — visualización 3D del espacio WiFi |
| [`wifi-audit.md`](docs/wifi-audit.md) | Wifi Audit — captura de handshakes para laboratorio/tesis |
| [`wardrive.md`](docs/wardrive.md) | Wardrive — captura mientras se conduce, radios y compartir sesiones |
| [`wardrive-backups.md`](docs/wardrive-backups.md) | Dónde están los respaldos de Wardrive (solo en el dispositivo) |
| [`doom.md`](docs/doom.md) | DOOM original en la pantalla y en el celular |
| [`lab-wireless.md`](docs/lab-wireless.md) | El AP de laboratorio dedicado (`akbal_lab`) — la red autorizada para Wifi Audit |
| [`aircraft-radar.md`](docs/aircraft-radar.md) | Aircraft Radar — ADS-B con HackRF One |
| [`gps.md`](docs/gps.md) | GPS — posición del dispositivo en un mapa mundial |
| [`gnss.md`](docs/gnss.md) | GNSS — metadata de satélites offline-first (CelesTrak) |
| [`voice-commands.md`](docs/voice-commands.md) | Comandos de voz (volumen, modelo, modo, ayuda) |
| [`agent-mode.md`](docs/agent-mode.md) | Modo agente (OpenClaw) vs modo local |
| [`wifi.md`](docs/wifi.md) | Menú "WiFi directo" y administrador desde la web |
| [`i18n.md`](docs/i18n.md) | Traducciones del admin web (ES/EN) |
| [`display-ui.md`](docs/display-ui.md) | Interfaz de pantalla minimalista (íconos + video + texto) |
| [`deploy.md`](docs/deploy.md) | Deploy/actualización por `git clone` + `whisplay update` |

**Setup, fixes y decisiones de diseño (bitácora, con fecha y causa raíz):**

| Doc | Contenido |
|---|---|
| [`SETUP.md`](docs/SETUP.md) | Registro completo de cómo se dejó corriendo la primera versión |
| [`whisplay-audio-fix.md`](docs/whisplay-audio-fix.md) | Fix: la tarjeta de sonido del Whisplay HAT no se registraba |
| [`piper-tts-silent-fix.md`](docs/piper-tts-silent-fix.md) | Fix: transcribía y respondía, pero no se escuchaba nada |
| [`recording-hang-fix.md`](docs/recording-hang-fix.md) | Fix: grabación que se quedaba colgada bloqueando el micrófono |
| [`llm-model-selection.md`](docs/llm-model-selection.md) | Por qué se eligió cada modelo LLM local, con benchmarks |
| [`piper-voice-selection.md`](docs/piper-voice-selection.md) | Selección de voz de Piper (verificación real, no por el nombre) |
| [`performance-tuning.md`](docs/performance-tuning.md) | Optimización de velocidad (ASR/LLM/TTS) |

Para agentes de IA trabajando en el código: [`app/AGENTS.md`](app/AGENTS.md)
(arquitectura interna de `app/`) y el [`AGENTS.md`](AGENTS.md) de la raíz
(qué es este repo, checklist anti-secretos).

## Estado

Primera versión completa corriendo en la Raspberry Pi, con flujo de voz de punta a
punta probado en el hardware físico (botón → graba → transcribe → responde → se
escucha): driver de audio del Whisplay HAT, LLM/ASR/TTS locales, batería PiSugar, y
el chatbot como servicio systemd (`chatbot.service`, arranque automático). Ver
[`docs/SETUP.md`](docs/SETUP.md) para el detalle, y
[`docs/whisplay-audio-fix.md`](docs/whisplay-audio-fix.md) /
[`docs/piper-tts-silent-fix.md`](docs/piper-tts-silent-fix.md) /
[`docs/recording-hang-fix.md`](docs/recording-hang-fix.md) para los bugs de
hardware/software que se encontraron y arreglaron durante la instalación, y
[`docs/performance-tuning.md`](docs/performance-tuning.md) para la optimización
de velocidad del ASR (~3x más rápido, de 5.2s a 1.8s por transcripción), y
[`docs/piper-voice-selection.md`](docs/piper-voice-selection.md) para cómo se
eligió la voz (con medición real de tono, no adivinando por el nombre) y todas
las voces que se probaron, [`docs/display-ui.md`](docs/display-ui.md) para
la interfaz de pantalla minimalista (personaje animado + texto), y
[`docs/voice-commands.md`](docs/voice-commands.md) para el control de
volumen y modelo de LLM por voz — incluye el menú visual en pantalla para
elegir modelo con el botón del Whisplay HAT (click para recorrer opciones,
mantener ~0.9 segundos para confirmar, doble clic para cancelar), la
pantalla de carga con spinner indeterminado mientras Ollama carga el modelo
elegido, el menú rápido completo (ver la tabla en [Menú
rápido](#menú-rápido-click-corto-en-reposo) más abajo — creció bastante
desde esta primera versión) y una pantalla de ayuda (decir "ayuda" con el
botón presionado, o elegirla del menú rápido) que resume los comandos de
voz en a lo sumo 2 pantallas.
[`docs/llm-model-selection.md`](docs/llm-model-selection.md) documenta cómo
se eligió el modelo por defecto y por qué el menú de voz ya no cambia de
modelo a ciegas ante un comando mal reconocido (causó una regresión real:
dejó activado un modelo con problemas de eco en respuestas cortas).

Wake word (activación por voz sin botón) ya está implementado
(`WAKE_WORD_ENABLED=true` en `.env`, motor tipo openWakeWord con el modelo
`hey_jarvis` por defecto — ver `app/src/device/wakeword.ts` y
`app/python/wakeword.py`), apagado por defecto.

---

# Guía de uso: todas las features del dispositivo

Qué es cada cosa, para qué sirve y cómo se usa. Dos superficies de control:
el **dispositivo físico** (botón del Whisplay HAT + pantalla LCD) y el **sitio
web de administración** (`http://<ip-del-dispositivo>:8090`, requiere sesión —
usuario/clave configurados en `WEB_ADMIN_USER`/`WEB_ADMIN_PASSWORD` del `.env`).

## En el dispositivo físico (botón + pantalla)

El botón tiene el mismo lenguaje en todas las pantallas:

- **Click corto** (menos de 0,4 s): avanza al siguiente elemento, o hace la
  acción principal de la pantalla.
- **Mantener ~0,9 s**: elige, confirma o sale. Entra a un submenú.
- **Doble clic**: vuelve un nivel. Desde la raíz de un menú o una herramienta,
  sale a reposo.
- **En reposo**: click corto abre el menú rápido; **mantener ~0,4 s** habla con Akbal.
- Lo que corta algo en curso (detener Wardrive o la auditoría, apagar el punto
  de acceso) **pide confirmación**: mantener confirma, doble clic vuelve y un
  clic corto no hace nada.

### Conversación por voz (uso principal)

1. Presiona el botón y mantenlo mientras hablas — el personaje cambia a "escuchando".
2. Suelta: la frase se transcribe localmente (faster-whisper), el LLM local genera
   la respuesta y Piper la habla por el altavoz.
3. Mientras mantiene presionado, decir **"ayuda"** muestra en pantalla el
   resumen de todos los comandos de voz.

### Comandos de voz (instantáneos, no gastan turno)

Dichos **mientras mantienes el botón presionado**; se resuelven por expresiones
regulares antes de llegar al LLM:

- **"sube el volumen" / "baja el volumen"** — ajusta el nivel de salida.
- **"qué modelo estás usando"** — responde el modelo activo sin preguntarle al LLM.
- **"cambia al modo agente" / "cambia al modo local"** — alterna entre responder
  vía el bridge `whisplay-im` (agente externo) y el LLM local del dispositivo.
- Otros atajos y detalles en [`docs/voice-commands.md`](docs/voice-commands.md).

### Menú rápido (click corto en reposo)

Carrusel navegable con los gestos descritos arriba. La app física completa es
una máquina de estados ([`app/src/core/chat-flow/states.ts`](app/src/core/chat-flow/states.ts))
con estos modos, cada uno con su propio control:

| Ítem (pantalla) | Qué hace | Gestos dentro del modo |
|---|---|---|
| **Conectar a wifi** | Carrusel de las redes guardadas de la Pi, con su señal o "Fuera de alcance"; la conectada aparece con "● Activo". | Click recorre; **mantener** conecta con el perfil guardado (resultado ~2,5 s); doble clic sale. |
| **Modo** | Alterna el origen de las respuestas: **agente** (OpenClaw, vía `whisplay-im` — ver [`docs/agent-mode.md`](docs/agent-mode.md)) o **local** (el LLM corre en la Pi). La descripción muestra el modo activo. | Click navega; **mantener** confirma; queda persistido en `.env`. |
| **WiFi directo** | Convierte la wifi de la Pi en un punto de acceso **`akbal-pi`** con QR (misma función que Ajustes → General → "WiFi directo" en la web). Dos QR navegables: wifi y web. Aparece "● Activo" mientras está encendido. | Click cambia de QR; **mantener** abre "¿Apagar el punto de acceso?" (mantener de nuevo apaga); doble clic vuelve sin apagarlo. |
| **Wardrive** | Inicia o detiene una sesión de captura mientras se conduce (mismo servicio que `/wardrive`). Con 2 o 3 radios, reparte la banda entre todas. | Sin sesión: **mantener** inicia. Con sesión: **mantener** o **doble clic** abren "¿Detener captura?" (mantener confirma, doble clic vuelve). |
| **Modelo** | Elige el modelo de IA entre los descargados en Ollama. | Click recorre; **mantener** confirma (spinner mientras Ollama carga el modelo); doble clic cancela sin cambiar. No reinicia el servicio. |
| **Audio** | Salida de sonido: **bocina de la Pi** (Whisplay HAT) o **bocina Bluetooth** ya emparejada desde la web. Persiste en `.env`. | Click recorre; **mantener** confirma. |
| **OST** | Reproductor del OST de Cypher con barra de progreso. Muestra título y progreso de la pista actual. | Click play/pausa; doble clic siguiente pista; **mantener** sale. |
| **Volumen** | Cada click sube +10% en vivo, con barra de progreso. | Click sube; **mantener** o doble clic salen sin cambios (el volumen queda como estaba). |
| **Ayuda** | Pantallas de referencia con los comandos de voz y los gestos del botón (a lo sumo 2 pantallas). | Click pasa de página; **mantener** o doble clic salen. |
| **Cámara** | Modo cámara, solo si hay cámara configurada (si no, el menú la oculta). | Click captura la foto (queda en `data/images/`); **mantener** sale. |
| **Conexión web** | Muestra la IP LAN y de Tailscale del dispositivo + QR hacia la web admin (`http://<ip>:8090`). | Click cambia entre IP y QR; **mantener** o doble clic salen. |
| **WiFi Radar** | Radar WiFi de pantalla: discos con un punto por red cercana y texto inferior rotando nombre + dBm. Solo corre mientras esta pantalla o una página del radar están abiertas. | **Mantener** o doble clic salen. |
| **Radar de Aviones** | Aircraft Radar de pantalla: un punto por aeronave, ubicado por su rumbo y distancia GPS. | **Mantener** o doble clic salen. |
| **DOOM** | Juega DOOM original con el celular (`Doom1.WAD` en `data/doom/`). El juego se controla desde la página `/doom`. | **Mantener** o doble clic salen del juego (y de la pantalla del juego). |
| **Acerca de** | Por qué existe Akbal Pi y de dónde nace el nombre (Cypher404: El Manifiesto). Última página: QR para comprar el libro ([cypher404.com/book](https://cypher404.com/book/)). | Click pasa de página; **mantener** o doble clic salen. |

Los menús se cierran solos tras **30 segundos** sin tocar el botón; WiFi directo
espera **60 segundos** porque el celular necesita tiempo para escanear el QR.

### WiFi Radar (pantalla)

Detección pasiva de redes alrededor del Pi, mostradas como puntos en un radar
(rotación/distanca por hash de BSSID y potencia de señal, respectivamente). La
franja inferior rota entre las redes visibles. Si no hay adaptador USB con modo
monitor conectado muestra "Sin adaptador WiFi compatible"; con el toggle global
en demo muestra datos sintéticos con un prefijo "DEMO · ". Entra desde el menú
rápido; mantener presionado para salir.

El radar **no arranca al iniciar la Pi**: se enciende mientras la pantalla del
radar o una página del radar están abiertas, y se apaga 60 segundos después de
la última consulta. Nunca corre mientras Wardrive tiene la radio.

### Aircraft Radar (pantalla)

Aeronaves detectadas por ADS-B (HackRF One), mostradas como puntos en el mismo
tipo de disco — pero ubicados por el rumbo/distancia GPS reales de cada avión
contra la posición del Pi, no por un hash. El color indica si se acerca (verde)
o se aleja (rojo); amarillo mientras no hay fix GPS para calcularlo. La franja
inferior rota callsign + distancia + rumbo. Sin HackRF conectado muestra "Sin
HackRF conectado o sin fix GPS"; en demo, aeronaves sintéticas con prefijo
"DEMO · ". Entra desde el menú rápido ("Radar de Aviones"); mantener presionado para
salir. Detalle completo en [`docs/aircraft-radar.md`](docs/aircraft-radar.md).

## Sitio web de administración (`http://<ip>:8090`)

Navegación por pestañas arriba. Mismo control por sesión (login con las
credenciales del `.env`).

### Chat

Chat con el modelo de Ollama local del dispositivo, igual que la conversación
por voz pero escrito. Sirve para probar el LLM sin el flujo de voz, para
preguntas largas y para revisar el historial de la conversación actual.
Modelo y modo agente/local también se cambian desde aquí (mismos efectos que
el menú físico).

### WiFi (pestaña, sub-pestañas Conexión / Redes)

- **Conexión**: la red activa del dispositivo (SSID, señal) y el modo punto de
  acceso (`akbal-pi`) — encenderlo/apagarlo sin tocar el menú físico.
- **Redes**: escanear redes alrededor, conectarse (con contraseña), y "olvidar"
  redes guardadas. Todo vía nmcli fijo a la radio interna de la Pi, así que con
  el dongle USB de auditoría conectado el escaneo sigue saliendo de la radio
  correcta.

### WIFIRADAR (`/wifiradar`, link "Radar Wi-Fi")

Visualización 3D fullscreen (Three.js) del espacio WiFi: un radar militar con
puntos por AP cercano, estelas por RSSI, eventos en vivo (nuevo AP, red abierta,
deauth...) y panel lateral al hacer click en un punto (SSID, BSSID, vendor,
señal, clientes). **Real vs demo**: botón **SRC** arriba — REAL captura pasiva
de beacons reales con el dongle USB en modo monitor; DEMO alimenta datos
sintéticos (sin tocar la radio) para demostrar la interfaz. Si el adaptador se
desconecta, cae a DEMO solo y se recupera solo cuando vuelve. Pausa el stream
con **LIVE/PAUSED**, alterna 2D/3D con **3D**, RESET VIEW centra la cámara.
Solo escucha: nunca transmite nada. El radar se enciende al abrir la página y se
apaga 60 segundos después de la última consulta (o al cerrar la página, si no
hay consultas).

El fabricante de cada red/dispositivo se resuelve en tres capas: registro IEEE
local (`ieee-data`), tabla curada interna y — solo si `MACVENDORS_API_KEY` está
en el `.env` — la API de macvendors.com como último recurso (cacheada y con
rate-limit; cada usuario debe poner su propia key gratis). Las MAC aleatorizadas
de teléfonos/laptops modernos se etiquetan "Random MAC" sin intentar resolverlas.
En el modal de detalles, las MAC van enmascaradas (`AA:BB:CC:••:••:••`) con un
botón 👁 para revelarlas.

### Wifi Audit (pestaña)

Captura de handshakes para laboratorio/tesis, sobre la misma radio del radar.
Distinto de "Wardrive" (página aparte, más abajo): acá se autoriza y ataca
una red por vez, quieto; Wardrive registra todo mientras se conduce, sin
ataques dirigidos. Flujo, ciclo de ataque con comandos exactos, modelo de
allowlist y sesiones: ver [`docs/wifi-audit.md`](./docs/wifi-audit.md).
Resumen:

1. **Entrar** (banner superior) toma la radio en modo monitor — el radar deja de
   capturar hasta que salgas (se retoma solo al salir).
2. La tabla lista las redes visibles (canal, señal, clientes, seguridad),
   con buscador y columnas ordenables; click en una fila abre el modal de
   detalles de la red.
3. **Autorizar** un BSSID lo agrega al allowlist — el único mecanismo de
   autorización: sin allowlist no hay ataque, no existe el "atacar todo".
4. **Auditar** corre el ataque contra esa red: escaneo → lock de canal →
   captura con airodump-ng → deauth dirigida (una ronda suele bastar; un
   reintento si no hubo handshake) → validación de handshake. El progreso
   paso a paso se muestra en un modal.
5. Al capturar, los archivos (`.hc22000`, `.cap`) quedan listados abajo para
   descarga desde la web. Todo vive en `~/wardrive-sessions/` en el dispositivo.
6. **Toggle live/demo** (switch iOS arriba a la derecha): el descubrimiento
   puede venir de la radio real o del mismo generador demo del radar (útil
   para ensayar la interfaz sin hardware; contra redes demo los ataques son
   inertes).
7. Deauth dirigido: pestaña Deauth — lista dispositivos clientes vistos
   hablando en el aire; cada uno requiere autorización individual de MAC.
8. **SESIONES ANTERIORES**: cada sesión con fecha lista botones por red
   crackeada — 👁 (ver la contraseña encontrada, enmascarada hasta revelar),
   **handshake** (descarga el `.cap`/`.hc22000`) y **dictionary attack**
   (rockyou contra esa captura, con barra de progreso y cancelación).
9. **Salir** restaura la radio a modo normal y devuelve el control al radar.

### Wardrive (`/wardrive`)

Página fullscreen aparte (no una pestaña del index): captura pasiva y
continua mientras se conduce, sobre la misma radio que el radar/Wifi Audit
(nunca corren a la vez). Detalle completo en
[`docs/wardrive.md`](./docs/wardrive.md). Resumen:

1. **▶ INICIAR** toma la radio (detiene WIFIRADAR), entra en modo monitor y
   arranca el hop 2.4GHz + el track GPS. Arrancable también desde el menú
   físico ("Wardrive" en el menú rápido) — es el mismo servicio, entrar por
   un lado se ve y se controla igual desde el otro.
2. El selector **Radios** elige entre `auto` (default, todas las radios
   conectadas), `single`, `dual` y `triple`. Con varias radios, una ataca y el
   resto descubre en paralelo. Ver [`docs/wardrive.md`](./docs/wardrive.md#radios-1-2-o-3-dongles).
   La pestaña **Compartir** exporta, importa y borra sesiones en paquetes `.akbal`.
   Cada red vista se registra por SSID (no por BSSID) en SQLite — un mismo
   SSID visto por varios APs no se re-ataca una vez que uno de ellos ya dio
   handshake (✋ capturado / ✓ cubierto por otro AP / ✕ agotado).
3. **Deauth oportunista** (toggle rojo, apagado por defecto): solo dispara a
   ≤25km/h, RSSI ≥ −72dBm, seguridad conocida, sin handshake todavía, y con
   límite de 3 intentos + cooldown de 45s por AP. La captura pasiva de EAPOL
   siempre está activa, dispare o no el deauth.
4. Mapa Leaflet en vivo con el recorrido, redes vistas y handshakes
   capturados; pestaña de sesiones pasadas con export CSV (formato WiGLE) y
   GPX.
5. **■ DETENER** restaura la radio a modo normal.

### GPS (página /gps)

Mapa mundial fullscreen con la posición en vivo del dongle GPS USB de la Pi:
marcador pulsante con círculo de precisión, HUD con coordenadas/altitud/
velocidad/rumbo/HDOP y un panel de satélites con sky plot (en fix N/4,
visibles M/total, coloreados por SNR). Sin fix indica cuántos satélites hay
y cuántos faltan. Funciona con u-blox y clones (`ttyACM*`/`ttyUSB*`), con o
sin `gpsd` — ver [`docs/gps.md`](docs/gps.md).

Cada satélite se enriquece con metadata GNSS: nombre y catálogo NORAD
cacheados en SQLite, con datos orbitales de CelesTrak actualizados en
segundo plano si hay Internet. Offline-first: si no hay Internet o falla la
API, se sigue mostrando lo cacheado — nunca bloquea la pantalla ni la web.
Ver [`docs/gnss.md`](docs/gnss.md).

### Aircraft Radar (`/aircraft-radar`, link "Radar de Aviones")

Lista de aeronaves cercanas ordenada por distancia, alimentada por un HackRF
One en 1090MHz. Cada tarjeta muestra callsign, matrícula/modelo/aerolínea
(resueltos por caché local + adsbdb.com), ruta origen→destino ("Route
unknown" si no se puede confirmar), altitud, velocidad y distancia/rumbo
reales vía el GPS del Pi. Toggle **MAPA / RADAR** en el header:

- **MAPA**: mapa real (Leaflet, modo oscuro) con cada aeronave ubicada por su
  posición GPS absoluta y moviéndose en vivo — no necesita que el Pi tenga
  fix GPS para mostrar aviones, solo para ubicarse a sí mismo.
- **RADAR**: el disco circular original — Akbal al centro, aeronaves por
  bearing/distancia relativos, anillos de 10/25/50/100km.

Click en un punto o tarjeta abre el detalle completo. Mismo toggle LIVE/DEMO
que WIFIRADAR — sin HackRF conectado cae a aeronaves sintéticas con prefijo
"DEMO · ". Decodificado con [`readsb`](https://github.com/wiedehopf/readsb)
(soporte nativo de HackRF); la recepción real depende bastante de la
antena — ver
[`docs/aircraft-radar.md`](docs/aircraft-radar.md#estado-de-la-captura-real)
para cómo se afinó y sus límites conocidos. Solo recepción: el HackRF
nunca transmite. Detalle completo en
[`docs/aircraft-radar.md`](docs/aircraft-radar.md).

### OST (pestaña OST)

Jukebox del OST de Cypher: playlist fija local con play/pausa, siguiente/
anterior y seek. Controla lo mismo que el ítem "OST" del menú físico.

### Dispositivos (pestaña USB)

Lista unidades USB conectadas (pendrives, discos), permite montarlas/expulsarlas
de forma segura y explorar/descargar archivos que contengan. También muestra los
adaptadores WiFi USB detectados y si soportan modo monitor (la fuente que usan
radar/wardrive para decidir si pueden operar).

### Ajustes

- **Volumen** del altavoz (0-100).
- **Salida de audio**: bocina de la Pi (Whisplay HAT, ALSA directo) o bocina
  externa Bluetooth. El emparejamiento de bocinas BT también vive aquí:
  **"Vincular dispositivo"** escanea los parlantes alrededor que anuncian
  A2DP (perfiles de audio), lista los encontrados y los ya emparejados, y
  permite conectar/eliminar cada uno. Detalles que conviene saber:
  - Al elegir una bocina BT, el dispositivo la conecta y desconecta
    automáticamente cualquier otra — la radio BT de la Pi solo sostiene una
    bocina A2DP a la vez.
  - Una bocina con "Conectado: sí" pero sin perfil de audio (sink) activo
    no se considera válida: el selector verifica que PipeWire haya creado el
    sink de audio de verdad, no solo el canal de control, para que el
    sonido nunca se pierda en silencio.
  - El micrófono siempre es el del HAT: el BT es solo de salida.
- **Wi-Fi**: conexión, redes guardadas, AP — mismo backend que la pestaña WiFi.
- **IA**: modelo de Ollama activo, instalar/borrar modelos, RAM usada.
- **Soul**: edita la identidad de Akbal — su personalidad (`soul/akbal.md`,
  usada en cada respuesta, voz y chat web) y lo que sabe de sí mismo
  (`knowledge/akbal-*.md`, alimenta el RAG). Se aplica sin reiniciar el
  servicio; guardar un archivo de conocimiento reindexa el RAG solo.
- **Respaldos**: crear/descargar/restaurar/eliminar snapshots de configuración.
- **Almacenamiento**: navegación de discos montados con subida/descarga/borrado.
- **Sistema** (ícono ◉ arriba a la derecha, en cualquier pestaña): CPU, RAM,
  disco y wifi en vivo, y logout.

### Acerca de (`/about`)

Cypher404: El Manifiesto — portada, sinopsis, de dónde viene el nombre
Akbal y por qué existe este proyecto, con un QR y un botón directo para
comprar/leer el libro en [cypher404.com/book](https://cypher404.com/book/).
Misma reseña que la pantalla física del dispositivo (menú rápido → Acerca
de), con el texto completo en vez de la versión condensada.

### API HTTP (para integraciones)

Todo lo anterior también es accesible programáticamente bajo `/api/*` con la
misma sesión de cookie: `/api/status`, `/api/chat`, `/api/wifi/scan`,
`/api/wifiradar/snapshot` + `POST /api/wifiradar/mode`
(`{"mode":"live"|"demo"}`), `/api/aircraft` + `/api/aircraft/:icao` +
`/api/aircraft/nearest` + `/api/aircraft/history` + `POST /api/aircraft/mode`,
`/api/wardrive/*` — Wifi Audit, el nombre de ruta no se renombró junto con la
pestaña (`enter`, `exit`, `source`, `allowlist`, `attack/one`, ...),
`/api/wardrive/drive/*` — Wardrive/conducción (`start`, `stop`, `status`,
`sessions`, `export/csv`, `export/gpx`, ...), `/api/gnss/status` +
`/api/gnss/history`, `/api/music/*`, `/api/usb/*`, `/api/backup/*`.
Ver `app/src/device/web-admin-server.ts` para la lista completa.

### Idioma (ES/EN)

Selector siempre visible en el topbar de toda la web admin (mismo lugar en
todas las pestañas). En la primera visita detecta el idioma del navegador
(español → ES, cualquier otro → EN); a partir de ahí la selección manual
persiste en el navegador y tiene prioridad sobre esa detección. Motor propio
sin dependencias (`app/web/admin/i18n.js` + diccionarios en
`app/web/admin/i18n/{es,en}.json`) — ver [`docs/i18n.md`](docs/i18n.md) para
cómo agregar una clave nueva y qué páginas/textos todavía quedan pendientes
de traducir.
