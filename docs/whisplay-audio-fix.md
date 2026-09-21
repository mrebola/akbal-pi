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

**Resuelto (2026-09-20, sesión 2)** — ver "Causa raíz real" más abajo: el
MCU de la PiSugar 3 comparte el bus I2C1 con el WM8960 y, en su estado
actual, corrompe las escrituras al códec. Aislar sus pogo pins de SDA/SCL
con cinta lo arregla conservando el respaldo de batería. La sección
"Causa raíz encontrada: calidad de alimentación" que sigue quedó
**superada**: la observación (con PiSugar falla, sin PiSugar no) era
correcta, la explicación no.

**Mitigación mientras tanto**: el asistente puede hablar por una bocina
Bluetooth emparejada (ver `ALSA_OUTPUT_DEVICE=pulse` en `.env`, que enruta
`sox`/ALSA vía el plugin `pulse` → `pipewire-pulse` → sink por defecto de
PipeWire). El micrófono del HAT sigue roto mientras el WM8960 no registre; se
probó usar el micrófono HFP de la bocina Bluetooth como respaldo pero graba
silencio puro (el perfil manos-libres no se negocia bien junto con A2DP), así
que no es una alternativa viable por ahora.

## Causa raíz encontrada (2026-09-20): calidad de alimentación vía PiSugar

> **Superada** por "Causa raíz real" más abajo. Se conserva porque las
> observaciones son correctas y los pasos de prueba siguen siendo útiles;
> la interpretación ("riel ruidoso") resultó incorrecta.

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

> **Actualizado al final de la sesión 2 (2026-09-20)**: el bug está
> resuelto, ver "Causa raíz real" más abajo. Lo que sigue en esta sección
> es el estado al final de la sesión 1 más las correcciones marcadas.

**Estado actual del sistema** (2026-09-20, fin de la sesión 2):
- `whisplay-soundcard-warmup.service`: instalado y habilitado, corre
  [`setup/whisplay-soundcard-retry.sh`](../setup/whisplay-soundcard-retry.sh)
  (reintento activo, ver arriba). Inofensivo, no bloquea el arranque de la
  app. Ya no hace falta para este bug.
- `/boot/firmware/config.txt`: `arm_boost=1` (revertido a su valor
  original; el experimento de bajarlo se descartó).
- El overlay `whisplay-soundcard.dtbo` con el ES8389 deshabilitado sigue
  instalado (fix de la sección "Fix" arriba).
- **PiSugar montada y alimentando la Pi, con sus pogo pins de SDA/SCL
  (pines 3 y 5 del header) aislados con cinta.** El WM8960 registra limpio
  en cada boot; `pisugar-server` reporta `I2C not connected` (esperado, la
  PiSugar ya no está en el bus).

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

**Ideas de la sesión 1 que quedaron sin probar — resueltas en la sesión 2:**
- Salud/batería/boost converter de la PiSugar → **descartado**: los rieles
  medidos por el PMIC de la Pi 5 son perfectos con el bug activo (ver
  "Causa raíz real", punto 1). El "I2C not connected" de `pisugar-server`
  que aquí se anotó como "raro" era la pista clave: el MCU de la PiSugar
  está en el bus pero no responde, y es él quien lo corrompe.
- Firmware de la PiSugar → **no se puede consultar ni actualizar hoy** (el
  MCU no responde en I2C, y `pisugar-programmer` lo necesita). Ver "Si se
  quiere recuperar la telemetría".
- Regulador con `startup-delay-us` en el device-tree → **no tiene sentido
  probarlo**: la falla no es de timing ni de riel, es una tabla de verdad
  sobre el contenido del byte (ver punto 3). Un retraso del primer intento
  no cambia nada; ya se demostró con reintentos a minutos de uptime.
- Multímetro/osciloscopio → **innecesario**: `vcgencmd pmic_read_adc` mide
  los rieles reales de forma remota.
- Probar el HAT en otra Pi 5 → **innecesario**: se aisló la variable con
  la cinta en los pogo pins (mismo HAT, misma Pi, misma PiSugar).

**Contexto para no perder tiempo**: no es una regresión de código de este
repo (`akbal-pi`/`app/`) ni del driver `PiSugar/Whisplay` — ambos
verificados sin cambios recientes relevantes a este bug. Tampoco es
alimentación. Es el MCU de la PiSugar 3 corrompiendo el bus I2C1
compartido; aislarlo del bus lo resuelve.

