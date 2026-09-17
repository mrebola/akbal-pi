# Fix: grabación que se queda colgada bloqueando el micrófono

## Síntoma

Al mantener presionado el botón del Whisplay HAT para hablar, en vez de
escuchar y transcribir, el asistente vuelve casi instantáneamente al mensaje
de reposo ("Mantén presionado el botón para hablar"), como si el botón no
hiciera nada. En el log (`chatbot.log`) se ve el ciclo `listening` → `asr` →
`sleep` completo en menos de un segundo, muchas veces seguidas.

## Diagnóstico

`recordAudioManually()` (en `app/src/device/audio.ts`, usada por el flujo de
botón manual) lanza `sox` para grabar del micrófono. Al soltar el botón
rápido, `killRecordingProcess()` le manda `SIGINT` a ese proceso para que
cierre el archivo WAV y termine. La mayoría de las veces `sox` lo maneja bien
— pero se confirmó en producción que a veces el proceso **no termina**:

```bash
ps -o pid,ppid,stat,etime,cmd -p <pid>          # seguía "S" (vivo), minutos después
cat /proc/asound/card2/pcm0c/sub0/status         # state: RUNNING, owner_pid: <pid>
```

Ese proceso zombie se queda dueño exclusivo del dispositivo de captura ALSA
(`hw:whisplaysound,0`). Cualquier grabación nueva que se intenta después falla
al abrir el dispositivo (ocupado) y `sox` sale casi de inmediato con error —
pero el código no revisaba el código de salida: el `on("exit", ...)` de
`recordAudioManually()` resolvía la promesa igual, como si hubiera grabado
algo. Eso hacía que el flujo avanzara a `asr` con un archivo vacío/inválido,
fallara el reconocimiento, y volviera a `sleep` — todo en un instante, dando
la sensación de que el botón dejó de funcionar.

## Fix

En `app/src/device/audio.ts`:

- `killRecordingProcess()` ahora arma un respaldo: si el proceso sigue vivo
  1 segundo después del `SIGINT`, le manda `SIGKILL`.
- `recordAudioManually()` ahora sólo resuelve la promesa en una salida limpia
  (código `0`) o cuando nosotros mismos matamos el proceso (llega con señal,
  el camino normal de "soltaste el botón"). Cualquier otra salida (`sox`
  falló al abrir el dispositivo) **rechaza** la promesa con un error real, que
  el estado `listening` (`app/src/core/chat-flow/states.ts`) ya sabía
  manejar (`.catch` → log + vuelta a `sleep`), solo que antes nunca se
  disparaba. Este mismo chequeo de código de salida ya existía en
  `recordAudio()` (el modo automático de wake-word) — `recordAudioManually`
  quedó a la par.

## Si vuelve a pasar

Diagnóstico rápido en la Pi:

```bash
ps aux | grep sox                                     # ¿hay un sox viejo corriendo?
cat /proc/asound/card2/pcm0c/sub0/status               # ¿quién es owner_pid?
kill -9 <pid>                                           # liberar el dispositivo a mano
```

No se identificó por qué `SIGINT` no alcanza a terminar `sox` en esos casos
puntuales (no es reproducible a demanda) — el respaldo con `SIGKILL` cubre el
síntoma independientemente de la causa exacta.
