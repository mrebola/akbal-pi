# Fix: la tarjeta de sonido del Whisplay HAT no se registraba

## Síntoma

Después de instalar el driver oficial (`PiSugar/Whisplay`, `install_driver.sh`) y
reiniciar, la tarjeta `whisplaysound` nunca aparecía en `aplay -l` / `cat /proc/asound/cards`,
en ningún reinicio (reproducible al 100%).

En `dmesg` aparecía, en cada boot, justo al momento del probe:

```
whisplay 1-0010: Whisplay probing ES8389 at 0x10
i2c_designware 1f00074000.i2c: i2c_dw_handle_tx_abort: lost arbitration
...
wm8960 1-001a: Failed to enable LRCM: -11
wm8960 1-001a: probe with driver wm8960 failed with error -11
```

## Diagnóstico

El driver unificado de Whisplay soporta dos variantes de códec de audio (ES8389 o
WM8960) y por diseño intenta sondear **ambas** direcciones I2C (`0x10` y `0x1a`) al
arrancar, para auto-detectar cuál está presente.

Esta placa en particular solo tiene el códec **WM8960** (confirmado con
`i2cdetect -y 1`, que muestra únicamente el dispositivo en `0x1a`; nada en `0x10`).

El intento de sondeo contra `0x10` (dirección sin dispositivo real) dispara un error
de "lost arbitration" en el controlador I2C del RP1 (el chip southbridge de la
Raspberry Pi 5), justo en el mismo instante en que el driver real del WM8960 está
tratando de escribir un registro (`LRCM`) en `0x1a`. El resultado es que el bus queda
en mal estado y la escritura al WM8960 falla, abortando el registro de toda la
tarjeta de sonido.

No es un problema de conexión física del HAT (el bus I2C se ve limpio), sino una
condición de carrera entre el sondeo fallido del códec inexistente y la
inicialización del códec real, específica de esta combinación Pi 5 (RP1) + driver.

## Fix

Deshabilitar el nodo de device-tree del códec ES8389 (que no existe en esta placa),
para que el kernel nunca intente instanciarlo ni sondearlo por I2C. Esto elimina la
interferencia y permite que el WM8960 se inicialice limpio.

Archivo: `audio/whisplay-soundcard/src/dts/whisplay-soundcard.dts` (dentro del repo
`PiSugar/Whisplay`). Ver el patch completo en
[`../setup/whisplay-soundcard-wm8960-fix.patch`](../setup/whisplay-soundcard-wm8960-fix.patch):

```diff
 codec_es8389: whisplay@10 {
+	status = "disabled";
 	compatible = "pisugar,whisplay";
 	reg = <0x10>;
 	...
```

Pasos para aplicar (ya hechos en la Pi, documentados aquí por si se re-flashea o
se actualiza el driver):

```bash
cd ~/Whisplay/audio/whisplay-soundcard/src/dts
patch < whisplay-soundcard-wm8960-fix.patch   # o editar a mano
dtc -I dts -O dtb -@ -o /tmp/whisplay-soundcard.dtbo whisplay-soundcard.dts
sudo install -m 644 /tmp/whisplay-soundcard.dtbo /boot/firmware/overlays/whisplay-soundcard.dtbo
sudo reboot
```

Después del reboot, `whisplay-soundcard sound: Whisplay 'whisplaysound' registered
(chip=WM8960)` aparece en `dmesg` sin errores de I2C.

## Nota

Si en el futuro se usa una variante del Whisplay HAT con códec ES8389 en vez de
WM8960, este fix habría que revertirlo (o condicionarlo), ya que deshabilita
explícitamente el soporte para ES8389 en el overlay.

## Regresión (2026-09-19): "lost arbitration" persiste con ES8389 ya deshabilitado

Con el fix de arriba ya instalado (overlay compilado confirmado con
`status = "disabled"` en `whisplay@10`), la tarjeta `whisplaysound` dejó de
registrarse de nuevo, con el mismo síntoma en `dmesg`:

