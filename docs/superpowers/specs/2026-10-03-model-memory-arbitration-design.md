# Arbitraje de memoria: voz del dispositivo vs chat web

Fecha: 2026-10-03
Estado: Implementado y desplegado. Liberación por inactividad probada en la Pi. La pulsación de 3 s con el botón físico quedó cancelada por decisión del dueño; el modo chat web resuelve el conflicto de pantalla.

## Problema

La Pi tiene 8 GB de RAM. El 2026-10-03 el chat web cargó su modelo mientras seguía
residente el de voz (`llama3.2:3b`, ~2.9 GB). Ambos tienen `keep_alive: -1`, así que
ninguno se descarga solo. El kernel mató `llama-server` por OOM y el navegador mostró
`network error`. Al revisar también había un tercer modelo residente
(`hf.co/Unrestricted/Qwen3.5-4B…`) que no es de la app.

Causas en el código:
- `POST /api/chat` no descarga nada antes de cargar el modelo del chat (`web-admin-server.ts`).
- `keep_alive: -1` en el chat, en la voz y en la carga por defecto (`ollama-llm.ts`).
- El plan del historial descargaba todo solo al cambiar de modelo de chat, no en cada envío.

## Regla principal

**Un solo modelo residente a la vez, y un solo dueño de la memoria a la vez.**
Los dueños son el dispositivo (voz y pantalla) y el chat web. El arbitraje vive en el
servidor y decide quién tiene el modelo.

## Herramientas no dependen del modelo

Las herramientas del admin (`src/config/admin-tools/`) son funciones del servidor. Cualquier
modelo residente puede pedirlas, y el arbitraje solo mueve pesos de modelo, nunca toca las
herramientas. Por eso el modelo local puede usarlas sin que el arbitraje las mate.

## Estados de memoria

| Estado | Quién tiene el modelo | Qué pasa |
|---|---|---|
| `device` (reposo) | Voz del dispositivo (`DEFAULT_OLLAMA_MODEL`) | Estado normal al arrancar y tras soltar el chat. |
| `web` | Chat web (modelo del chat activo) | Se descarga todo lo residente, luego se carga solo el modelo del chat. |
| `device-busy` | Voz del dispositivo, respondiendo | Si el chat web está generando, se cancela. |

## Transiciones

**Chat web envía un mensaje** (`device` → `web`):
1. Cancelar cualquier generación en curso del dispositivo.
2. `unloadModel()`: descargar todo lo residente.
3. Cargar el modelo del chat con `keep_alive: -1` mientras el chat esté activo.
4. Responder. Las herramientas funcionan igual.

**Botón del dispositivo, mantenido varios segundos** (`web` o `device` → `device`):
1. Cancelar la generación en curso, sea web o voz. La respuesta parcial de web se guarda
   con la marca `(cancelado en el dispositivo)`.
2. Descargar el modelo del chat web si estaba cargado.
3. Cargar el modelo de voz. Mientras carga, la pantalla muestra "Preparando modelo"
   como ya existe.
4. La pantalla muestra el estado de pensar como en wardriving: "Escaneando redes…"
   con el loop THINKING en rojo, mientras el modelo piensa. Hoy el estado de pensar es
   "Pensando…" en `states.ts`, así que cambia solo el texto y el color del estado.

**Chat web sin uso** (`web` → `device`): propuesto, bajo demanda. El modelo de voz se
recarga cuando el dispositivo lo necesite, no en segundo plano, para no provocar otro
pico de RAM mientras alguien usa el chat.

## Cambios en el chat web

- El chat web nunca carga un modelo sin antes descargar los demás.
- Si el dispositivo tomó la memoria mientras el chat respondía, la respuesta parcial se
  guarda y el mensaje siguiente vuelve a cargar el modelo del chat.
- El `keep_alive` del chat web deja de ser infinito: se usa `-1` solo mientras el chat
  esté en uso (`web`), y se descarga al pasar a `device`.

## Título antes de responder (cambio pedido)

Cambia la regla aprobada del spec del chat: el título se genera a partir de la primera
pregunta, antes de la respuesta, y luego se responde. Cuesta una generación corta más al
inicio de cada chat nuevo. Si el título falla o pasa de 15 s, queda la primera palabra
de la pregunta.

## Propuestas abiertas (para aprobar)

1. **Duración de la pulsación larga:** 3 s.
2. **Recarga del modelo de voz:** bajo demanda, no en segundo plano.
3. **Herramientas en voz:** el modelo local del dispositivo también usa las herramientas del
   admin, con el mismo registro. Sube el tamaño del prompt, así que se limita a las
   herramientas de estado y consulta. Las de acción quedan solo en el chat web.

## Pruebas

En la Pi, con el log y `ollama ps` (`/api/ps`) abiertos:
- Enviar en el chat web con voz residente: solo queda el modelo del chat.
- Pulsación larga durante una respuesta web: la respuesta se cancela, la voz responde.
- Pulsación larga durante una respuesta de voz: el dispositivo queda en reposo.
- Un chat web con una herramienta del admin sigue funcionando durante el arbitraje.
- Ningún `OOM` en `dmesg` durante las pruebas.
- Un solo modelo residente después de cada transición.
