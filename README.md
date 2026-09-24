# akbal-pi

**Akbal** es un asistente de IA local que corre sobre una Raspberry Pi 5, sin depender de servicios en la nube para su funcionamiento principal.

El proyecto toma como base el repositorio [PiSugar/whisplay-ai-chatbot](https://github.com/PiSugar/whisplay-ai-chatbot), adaptándolo y extendiéndolo sobre el hardware descrito abajo.

## Índice

| | Sección | Contenido |
|---|---|---|
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
| — | [Menú rápido](#menú-rápido-click-corto-en-reposo) | Los 10 modos de la app física y sus gestos |
| — | [WiFi Radar en pantalla](#wifi-radar-pantalla) | Radar de redes en la LCD física |
| **Sitio web** (`http://<ip>:8090`) | | |
| — | [Chat](#chat) | Chat escrito con el LLM local |
| — | [WiFi](#wifi-pestaña-sub-pestañas-conexión-redes) | Conexión, redes, punto de acceso |
| — | [WIFIRADAR 3D](#wifiradar-wifiradar-link-radar-wi-fi) | Radar 3D con toggle REAL/DEMO |
| — | [Wardriving](#wardriving-pestaña) | Auditoría de handshakes (allowlist, ataques, sesiones) |
| — | [OST](#ost-pestaña-música) | Jukebox de música |
| — | [Dispositivos](#dispositivos-pestaña-usb) | USB, montaje, adaptadores WiFi |
| — | [Ajustes](#ajustes) | Volumen, bocina Bluetooth, respaldos |
| — | [API HTTP](#api-http-para-integraciones) | Endpoints para integraciones |
| **Docs por archivo** | | |
| — | [`docs/`](docs/) | Bitácora de instalación, fixes y decisiones (índice en [`docs/SETUP.md`](docs/SETUP.md)) |
| — | [`app/AGENTS.md`](app/AGENTS.md) | Arquitectura interna de la app (para agentes/mantenedores) |

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
| Wifi | Menú físico "Wifi connect" (AP directo + QR, ver [`docs/wifi.md`](docs/wifi.md)) + interfaz web con chat a los modelos locales, wifi completo (buscar, conectar con contraseña, olvidar redes), USB y batería/CPU/RAM en vivo en `http://<ip-del-dispositivo>:8090` ([`docs/web-ui.md`](docs/web-ui.md)) |
| WiFi Radar | Visualización 3D (Three.js) del espacio WiFi alrededor del Pi, capturado pasivamente con cualquier adaptador USB en modo monitor (detección genérica; probado con Atheros AR9271 y Ralink RT5372) — toggle real/demo y caída a demo con datos simulados si no hay hardware conectado ([`docs/wifiradar.md`](docs/wifiradar.md)) |
| Wardriving | Captura de handshakes para laboratorio/tesis: allowlist explícita de BSSIDs como único mecanismo de autorización, ataques pmkid/deauth con aircrack-ng, sesiones con artifacts descargables desde la web |

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
    python3-pip python3-venv build-essential
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

Copia la carpeta [`app/`](app/) de este repo a la Pi como `~/whisplay-ai-chatbot`
(ya incluye los fixes aplicados, como el de Piper HTTP — ver
[`docs/piper-tts-silent-fix.md`](docs/piper-tts-silent-fix.md) — y la interfaz
de pantalla minimalista con los GIFs de personaje ya generados, ver
[`docs/display-ui.md`](docs/display-ui.md); no hace falta ningún paso extra
para la pantalla):

```bash
rsync -az /ruta/local/akbal-pi/app/ <usuario>@<host-de-la-pi>:~/whisplay-ai-chatbot/
ssh <usuario>@<host-de-la-pi>
cd ~/whisplay-ai-chatbot
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
uso 100% headless, opcional). Logs en `~/whisplay-ai-chatbot/chatbot.log`.

### 10. Verificación de punta a punta

```bash
systemctl status chatbot.service
tail -f ~/whisplay-ai-chatbot/chatbot.log
```

Con el botón del Whisplay HAT: presionar y hablar → debería transcribir, pensar,
y responder por el altavoz. Si transcribe y "piensa" pero no se escucha nada,
revisar [`docs/piper-tts-silent-fix.md`](docs/piper-tts-silent-fix.md) (ya
corregido en `app/`, pero relevante si se actualiza desde el repo original de
PiSugar).

## Estructura del repo

- [`app/`](app/) — código de la aplicación que corre en la Pi (fork de trabajo de
  `whisplay-ai-chatbot`, con nuestros fixes aplicados). Se despliega copiando esta
  carpeta a `~/whisplay-ai-chatbot` en el dispositivo y siguiendo `docs/SETUP.md`.
  No incluye `.env` (usar `app/.env.template` o `setup/akbal.env.example` como base),
  `node_modules`, `dist` ni datos de runtime — todo eso se genera/instala en el
  propio dispositivo.
- [`docs/`](docs/) — bitácora de instalación y fixes encontrados en el camino.
- [`setup/`](setup/) — patches aplicados, `.env` de referencia (sin secretos), y
  los videos originales del personaje en
  [`setup/display-source-videos/`](setup/display-source-videos/).

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
elegido, un menú rápido (click corto en reposo: Modelo/Modo/Ayuda/Cámara/
Volumen/Internet emergencia — este último es un administrador de wifi
básico, ver [`docs/wifi.md`](docs/wifi.md)) y
una pantalla de ayuda (decir "ayuda" con el botón presionado, o elegirla del
menú rápido) que resume los comandos de voz en a lo sumo 2 pantallas.
[`docs/llm-model-selection.md`](docs/llm-model-selection.md) documenta cómo
se eligió el modelo por defecto y por qué el menú de voz ya no cambia de
modelo a ciegas ante un comando mal reconocido (causó una regresión real:
dejó activado un modelo con problemas de eco en respuestas cortas).

Pendiente: wake word (activación por voz sin botón).

---

# Guía de uso: todas las features del dispositivo

Qué es cada cosa, para qué sirve y cómo se usa. Dos superficies de control:
el **dispositivo físico** (botón del Whisplay HAT + pantalla LCD) y el **sitio
web de administración** (`http://<ip-del-dispositivo>:8090`, requiere sesión —
usuario/clave configurados en `WEB_ADMIN_USER`/`WEB_ADMIN_PASSWORD` del `.env`).

## En el dispositivo físico (botón + pantalla)

El botón tiene tres gestos en reposo, y el mismo lenguaje en todos los menús:
**click corto** avanza al siguiente elemento, **mantener ~0.9s** confirma/ejecuta,
**doble clic** cancela/sale sin aplicar nada.

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
| **Modelo** | Elegir modelo de IA entre los descargados en Ollama. Click recorre opciones, mantener confirma (spinner mientras Ollama carga el modelo), doble clic cancela sin cambiar. No reinicia el servicio. |
| **Modo** | Alterna el origen de las respuestas: **"Modo agente"** (conversa vía OpenClaw, un agente externo puenteado por `whisplay-im`) o **"Modo local"** (el LLM corre en la propia Pi). Click navega, mantener confirma; queda persistido en `.env` y el top-bar de la pantalla lo indica (`agent`/`local`). |
| **Audio** | Salida de sonido: **bocina de la Pi** (Whisplay HAT, ALSA directo) o **bocina externa Bluetooth** ya emparejada desde la web (Ajustes → Salida de audio — ahí se escanea, vincula y elimina). Al confirmar una BT el dispositivo la conecta y suelta cualquier otra; ver la sección Ajustes para el detalle. Persiste en `.env`. |
| **Música** | Reproductor dedicado del OST de Cypher con barra de progreso: **click** play/pausa · **doble clic** siguiente pista · **mantener** salir. Muestra título y progreso de la pista actual. |
| **Ayuda** | Pantalla(s) de referencia con todos los comandos de voz y gestos del botón (a lo sumo 2 pantallas). |
| **Cámara** | Abre el modo cámara del dispositivo (solo si hay cámara configurada; el menú la oculta si no): **click corto** captura la foto (se usa como contexto para el LLM si luego lo preguntas) · **mantener 2s** sale. La foto queda en `data/images/`. |
| **Volumen** | Cada **click** sube +10% en vivo (barra de progreso en pantalla); **doble clic** sale sin cambios; mantener también sale. |
| **Wifi connect** | Convierte la wifi de la Pi en un punto de acceso **`akbal-pi`** con QR en pantalla: escanéalo con un celular para conectarte directo (y abrir la web admin). Dos QR navegables con click: wifi y web. En cuanto un teléfono se conecta, salta solo al QR web. **Mantener** desactiva el AP y sale; **doble clic** sale dejándolo activo. |
| **Conexión web** | Muestra la IP LAN y de Tailscale del dispositivo + QR apuntando a la web admin (`http://<ip>:8090`). Es la forma de saber a qué URL conectarse. |
| **WiFi Radar** | Versión de pantalla del radar WiFi (detalle abajo): discos con puntos por red cercana, texto inferior rotando nombre + dBm. **Mantener** para salir. |

El menú se cierra solo tras **60 segundos** sin tocar el botón.

### WiFi Radar (pantalla)

Detección pasiva de redes alrededor del Pi, mostradas como puntos en un radar
(rotación/distanca por hash de BSSID y potencia de señal, respectivamente). La
franja inferior rota entre las redes visibles. Si no hay adaptador USB con modo
monitor conectado muestra "Sin adaptador WiFi compatible"; con el toggle global
en demo muestra datos sintéticos con un prefijo "DEMO · ". Entra desde el menú
rápido; mantener presionado para salir.

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
Solo escucha: nunca transmite nada.

### WARDRIVING (pestaña)

Captura de handshakes para laboratorio/tesis, sobre la misma radio del radar.
Flujo, ciclo de ataque con comandos exactos, modelo de allowlist y sesiones:
ver [`docs/wardrive.md`](./docs/wardrive.md). Resumen:

1. **Entrar** (banner superior) toma la radio en modo monitor — el radar deja de
   capturar hasta que salgas (se retoma solo al salir).
2. La tabla lista las redes visibles (canal, señal, clientes, seguridad).
3. **Autorizar** un BSSID lo agrega al allowlist — el único mecanismo de
   autorización: sin allowlist no hay ataque, no existe el "atacar todo".
4. **Auditar** corre el ataque contra esa red: escaneo → lock de canal →
   captura con airodump-ng → deauth dirigida (si aplica) → validación de
   handshake. El progreso paso a paso se muestra en un modal.
5. Al capturar, los archivos (`.hc22000`, `.cap`) quedan listados abajo para
   descarga desde la web. Todo vive en `~/wardrive-sessions/` en el dispositivo.
6. **REAL/DEMO** (botón en la toolbar): el descubrimiento puede venir de la
   radio real o del mismo generador demo del radar (útil para ensayar la
   interfaz sin hardware; contra redes demo los ataques son inertes).
7. Deauth dirigido: pestaña Deauth — lista dispositivos clientes vistos
   hablando en el aire; cada uno requiere autorización individual de MAC.
8. **Salir** restaura la radio a modo normal y devuelve el control al radar.

### OST (pestaña Música)

Jukebox del OST de Cypher: playlist fija local con play/pausa, siguiente/
anterior y seek. Controla lo mismo que el ítem "Música" del menú físico.

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
- **Respaldos**: crear/descargar/restaurar/eliminar snapshots de configuración.
- **Almacenamiento**: navegación de discos montados con subida/descarga/borrado.
- **Sistema** (ícono ◉ arriba a la derecha, en cualquier pestaña): CPU, RAM,
  disco y wifi en vivo, y logout.

### API HTTP (para integraciones)

Todo lo anterior también es accesible programáticamente bajo `/api/*` con la
misma sesión de cookie: `/api/status`, `/api/chat`, `/api/wifi/scan`,
`/api/wifiradar/snapshot` + `POST /api/wifiradar/mode`
(`{"mode":"live"|"demo"}`), `/api/wardrive/*` (`enter`, `exit`, `source`,
`allowlist`, `attack/one`, ...), `/api/music/*`, `/api/usb/*`, `/api/backup/*`.
Ver `app/src/device/web-admin-server.ts` para la lista completa.