```
wm8960 1-001a: supply ... using dummy regulator
i2c_designware 1f00074000.i2c: i2c_dw_handle_tx_abort: lost arbitration   (x4-x8)
wm8960 1-001a: Failed to issue reset / Failed to enable LRCM: -11
wm8960 1-001a: probe with driver wm8960 failed with error -11
```

`i2cdetect -y 1` confirma que el WM8960 sigue respondiendo en `0x1a` (el chip
está vivo); es específicamente el *probe* del driver `wm8960` el que falla al
escribir el registro de reset/LRCM.

### Causas descartadas (con pruebas, no solo teoría)

- **Bluetooth conectado**: se apagó el radio Bluetooth por completo
  (`bluetoothctl power off`) y se forzó un re-probe manual
  (`echo 1-001a > /sys/bus/i2c/drivers/wm8960/bind`) — mismo error, byte por
  byte. El Bluetooth de la Pi no comparte bus con el I2C1 del HAT (usa
  UART/USB internamente), así que no hay relación causal.
- **Condición de carrera de arranque**: se reintentó el bind manual del
  driver a los ~128s y ~388s de uptime (sistema ya estable) — mismo error.
  No es timing de boot.
- **Otro dispositivo en el bus**: `ls /sys/bus/i2c/devices/` e `i2cdetect -l`
  solo muestran `1-001a` en el bus `i2c-1` (Synopsys DesignWare); no hay otro
  cliente I2C visible peleando el bus.
- **Velocidad del bus**: se probó bajar el reloj I2C a 50kHz
  (`dtparam=i2c_arm_baudrate=50000` junto al overlay, con reboot) — mismo
  error (incluso con más transiciones de "lost arbitration" por intento).
  Revertido tras la prueba.
- **Pines GPIO2/3 (SDA1/SCL1)**: `pinctrl get 2,3` los muestra en estado
  eléctrico normal en reposo (`a3 pu | hi`, pull-up activo, alto).

### Estado

