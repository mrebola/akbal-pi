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