## Causa raíz real (2026-09-20, sesión 2): el MCU de la PiSugar 3 corrompe el bus I2C

> **Corrige la sección "Causa raíz encontrada" de arriba.** La conclusión
> "calidad de alimentación" era la interpretación equivocada de una
> observación correcta (con PiSugar falla, sin PiSugar funciona). La causa
> no es el riel: es que la PiSugar 3 **comparte el bus I2C1** (GPIO2/3,
> pines 3 y 5 del header) con el WM8960, y su MCU, cuando está activo,
> sostiene SDA en bajo ante ciertas secuencias de bits.

### 1. Los rieles están perfectos (descarta "alimentación")

El PMIC de la Pi 5 mide los rieles reales, remoto, sin multímetro:

```
$ vcgencmd pmic_read_adc
   3V3_SYS_V volt(9)=3.31003300V
     EXT5V_V volt(24)=5.01428000V
   1V8_SYS_V volt(10)=1.78754400V
$ vcgencmd get_throttled
throttled=0x0
```

Medido **con la Pi arrancada a batería vía PiSugar y el bug activo**. Además,
el 3.3V del HAT lo genera el PMIC de la propia Pi a partir del 5V — la
PiSugar solo inyecta 5V al header; no hay "riel de 3.3V que pase por la
PiSugar". La hipótesis del riel ruidoso era físicamente incorrecta.

### 2. `pisugar-server` no es la causa (nunca se había probado apagarlo)

Con `sudo systemctl stop pisugar-server` (nadie más tiene `/dev/i2c-1`
abierto, verificado con `fuser`) y un `bind` manual del driver: mismo
`lost arbitration` / `Failed to enable LRCM: -11`. El tráfico del demonio
no influye.

### 3. La falla es una tabla de verdad, no ruido

Con el driver sin bindear, escrituras crudas al WM8960 con `i2ctransfer`:

```
$ sudo i2ctransfer -y 1 w1@0x1a 0x08    # OK, 10/10
$ sudo i2ctransfer -y 1 w1@0x1a 0x04    # FALLA 10/10: "Resource temporarily unavailable" (-EAGAIN = ARB_LOST)
$ sudo i2ctransfer -y 1 w1@0x20 0xff    # dirección vacía: NACK limpio ("Remote I/O error"), NO arb-lost
$ sudo i2cdetect -y 1                   # 0x1a responde (transacción de solo-dirección)
```

Barrido completo de los 256 valores posibles del primer byte de datos,
**dos pasadas, resultado idéntico byte por byte**:

```
Fallan siempre (43): 0x04-0x07 0x30-0x3f 0x53 0x66 0x67 0x73 0x82 0x83
                     0x98-0x9f 0xb3 0xc1 0xcc-0xcf 0xe6 0xe7 0xf3
Pasan siempre (213): todos los demás
```

Y las secuencias exactas del driver:

```
w2@0x1a 0x1e 0x00   # reset (R15)            OK
w2@0x1a 0x30 0x04   # LRCM (R24 |= 0x4)      FALLA  ← "Failed to enable LRCM: -11"
```

Interpretación: la dirección `0x1a` recibe ACK (por eso `i2cdetect` lo ve),
pero al enviar el byte de datos *alguien* pone SDA en bajo justo cuando el
master del RP1 está transmitiendo un `1` → `ARB_LOST`. Que dependa del
**valor** del byte con determinismo perfecto significa que es la **lógica
de otro esclavo I2C** reaccionando a la secuencia de bits (máquina de
estados desincronizada que mete un ACK a destiempo), no un riel, no
capacitancia ni tiempo de subida (0xff pasa; 0x30 falla aunque 0x10 y 0x20
pasan por separado).

### 4. Ese otro esclavo es el MCU de la PiSugar 3

- La PiSugar 3 vive en I2C1 (`0x57` MCU, `0x68` RTC). Con la Pi
  **alimentada por la PiSugar** (switch ON), ninguna de las dos direcciones
  responde (`i2cget`/`i2ctransfer` → `Remote I/O error`;
  `pisugar-server` → `Poll error: Remote I/O error (os error 121)` cada
  segundo). El MCU está eléctricamente en el bus pero su esclavo I2C no
  contesta a su propia dirección: está en un estado inconsistente.
- En el modo "luz directa" que funciona, la PiSugar sigue **apilada y con
  batería, pero con el switch OFF** → MCU inactivo en el bus → el WM8960
  registra limpio siempre.