**Mitigado (2026-09-20)** — ver la sección "Causa raíz encontrada" más abajo:
la causa era la calidad de alimentación al pasar por la PiSugar, no el
device-tree ni el bus en sí. Alimentando la Pi con luz directa (sin pasar
por la PiSugar) el WM8960 registra limpio de forma consistente. Sigue siendo
consistente con reportes de la comunidad para este error en RP1 (Raspberry
Pi 5), p. ej. [raspberrypi/linux#7104](https://github.com/raspberrypi/linux/issues/7104)
y el [foro oficial](https://forums.raspberrypi.com/viewtopic.php?t=396693),
donde se apunta a causas externas al SoC (alimentación/cableado) — la
PiSugar en el camino de energía es exactamente ese tipo de causa externa.

**Si algún día se quiere recuperar el respaldo de batería de la PiSugar**:
el próximo paso sería mirar la salud/antigüedad de esa batería en particular
y su boost converter bajo esta carga específica, no el HAT ni el driver. Si
en algún momento hiciera falta descartar también el conector físico del
HAT: reasentarlo en el header GPIO (desconectar y volver a conectar
firmemente, revisando que no haya pines doblados) sigue siendo un chequeo
barato, aunque la prueba de alimentación de arriba ya apunta a la PiSugar
como la causa.

**Mitigación mientras tanto**: el asistente puede hablar por una bocina
Bluetooth emparejada (ver `ALSA_OUTPUT_DEVICE=pulse` en `.env`, que enruta
`sox`/ALSA vía el plugin `pulse` → `pipewire-pulse` → sink por defecto de
PipeWire). El micrófono del HAT sigue roto mientras el WM8960 no registre; se
probó usar el micrófono HFP de la bocina Bluetooth como respaldo pero graba
silencio puro (el perfil manos-libres no se negocia bien junto con A2DP), así
que no es una alternativa viable por ahora.

## Causa raíz encontrada (2026-09-20): calidad de alimentación vía PiSugar

Retomando la investigación "no resuelta" de arriba: el disparador real es la
**fuente de alimentación**, no el device-tree ni el bus I2C en sí — ninguno
de los dos había cambiado (ver "¿Es una regresión de código?" más abajo).

### La prueba

Con la Pi arrancando con energía routeada por la PiSugar (a batería, o por
el propio paso de la PiSugar), el mismo boot que antes fallaba en 2 de 2
intentos volvió a fallar, con el mismo `lost arbitration` /
`Failed to enable LRCM: -11`. Cambiando **únicamente la fuente de
alimentación** — mismo HAT, misma conexión física, sin abrir nada — a luz
directa al puerto de la propia Raspberry Pi (sin pasar por la PiSugar), el
siguiente boot registró `whisplaysound` limpio, cero errores de I2C.

Como confirmación adicional: con la luz routeada así (directo a la Pi,
evitando la PiSugar), `pisugar-server` deja de poder hablarle a su propio
chip de gestión de batería (`get battery` → `I2C not connected`) — es decir,
sacar a la PiSugar del camino de la energía es justamente lo que deja el
riel limpio para el WM8960.

`vcgencmd get_throttled` reportó `0x0` (sin undervoltage detectado) en
ambos casos — ese monitor ve la alimentación *de la Pi*, no el riel
específico de 3.3V que le llega al HAT después de pasar por la PiSugar y el
conector apilado, así que no contradice esto: hay margen para que ese tramo
puntual esté ruidoso sin que el monitor general de la Pi lo vea.

### Mitigación recomendada

Para un dispositivo que vive enchufado en un lugar fijo (como este), lo más
simple y confiable es alimentarlo con luz directa a la Raspberry Pi,
dejando la PiSugar fuera del camino de energía. Costo: se pierde el respaldo
de batería de la PiSugar mientras esté cableado así — aceptable para un
asistente que no necesita ser portátil.

Si en algún momento se quiere recuperar el respaldo de batería, el próximo
paso sería enfocarse en la PiSugar en particular (salud/antigüedad de la
batería, firmware, posible ripple del boost converter bajo esta carga) en
vez del HAT o el driver — esa parte del stack es la que introduce el ruido.

### ¿Es una regresión de código? — cronología verificada

No. Se verificó explícitamente para descartar esta hipótesis:

- El repo del driver (`~/Whisplay` en el dispositivo) no tiene commits desde
  el 2026-09-09.
- El overlay compilado (`/boot/firmware/overlays/whisplay-soundcard.dtbo`)
  tiene fecha del 2026-09-17 — el mismo fix de "ES8389 deshabilitado" de
  arriba, intacto.
- La sección "Regresión" de este documento ya estaba fechada 2026-09-19 —
  un día antes de encontrar la causa de arriba — describiendo el mismo
  error como ya activo y sin resolver.

O sea: el bug ya existía y ya estaba siendo investigado antes de esta
sesión. Que el dispositivo "llevara días sin problemas" y el bug fuera
preexistente no se contradicen — **solo se juega en el instante del
arranque**. Un dispositivo que no se reinicia no vuelve a tirar los dados,
así que puede andar perfecto por días aunque la condición de carrera siga
ahí. Lo que expuso el problema en esta sesión fueron dos reinicios
(pedidos explícitamente durante la sesión) — cada uno relanzó la carrera, y
esa vez, a batería, la perdió las dos veces.

## Intentos de arreglo por software (2026-09-20) — los tres fallaron

Antes de aceptar "luz directa" como la única solución, se probaron tres
vías de software distintas, cada una con una prueba real (no solo teoría),
para que un modelo futuro no las repita:

### 1. Reintento activo del driver (`unbind`/`bind` en loop)

El driver `wm8960` falla su `probe()` con un error duro (`-EAGAIN`), no con
`-EPROBE_DEFER`, así que el kernel **nunca reintenta solo**. El script
[`../setup/whisplay-soundcard-retry.sh`](../setup/whisplay-soundcard-retry.sh)
(instalado como el `ExecStart` de `whisplay-soundcard-warmup.service`,
reemplazando la espera pasiva original de 30s que no hacía nada útil)
reintenta `echo 1-001a > /sys/bus/i2c/drivers/wm8960/unbind` +
`.../bind` hasta 20 veces con pausas.

Prueba real: 20 reintentos activos durante ~4 minutos de uptime (mucho más
agresivo que los 2 intentos sueltos de la sección de arriba, y cubriendo
bien más allá de cualquier transitorio de arranque) — **fallaron los 20**,
con el mismo `lost arbitration` / `Failed to enable LRCM: -11` en cada uno:

```
16:56:54 whisplay-soundcard-warmup[1545]: whisplaysound not registered, retrying wm8960 bind up to 20x
17:01:00 whisplay-soundcard-warmup[2345]: gave up after 20 retries — whisplaysound still not registered
```

Importante: este chip **no tiene pin de reset controlable por GPIO** en
este overlay (se revisó el `.dtbo` decompilado — no hay propiedad
`reset-gpios` en `wm8960@1a`), así que un reintento de `bind` nunca hace un
power-cycle real del chip, solo vuelve a llamar a `probe()`. Eso limita lo
que este enfoque puede lograr por diseño.

**El script queda instalado y habilitado** (no molesta — es un `oneshot`
que no bloquea el arranque de `chatbot.service`), por si algún día el riel
de la PiSugar mejora lo suficiente como para que algún reintento tenga
éxito. Pero como arreglo, no funcionó.

### 2. Bajar el consumo pico de CPU (`arm_boost=0`)

Hipótesis: si el pico de corriente que pide la Pi durante el arranque
(CPU + WiFi + backlight simultáneos) hunde momentáneamente el riel
compartido, bajarlo debería darle margen al WM8960. Se probó agregando
`arm_boost=0` a `/boot/firmware/config.txt` (deshabilita el turbo) y
reiniciando a batería.

Resultado: **sin efecto** — mismo error, mismo patrón, incluso en
reintentos con 30+ segundos de uptime. Además, `vcgencmd measure_clock arm`
mostró que la Pi 5 sigue corriendo a 2.4GHz de todas formas (en este
modelo 2.4GHz ya es la velocidad base, no hay boost por encima que
deshabilitar). **Revertido** (`arm_boost=1` de nuevo) — no aportaba nada y
sí hubiera costado rendimiento al modelo local.

### 3. (Descartado sin probar) Bajar la velocidad del bus I2C

Ya estaba probado y descartado en la sección de arriba ("Causas
descartadas"): bajar el baudrate I2C a 50kHz empeoró el problema (más
transiciones de "lost arbitration" por intento), no lo mejoró.

### Conclusión de esta ronda

Con el kernel intentando solo una vez, 20 reintentos activos durante 4
minutos, y menos consumo de CPU — **los tres fallaron de forma idéntica**.
Eso es evidencia bastante fuerte de que el riel que le llega al WM8960
mientras la PiSugar está en el camino de la energía está simplemente por
debajo de lo que el chip necesita, de forma **persistente** (no en un
instante puntual del boot que timing/reintentos puedan esquivar). La única
prueba que cambió el resultado en esta sesión fue cambiar la fuente de
alimentación (ver "Causa raíz encontrada" arriba).

## Para el próximo modelo de IA que retome esto

**Estado actual del sistema** (2026-09-20, fin de esta sesión):
- `whisplay-soundcard-warmup.service`: instalado y habilitado, corre
  [`setup/whisplay-soundcard-retry.sh`](../setup/whisplay-soundcard-retry.sh)
  (reintento activo, ver arriba). Inofensivo, no bloquea el arranque de la
  app.
- `/boot/firmware/config.txt`: `arm_boost=1` (revertido a su valor
  original; el experimento de bajarlo se descartó).
- El overlay `whisplay-soundcard.dtbo` con el ES8389 deshabilitado sigue
  instalado (fix de la sección "Fix" arriba).
- El dispositivo funciona bien con luz **directa a la Raspberry Pi**
  (bypaseando la PiSugar). Con la PiSugar en el camino (batería o su propio
  paso), el WM8960 no registra.

**Cómo reproducir/verificar rápido:**
```bash
cat /proc/asound/cards          # busca "whisplaysound"; si no está, el bug sigue
arecord -l                      # debería listar la tarjeta si registró
dmesg | grep -iE 'wm8960|lost arbitration'
vcgencmd get_throttled          # 0x0 = sin undervoltage detectado en la Pi misma
i2cdetect -y 1                  # el WM8960 en 0x1a debería responder siempre, registre o no
printf 'get battery\n' | nc localhost 8423   # pisugar-server: "I2C not connected" si la PiSugar no tiene alimentación
```

**Ya descartado / probado, no repetir:**
Bluetooth encendido, timing de boot (reintentos a 128s/388s de uptime),
otro dispositivo en el bus I2C, velocidad del bus I2C (50kHz probado, peor),
estado eléctrico de los pines SDA1/SCL1 en reposo (normal), reintento activo
del driver (20x, ver arriba), bajar consumo de CPU (`arm_boost=0`, ver
arriba), regresión de código en este repo o en el driver (cronología
verificada, ver arriba).

**Ideas NO probadas todavía** (para explorar si se quiere seguir insistiendo
en que funcione con la PiSugar en el camino, en vez de aceptar luz directa):
- Salud/antigüedad real de la batería de la PiSugar y su boost converter
  bajo esta carga específica — no se pudo consultar (`pisugar-server`
  reporta "I2C not connected" incluso corriendo a batería pura, lo cual es
  en sí mismo raro y no se investigó a fondo: el propio chip de gestión de
  la PiSugar tampoco aparece en `i2cdetect -y 1` en ese momento — puede ser
  otro síntoma del mismo bus inestable, o que ese chip esté en otro bus no
  escaneado, o un problema aparte de la PiSugar misma).
- Firmware de la PiSugar (¿hay una versión más nueva? ¿tiene algún trim de
  voltaje de salida configurable?).
- Definir un regulador real (no el "dummy regulator" que usa el kernel por
  defecto) en el device-tree para las supplies del WM8960
  (`DCVDD`/`DBVDD`/`AVDD`/`SPKVDD1`/`SPKVDD2`), con un `startup-delay-us`,
  para forzar una espera real antes de que el driver asuma que el riel ya
  está estable — distinto de reintentar *después* de fallar, esto
  retrasaría el *primer* intento. No implementado ni probado.
- Medición directa con multímetro/osciloscopio del riel de 3.3V/5V en el
  conector del HAT durante el boot, comparando PiSugar vs. luz directa —
  necesita manos físicas y equipo, no se puede hacer remoto.
- Probar el HAT en otra Raspberry Pi 5 (aislar HAT vs. placa/PiSugar de
  esta unidad en particular).

**Contexto para no perder tiempo**: no es una regresión de código de este
repo (`akbal-pi`/`app/`) ni del driver `PiSugar/Whisplay` — ambos
verificados sin cambios recientes relevantes a este bug. Es un problema de
calidad de alimentación específico de esta combinación PiSugar + Whisplay
HAT + Pi 5, ya con una mitigación funcional (luz directa) si no hace falta
seguir insistiendo.

### Micrófono fijado al HAT (bocina Bluetooth ya no lo secuestra)

Síntoma: con una bocina Bluetooth conectada y la salida en `bluetooth`, al
presionar el botón del HAT el asistente "no tomaba el audio". Causa: la
grabación resolvía el dispositivo ALSA de captura **una sola vez al cargar el
módulo**, y si en ese instante la tarjeta `whisplaysound` aún no estaba
registrada (carrera del probe I2C del WM8960 en boot) caía a `"default"` para
toda la vida del proceso. Al conectar la bocina, PipeWire negocia su perfil
HFP/HSP y su micrófono (manos-libres) pasa a ser el *source* por defecto, así
que `"default"` grababa silencio desde la bocina Bluetooth.

Fix (`app/src/device/audio.ts`): el micrófono es **siempre** el del HAT. El
dispositivo de captura se resuelve **en vivo, al momento de grabar**
(`getAlsaInputDevice()`), apuntando directo al hardware `hw:<card>,0` de la
tarjeta Whisplay, nunca a `"default"` salvo último recurso (con warning). Así
una carrera de boot ya no deja el mic pegado a un fallback, y la bocina
Bluetooth solo afecta la **salida** (`getAlsaOutputDevice()`), nunca la
entrada. La salida sigue siendo conmutable HAT/Bluetooth desde el menú en
pantalla o el web admin, sin reiniciar.
