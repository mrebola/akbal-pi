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
