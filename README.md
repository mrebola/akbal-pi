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
| Voz→texto (ASR) | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (modelo `base`, español) |
| Texto→voz (TTS) | [Piper](https://github.com/OHF-Voice/piper1-gpl) (voz `es_MX-claude-high`) |
| Batería | [PiSugar Power Manager](https://github.com/PiSugar/pisugar-power-manager-rs) |
| Orquestación | [whisplay-ai-chatbot](https://github.com/PiSugar/whisplay-ai-chatbot) |

Detalle completo del setup en [`docs/SETUP.md`](docs/SETUP.md).

## Instalación: cómo montar todo desde cero

Guía completa para replicar el dispositivo, desde el armado físico hasta tener el
chatbot respondiendo por voz. Asume una Raspberry Pi 5 nueva y acceso por SSH
(en nuestro caso, vía Tailscale).

### 1. Armado físico

1. Inserta la microSD en la Raspberry Pi 5 (se flashea en el paso 2, puede ir antes o después de armar).
2. Monta el enfriador activo oficial sobre el SoC de la Pi 5 (pads térmicos + conector del ventilador al header `FAN`).
3. Monta el **PiSugar 3 Plus** en la parte de abajo de la Pi (se conecta por pogo-pins, no ocupa el header GPIO) y conecta la batería 5000mAh al conector JST del PiSugar.
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

### 6. LLM local (Ollama)

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:1.7b
```

`qwen3:1.7b` (Q4_K_M, ~1.4GB) da un buen balance velocidad/calidad en CPU para
un Pi 5 de 8GB. Se puede cambiar por otro modelo de [ollama.com/library](https://ollama.com/library)
ajustando `OLLAMA_MODEL` en el `.env`.

### 7. ASR y TTS locales (faster-whisper + Piper)

```bash
pip install faster-whisper 'piper-tts[http]' --break-system-packages
mkdir -p ~/piper && cd ~/piper
python3 -m piper.download_voices es_MX-claude-high   # o la voz que prefieras
```

Estos dos paquetes no vienen en `python/requirements.txt` de la app: son
opcionales según qué backend de ASR/TTS elijas en el `.env` (acá se usan los
locales, sin depender de APIs de nube).

### 8. La app (Akbal)

Copia la carpeta [`app/`](app/) de este repo a la Pi como `~/whisplay-ai-chatbot`
(ya incluye los fixes aplicados, como el de Piper HTTP — ver
[`docs/piper-tts-silent-fix.md`](docs/piper-tts-silent-fix.md)):

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
- [`setup/`](setup/) — patches aplicados y `.env` de referencia (sin secretos).

## Estado

Primera versión completa corriendo en la Raspberry Pi, con flujo de voz de punta a
punta probado en el hardware físico (botón → graba → transcribe → responde → se
escucha): driver de audio del Whisplay HAT, LLM/ASR/TTS locales, batería PiSugar, y
el chatbot como servicio systemd (`chatbot.service`, arranque automático). Ver
[`docs/SETUP.md`](docs/SETUP.md) para el detalle, y
[`docs/whisplay-audio-fix.md`](docs/whisplay-audio-fix.md) /
[`docs/piper-tts-silent-fix.md`](docs/piper-tts-silent-fix.md) para los bugs de
hardware/software que se encontraron y arreglaron durante la instalación, y
[`docs/performance-tuning.md`](docs/performance-tuning.md) para la optimización
de velocidad del ASR (~3x más rápido, de 5.2s a 1.8s por transcripción).

Pendiente: wake word (activación por voz sin botón).

## Notas de seguridad

Este repositorio es público. No se deben commitear credenciales, tokens, claves de API ni ningún otro dato sensible. Usar variables de entorno o archivos ignorados por git (`.gitignore`) para configuración local.
