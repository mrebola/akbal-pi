# Modo agente (OpenClaw) vs modo local

Cómo se armó el switch por voz entre contestar con el modelo local (Ollama)
y delegar la conversación a un agente OpenClaw externo, y por qué no se
integró directo por Telegram.

## Por qué no por Telegram

Ya había un OpenClaw corriendo con un canal de Telegram (un bot de
BotFather). La idea inicial era que el Pi le hablara a ese mismo bot. No se
hizo así: la Bot API de Telegram solo permite **un** consumidor de
`getUpdates`/webhook por bot. Si OpenClaw ya está escuchando ese bot, el Pi
no puede "inyectar" mensajes ahí como si fuera otro usuario sin una sesión
de usuario real (MTProto/userbot) — mucho más delicado de manejar
credenciales, y quedó descartado.

En vez de eso, se reusó el bridge HTTP `whisplay-im` que ya existía en este
repo (`app/src/device/im-bridge.ts` + `app/src/cloud-api/whisplay-im/`,
documentado en `app/openclaw/chennel/whisplay-im/README.md`): el Pi expone
`inbox`/`poll`/`send`/`status`/`approval` por HTTP local, y esa misma
instancia de OpenClaw (la que ya tiene el canal de Telegram) agrega el canal
`whisplay-im` además del de Telegram. Mismo agente/cerebro, dos canales de
entrada — el transporte con el Pi no es Telegram, pero el resultado es el
mismo "modo agente".

## Cómo se activa

Antes, la única forma de activar el bridge era `LLM_SERVER=whisplay-im` en
`.env`, fijo desde el arranque — requería reiniciar `chatbot.service` para
cambiar de modo. Ahora es un toggle en memoria (`app/src/config/device-mode.ts`),
switcheable en caliente:

- **Por voz**: "activa modo agente" / "modo agente" abre el menú visual
  pre-posicionado en "Modo agente (OpenClaw)". "activa modo local" / "modo
  local" / "desactiva modo agente" lo abre pre-posicionado en "Modo local".
  Un "cambiar modo" genérico (sin nombrar cuál) abre el menú en el modo que
  esté activo. Ver `docs/voice-commands.md`.
- **Nunca cambia directo por voz** — a diferencia del cambio de modelo
  (que sí tiene un atajo de voz directo), el modo siempre pasa por el menú
  visual con el mismo mantené-presionado-para-confirmar (~0.9s) que el selector de
  modelo (`app/src/core/chat-flow/mode-select-mode.ts`, copia deliberada de
  `model-select-mode.ts`). Cambiar de modo implica que el dispositivo
  empieza a mandar todo lo que se dice a un proceso externo (con ejecución
  de herramientas y flujos de aprobación) — vale la pena la confirmación
  explícita con el botón, más todavía que para un modelo local.
- **Se persiste** en `.env` como `DEVICE_MODE=local|agent`
  (`app/src/utils/env-file.ts`, mismo mecanismo que ya usaba el cambio de
  modelo de Ollama), así sobrevive un reinicio de `chatbot.service`.

## Migración desde `LLM_SERVER=whisplay-im`

Si el `.env` ya tenía `LLM_SERVER=whisplay-im` para activar el bridge, sigue
funcionando como default al arrancar (fallback en `device-mode.ts`), pero
quedó deprecado. `LLM_SERVER` ahora debería apuntar siempre al proveedor
local real (`ollama`, por ejemplo) — es lo que "modo local" usa cuando se
cambia de vuelta — y `DEVICE_MODE=agent` es la forma nueva de arrancar
directo en modo agente.

## El bridge HTTP y cuándo arranca

`WhisplayIMBridgeServer` (el listener HTTP que expone `inbox`/`poll`/`send`)
no arranca más solo por tener las variables `WHISPLAY_IM_*` configuradas —
arranca la primera vez que el dispositivo entra en modo agente (al boot si
`DEVICE_MODE=agent`/legado `LLM_SERVER=whisplay-im`, o al confirmar el
cambio por voz/menú), vía `ChatFlow.ensureAgentBridge()`. Volver a "modo
local" no lo apaga — es un servidor HTTP idle sin costo, y así un segundo
cambio a "modo agente" no tiene que volver a levantarlo. La razón de no
arrancarlo siempre desde el boot: quien nunca activó modo agente no debería
tener un listener HTTP corriendo (sin auth si no configuraste
`WHISPLAY_IM_TOKEN`) por default.

## Elegir un modelo local sale de modo agente

Si estás en modo agente y elegís un modelo específico (por voz o desde el
menú de modelo — ver `docs/voice-commands.md`), el dispositivo pasa a modo
local automáticamente (`model_loading` en `states.ts`, después de que
`switchModel` confirma el cambio). La lógica: elegir un modelo puntual es
una señal explícita de "quiero que contestes con este modelo", y si el
dispositivo se quedara en modo agente, ese modelo recién cargado ni
siquiera se usaría (seguiría mandando todo a OpenClaw) hasta el próximo
fallback por timeout. Esto no aplica al `switchModel` interno que usa el
fallback de abajo — ese no pasa por `model_loading`, así que no dispara este
cambio de modo (no tendría sentido: el fallback YA está corriendo porque el
modo agente falló).

## Fallback automático al modelo local

En "modo agente", cada turno intenta primero OpenClaw — pero si no contesta
a tiempo (sin wifi, la VM de OpenClaw caída, el puente `whisplay-im-bridge`
apagado, etc.), el dispositivo no se queda esperando para siempre: cae solo
al modelo local (`LLM_SERVER`, Ollama por defecto) para ese turno, sin que
haga falta cambiar de modo a mano.

- El tiempo de espera es `AGENT_REPLY_TIMEOUT_MS` en `.env` (default 20000 =
  20 segundos). Pasado ese tiempo sin respuesta de OpenClaw, sigue el mismo
  camino que "modo local" para esa pregunta puntual — el modo persistido
  (`DEVICE_MODE`) no cambia, así que el siguiente turno vuelve a intentar
  OpenClaw primero.
- Si la respuesta de OpenClaw llega tarde (después del fallback), se
  descarta en vez de interrumpir lo que ya está sonando — ver
  `agentReplyExpired` en `ChatFlow.ts` / `chat-flow/states.ts`.
- Esto no es una cola ni reintento: es un fallback de una sola vez por
  turno. Si OpenClaw está caído, cada pregunta tarda `AGENT_REPLY_TIMEOUT_MS`
  de más antes de caer a local — bajar ese valor si se prioriza latencia
  sobre darle más margen a OpenClaw.
- El fallback siempre usa el **mejor modelo local documentado**
  (`DEFAULT_OLLAMA_MODEL` en `ollama-llm.ts`, hoy
  `huihui_ai/qwen3.5-abliterated:2B` — ver
  [`llm-model-selection.md`](./llm-model-selection.md)), sin importar qué
  modelo haya quedado activo por un "modelo X" anterior. Si hace falta
  cambiarlo, `switchModelWithProgress` lo hace antes de contestar (con la
  demora real de cargarlo si no era el que ya estaba en memoria) y lo deja
  persistido en `OLLAMA_MODEL` — no vuelve solo al modelo que estaba antes
  del fallback.

## Seguridad

`WHISPLAY_IM_TOKEN` (el token que autentica al bridge, no el token del bot
de Telegram) hay que generarlo uno mismo y pegarlo directo en el `.env` del
Pi — nunca en este repo ni en el chat con el agente que edita el código. El
token del bot de Telegram tampoco lo necesita este repo: vive en la config
de OpenClaw, no aquí.
