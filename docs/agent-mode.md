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
  visual con el mismo mantené-presionado-3-segundos que el selector de
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

## Seguridad

`WHISPLAY_IM_TOKEN` (el token que autentica al bridge, no el token del bot
de Telegram) hay que generarlo uno mismo y pegarlo directo en el `.env` del
Pi — nunca en este repo ni en el chat con el agente que edita el código. El
token del bot de Telegram tampoco lo necesita este repo: vive en la config
de OpenClaw, no acá.