- Con el switch ON el MCU está vivo (LEDs de batería responden al botón)
  pero no habla I2C. Exactamente el perfil de
  [PiSugar#195](https://github.com/PiSugar/PiSugar/issues/195) (MCU
  "atascado", `Remote I/O error 121`, sigue alimentando la Pi) y de
  [PiSugar#63](https://github.com/PiSugar/PiSugar/issues/63) (la PiSugar
  hace inaccesibles a otros dispositivos del mismo bus sin conflicto de
  direcciones).
- El firmware 1.24 de la PiSugar 3 agregó "protección de escritura I2C para
  evitar corrupción de datos" ([doc oficial](https://github.com/PiSugar/pisugar-power-manager-rs/blob/master/doc/pisugar3.md))
  — el fabricante reconoce que su MCU interpretaba tráfico ajeno como
  escrituras propias.

### 5. Pruebas físicas (con manos en el equipo)

**Prueba A — reset duro del MCU: no lo arregla.** Switch OFF, batería y
USB-C de la PiSugar desconectados ~15 s, reconectar, arrancar a batería.
Resultado: `0x57`/`0x68` siguen ausentes, `whisplaysound` no registra. La
huella de bytes que fallan **cambió** (73 valores en vez de 43, superset de
los 43 originales — se sumaron p. ej. `0x0d 0x0f 0x1a 0x20 0x50 0xff`):
la máquina de estados del esclavo arranca desalineada de forma distinta en
cada encendido, pero siempre rota. `w2 0x1e 0x00` (reset) OK, `w2 0x30 0x04`
(LRCM) FALLA, igual que siempre.

**Prueba B — aislar SDA/SCL de la PiSugar: LO ARREGLA.** Cinta aislante
(3M 2210, una capa) sobre los pogo pins de la PiSugar que tocan los pines
**3 (SDA1) y 5 (SCL1)** del header GPIO; 5V/GND (pines 2/4/6) libres. Pi
arrancada **a batería, vía PiSugar, USB-C desenchufado**:

```
[    3.329730] whisplay-soundcard sound: Whisplay 'whisplaysound' registered (chip=WM8960)
$ sudo dmesg | grep -ciE 'arbitration|wm8960.*fail'
0
$ grep -i whisplay /proc/asound/cards
 2 [whisplaysound  ]: whisplaysound - Whisplay Sound
$ arecord -D hw:whisplaysound,0 -f S16_LE -r 16000 -c 2 -d 2 /tmp/mic.wav && sox /tmp/mic.wav -n stat
RMS     amplitude:     0.018481      # señal real de ambiente, no silencio
$ speaker-test -D hw:whisplaysound,0 -c 2 -t sine -f 440 -l 1   # suena
$ od -An -tu4 --endian=big /proc/device-tree/chosen/power/usbpd_power_data_objects
 0 0 0 0                              # sin negociación USB-PD: alimentación por header
```

Mismo HAT, misma PiSugar, misma batería, mismo kernel, mismo overlay. Lo
único que cambió respecto al boot fallido anterior fue quitar al MCU de la
PiSugar del bus I2C. **Causa raíz confirmada.**

### Estado recomendado (nuevo)

- **PiSugar montada y alimentando la Pi, con sus pogo pins de SDA/SCL
  (pines 3 y 5) aislados con cinta.** Se conserva el respaldo de batería.
  Ver diagrama y procedimiento en "Qué pines se tapan" abajo.
  Se pierde la telemetría de la PiSugar por software (`pisugar-server`
  seguirá diciendo `I2C not connected`; es inofensivo, y se puede
  deshabilitar con `sudo systemctl disable --now pisugar-server` para que
  no llene el journal cada segundo).
- Alternativa igual de válida si no hace falta batería: luz directa al
  USB-C de la Pi con el switch de la PiSugar en OFF (la mitigación anterior;
  funciona por la misma razón — MCU inactivo en el bus).
- El overlay con ES8389 deshabilitado y el servicio de reintento
  `whisplay-soundcard-warmup` quedan como estaban; ya no hacen falta para
  este bug pero no molestan.

### Qué pines se tapan (diagrama)

La PiSugar 3 no se enchufa al header: apoya **pogo pins** (contactos de
resorte) contra los stubs soldados del header GPIO por la cara inferior de
la Pi. Solo usa el extremo del header donde está el pin 1: 5V (2, 4), GND
(6) y el I2C1 (3 = SDA, 5 = SCL). Hay que tapar únicamente los dos del I2C.

Header GPIO de 40 pines de la Pi 5, visto **desde arriba**, extremo del
pin 1 (el más cercano a la ranura microSD / puerto USB-C):

```
  borde de la placa ─────────────────────────────────────────────►
          pin 2     pin 4     pin 6     pin 8     pin 10
         ┌─────┐   ┌─────┐   ┌─────┐   ┌─────┐   ┌─────┐
         │ 5V  │   │ 5V  │   │ GND │   │TXD  │   │RXD  │  ...   fila del borde (pares)
         └─────┘   └─────┘   └─────┘   └─────┘   └─────┘
         ┌─────┐   ╔═════╗   ╔═════╗   ┌─────┐   ┌─────┐
         │3V3 ■│   ║SDA1 ║   ║SCL1 ║   │GPIO4│   │ GND │  ...   fila interior (impares)
         └─────┘   ╚═════╝   ╚═════╝   └─────┘   └─────┘
          pin 1     pin 3     pin 5     pin 7     pin 9
             ▲        ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
   pad CUADRADO       TAPAR ESTOS DOS (SDA1 / SCL1 = I2C1)
   (referencia)       dejar libres 2, 4 y 6 (energía de la PiSugar)
```

- El **pin 1 tiene el pad cuadrado** en la PCB (el resto son redondos): es
  la referencia para contar. Los impares son la fila interior; los pares, la
  fila que corre pegada al borde de la placa.
- Pines **3 y 5** = fila interior, 2.º y 3.º contando desde el pin 1.
- La cinta puede ir en cualquiera de los dos lados del contacto, con el
  mismo efecto:
  - sobre los **pogo pins de la PiSugar** (misma grilla de 2.54 mm, en
    espejo: poner ambas placas lado a lado orientadas igual para ubicarlos), o
  - sobre los **stubs de los pines 3 y 5 en la cara inferior de la Pi**
    (más fácil de identificar por el pad cuadrado del pin 1).
- Cinta usada: aislante de vinilo (3M 2210), un trozo angosto, **una sola
  capa**, bien presionado para que el resorte del pogo no la perfore.
  Kapton también sirve. No cubrir 5V ni GND o la PiSugar no alimenta la Pi.
- Verificación tras el boot: `cat /proc/asound/cards` lista `whisplaysound`;
  `sudo dmesg | grep -c 'lost arbitration'` da `0`; `sudo i2cdetect -y 1`
  muestra `UU` en `0x1a` (driver bindeado) y nada en `0x57`/`0x68` (la
  PiSugar ya no está en el bus, que es la idea).

### Recuperar la telemetría de la PiSugar: diagnóstico del MCU (2026-09-20)

Objetivo: distinguir "MCU muerto" de "MCU desincronizado por el tráfico del
HAT" (bug de firmware anterior a la protección de escritura de 1.24, que sí
tendría arreglo por software) o "mal contacto de los pogo pins".

**Prueba C — PiSugar sola en el bus (HAT desmontado, sin cinta, a batería):
muda.** Sin ningún otro dispositivo generando tráfico:

```
$ sudo i2cdetect -y -a 1        # -a = las 128 direcciones, incl. 0x00-0x02 y 0x78-0x7f
(todo "--")
$ sudo i2cdetect -y -a -r 1     # modo lectura en vez de quick-write
(todo "--")
$ sudo i2cget -y 1 0x57 0x2a ; sudo i2cget -y 1 0x57 0xe2   # % batería, versión de fw
Error: Read failed
```

Repetido 5 veces en 10 s (por si aparecía intermitente, como en
[PiSugar#63](https://github.com/PiSugar/PiSugar/issues/63)): nada. Los
rieles siguen perfectos (`EXT5V=4.99V`, sin USB-PD → alimenta la PiSugar).

**Prueba D — bus bit-bang a 10 kHz: muda igual.** Por si el esclavo del
MCU estuviera vivo pero demasiado lento/desincronizado para el controlador
hardware del RP1, se reemplazó el controlador por `i2c-gpio` en los mismos
pines, sin reboot:

```
sudo systemctl stop pisugar-server
echo 1f00074000.i2c | sudo tee /sys/bus/platform/drivers/i2c_designware/unbind
sudo pinctrl set 2,3 ip pu
sudo dtoverlay i2c-gpio i2c_gpio_sda=2 i2c_gpio_scl=3 i2c_gpio_delay_us=50   # ~10 kHz
sudo i2cdetect -l                    # aparece un adaptador nuevo (i2c-15 en este caso)
sudo i2cdetect -y -a 15              # todo "--"; i2cget 0x57/0x68 → Read failed
# volver atrás:
sudo dtoverlay -r i2c-gpio; sudo pinctrl set 2,3 a3 pu
echo 1f00074000.i2c | sudo tee /sys/bus/platform/drivers/i2c_designware/bind
sudo systemctl start pisugar-server
```

**Descartado por el camino**: detectar la presencia eléctrica de la PiSugar
midiendo pull-ups externos (`pinctrl set 2,3 ip pd` → siguen `hi`) **no
sirve** en Pi 5: la placa trae pull-ups de 1.8 kΩ a 3.3 V en GPIO2/3, así
que leen alto con o sin PiSugar. El journal no es persistente (solo el boot
actual) y `chatbot.log` (desde 2026-09-19) nunca registró un valor de
batería, así que no hay forma de fechar cuándo dejó de responder.

**Conclusión hasta aquí**: el MCU no está en el bus en ninguna dirección, a
ninguna velocidad, ni con reset duro. Quedan dos explicaciones, y las dos
se resuelven con manos, no con software:

1. **Mal contacto de los pogo pins de SDA/SCL** — es la causa #1 del
   [FAQ oficial de PiSugar](https://docs.pisugar.com/docs/product-wiki/battery/faq)
   para `I2C not connected`: restos de máscara de soldadura en los stubs
   del header. Un SCL con contacto flojo también explicaría la corrupción
   (el MCU ve datos con un reloj degradado, se desincroniza y mete ACKs a
   destiempo). Procedimiento del fabricante: apagar, limpiar con alcohol
   isopropílico los stubs de los pines 1–6 en la cara inferior de la Pi,
   raspar suave con herramienta plástica la máscara de soldadura sobre los
   puntos de los pines 3 y 5 hasta ver metal, limpiar las puntas de los
   pogo pins, remontar bien asentada. Luego repetir la Prueba C.
2. **MCU con el periférico I2C dañado** (o firmware corrupto sin
   bootloader alcanzable, como en
   [PiSugar#195](https://github.com/PiSugar/PiSugar/issues/195)). Sin I2C
   no se puede leer versión ni reprogramar (`pisugar-programmer` habla por
   `0x57`). Salidas: soporte/RMA de PiSugar, o reemplazar la PiSugar 3
   Plus — y en ese caso **actualizar su firmware a 1.4.0 antes** de
   montarla junto al HAT (`curl https://cdn.pisugar.com/release/PiSugarUpdate.sh | sudo bash`,
   con batería cargada; el script no revisa nivel), para tener la
   protección de escritura I2C desde el primer boot compartido.

**Prueba E — limpieza de contactos según el FAQ: sin cambio.** Se limpiaron
los stubs del header y los pogo pins (no estaban sucios) y se remontó sin
HAT: el MCU sigue mudo en las 128 direcciones. Dato del dueño: la lectura
de batería **funcionó durante semanas** y dejó de funcionar al mismo tiempo
que apareció el fallo del WM8960 — son el mismo evento: el MCU se corrompió
estando en el bus con el HAT (firmware sin la protección de escritura I2C
que PiSugar agregó en 1.24).

### Veredicto y opciones

**El MCU de esta PiSugar 3 está corrupto y no es recuperable por software**
(no habla I2C → no se puede leer versión ni reflashear; reprogramar el
FM33LC023N por SWD requiere herramientas del fabricante).

Preguntas frecuentes que ya se respondieron:

- *¿Tapar un solo pin?* Alcanza para frenar la interferencia (con SCL tapado
  el MCU no recibe reloj), pero I2C necesita los dos hilos: no da lectura.
- *¿La cinta es lo que quita la lectura de batería?* No. Sin cinta, sin HAT,
  contactos limpios, a 100 kHz y a 10 kHz, el MCU no contesta. La lectura
  se perdió cuando el MCU se corrompió; la cinta solo protege al WM8960.
- *¿Desactivarlo o arreglarlo por software?* No. Es otro chip con su propio
  firmware, ya no acepta comandos, y la corrupción es eléctrica en el
  cable: el kernel no puede ignorar a un esclavo que pisa SDA.

Opciones para recuperar la telemetría, en orden recomendado:

1. **Reemplazar la PiSugar (RMA o compra)** y, a la nueva, **actualizarle el
   firmware a 1.4.0 antes de montarla con el HAT**
   (`curl https://cdn.pisugar.com/release/PiSugarUpdate.sh | sudo bash`, con
   batería cargada; el script no revisa nivel). Con la protección de
   escritura I2C activa no hace falta cinta y vuelve la lectura.
2. **DIY**: medidor de batería externo (p. ej. MAX17048) en un cable Y sobre
   el JST de la batería, al I2C1 (ahora libre) por los stubs del header, más
   un shim que responda `get battery` / `get battery_v` en el puerto 8423
   para que la app no cambie. Requiere soldar.
3. **Sin hardware nuevo no hay opción**: el PMIC de la Pi solo ve los 5 V
   regulados de la PiSugar, no la celda.

Mientras tanto, el estado recomendado sigue siendo: PiSugar montada con los
pogo pins 3 y 5 aislados, batería funcionando, sin telemetría.

### Cierre de la investigación (2026-09-20, fin de la sesión 2)

Estado final verificado con el equipo armado como va a quedar (HAT montado,
PiSugar alimentando la Pi, pines 3 y 5 con cinta, USB-C desenchufado):

```
$ grep -i whisplay /proc/asound/cards
 2 [whisplaysound  ]: whisplaysound - Whisplay Sound
$ sudo dmesg | grep -c 'lost arbitration'
0
$ sudo i2cdetect -y 1 | grep '^10:'
10: -- -- -- -- -- -- -- -- -- -- UU -- -- -- -- --      # WM8960 bindeado; nada en 0x57/0x68
$ vcgencmd pmic_read_adc | grep EXT5V_V
     EXT5V_V volt(24)=5.01562000V                        # sin USB-PD → alimenta la PiSugar
$ printf 'get battery\n' | nc localhost 8423
battery: I2C not connected                              # esperado
```

Resumen en una línea: **el HAT nunca tuvo nada roto; la PiSugar 3 se
corrompió compartiendo bus con él y desde entonces lo sabotea. Aislarla
del bus lo arregla; recuperar su telemetría requiere reemplazarla.**

Cambios que quedaron en la Pi durante esta sesión (además de la cinta):

- `/boot/firmware/config.txt`: `[pi5] dtparam=cooling_fan=on` — fuerza el
  driver `pwm-fan` del Active Cooler aunque el firmware no lo autodetecte
  al arrancar. Ver [`SETUP.md`](./SETUP.md) (ventilador).
- `pisugar-server` sigue habilitado; loguea `Poll error` cada segundo. Se
  puede deshabilitar sin efectos secundarios (la app ya tolera la ausencia
  de lectura).

### Próximos pasos (para retomar después)

1. **Conseguir una PiSugar 3 Plus de reemplazo** (o RMA citando este doc:
   funcionó semanas, se corrompió compartiendo bus con el HAT, muda en las
   128 direcciones incluso sola, a 100 kHz y 10 kHz, tras reset duro y
   limpieza de contactos; mismo perfil que PiSugar#195).
2. **Con la nueva, ANTES de montar el HAT**: arrancar solo con la PiSugar,
   `sudo i2cdetect -y 1` debe mostrar `0x57` y `0x68`;
   `printf 'get firmware_version\n' | nc localhost 8423`; si es < 1.4.0,
   `curl https://cdn.pisugar.com/release/PiSugarUpdate.sh | sudo bash` con
   la batería cargada (el script no revisa nivel). Verificar la versión
   después.
3. **Montar el HAT sin cinta** y arrancar a batería. Verificar en el mismo
   boot: `whisplaysound` registrada, `dmesg | grep -c 'lost arbitration'`
   = 0, y `get battery` con valor. Si conviven, la cinta queda como
   historia. Dejar el equipo arrancando varias veces (el bug solo se
   juega en el probe del boot) antes de darlo por bueno.
4. Si no se consigue reemplazo: evaluar la opción DIY (MAX17048 en cable Y
   sobre el JST de la batería + shim en el puerto 8423).
5. Opcional, limpieza: `sudo systemctl disable --now pisugar-server`
   mientras no haya PiSugar funcional en el bus, y quitar el
   `whisplay-soundcard-warmup.service` de reintento (ya no aporta).

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
