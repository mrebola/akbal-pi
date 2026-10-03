# Conexión con OpenClaw desde Ajustes — configuración inicial y administración

Fecha: 2026-10-03
Estado: Pendiente de implementar. Hoy solo existe la guía manual en docs/openclaw-connection.md.
Documentación de operación: [`docs/openclaw-connection.md`](../../openclaw-connection.md)

## Objetivo

Que en `http://<host-de-la-pi>:8090/#settings` se pueda
configurar y administrar la conexión con un agente OpenClaw, sin editar
`.env` a mano ni reiniciar el servicio. Si no hay agente conectado, la
pestaña ofrece la configuración inicial paso a paso.

## Estado actual (referencia)

- El bridge `whisplay-im` es un servidor HTTP en `app/src/device/im-bridge.ts`.
  Expone `inbox`, `poll`, `send`, `status` y `approval` en el puerto
  `WHISPLAY_IM_BRIDGE_PORT` (18888 por defecto), con
  `Authorization: Bearer <WHISPLAY_IM_TOKEN>`.
- El bridge escucha en todas las interfaces (`server.listen(port)` sin host).
- OpenClaw hace long-poll a `/whisplay-im/poll`. La Pi no guarda cuándo fue
  el último poll: hoy no hay forma de saber si el agente está conectado.
- El bridge solo arranca al entrar en modo agente
  (`ChatFlow.ensureAgentBridge()`, `docs/agent-mode.md`). Para probar la
  conexión antes de activar el modo, hace falta arrancarlo sin cambiar de
  modo.
- El modo se cambia con `POST /api/mode/select`, que ya existe, y se guarda
  en `.env` como `DEVICE_MODE` (`utils/env-file.ts` → `persistEnvVar`).
- La pestaña Ajustes tiene secciones en `web/admin/index.html` (General,
  Wifi, Audio, IA, Soul, Almacenamiento, Dispositivos, Sistema).

## Decisiones

| Tema | Decisión |
|---|---|
| Dónde vive la UI | Nueva sección "OpenClaw" en Ajustes, dentro de la pestaña IA (o su propia pestaña si crece) |
| Cuándo se muestra el asistente | Cuando no hay agente conectado. Con agente conectado, la sección muestra estado y administración |
| Qué cuenta como "conectado" | OpenClaw hizo `poll` en los últimos 60 s, o tiene un `poll` pendiente |
| Token | Lo genera la Pi (32 bytes aleatorios en hex), se guarda en `.env` y solo se muestra completo una vez, al generarlo |
| Probar conexión | Arranca el bridge si no está activo, sin cambiar `DEVICE_MODE`, y verifica que llegue un `poll` en 30 s |
| Cambiar de modo | Sigue siendo `POST /api/mode/select`. La sección solo muestra el modo y ofrece el cambio |
| Persistencia | Puerto y token en `.env` con `persistEnvVar`. No se guardan en otro lugar |
| Acceso | Solo con la sesión de admin (`login.html`). Ningún endpoint de esta sección responde sin sesión |

## Flujo de configuración inicial

Se muestra cuando no hay agente conectado.

1. **Estado.** "Sin agente conectado" y, si aplica, el último poll recibido.
2. **Puerto.** Valor por defecto 18888. Se valida que sea un número entre
   1024 y 65535, y que no esté en uso.
3. **Token.** Botón "Generar token". Muestra el token completo una sola vez,
   con botón para copiarlo. Después solo se ve enmascarado (últimos 4
   caracteres).
4. **Configurar OpenClaw.** Muestra los pasos para dar de alta el canal
   `whisplay-im` en OpenClaw, con la URL de la Pi, el puerto y el token. Los
   pasos viven en `docs/openclaw-connection.md`; la pantalla enlaza ahí.
5. **Probar.** Botón "Probar conexión". Arranca el bridge y espera hasta 30 s
   a un `poll`. Muestra el resultado: conectado, o qué revisar (token, puerto,
   red, OpenClaw apagado).
6. **Listo.** Cuando hay un `poll` reciente, la sección cambia a modo
   administración.

## Administración

Cuando hay agente conectado:

- **Estado:** conectado o no, hora del último poll, puerto, token
  enmascarado, modo actual (local o agente).
- **Modo:** botón para cambiar a agente o a local, con la misma confirmación
  que el menú físico. Al cambiar a agente, el bridge ya debe estar corriendo.
- **Probar conexión:** igual que en la configuración inicial.
- **Rotar token:** genera un token nuevo, lo guarda en `.env` y avisa que
  OpenClaw necesita el nuevo token. Mientras OpenClaw no lo tenga, el agente
  queda desconectado y la UI lo muestra.
- **Cambiar puerto:** guarda el puerto y avisa que hay que reiniciar el
  bridge. El reinicio del bridge se hace sin reiniciar `chatbot.service`.
- **Desconectar:** pasa a modo local, detiene el bridge y deja el token en
  `.env`, para que reconectar sea un solo paso.

## Cambios de código

Son mínimos y se listan para el plan:

1. `im-bridge.ts`: registrar la hora del último `poll` (`lastPollAt`) y
   exponerla. Hoy no existe.
2. `im-bridge.ts`: método `stop()` para desconectar sin reiniciar el servicio.
   Hoy el bridge solo se crea, nunca se apaga.
2b. Rotar el token o cambiar el puerto recrea el bridge: `stop()` y luego un
   bridge nuevo. Hoy el token se lee solo en el constructor
   (`im-bridge.ts:57`), y `ChatFlow.ensureAgentBridge()` no crea otro bridge si
   ya existe (`ChatFlow.ts:165`). Sin esto, el token nuevo no surte efecto
   hasta reiniciar el servicio.
3. `ChatFlow.ts`: `ensureAgentBridge()` debe poder arrancar el bridge sin
   cambiar el modo, para la prueba de conexión.
4. Endpoints nuevos en `web-admin-server.ts` (o en un archivo propio como
   `openclaw-routes.ts`, siguiendo el patrón de `chat-history-routes.ts`):

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/api/openclaw/status` | Conectado, último poll, puerto, token enmascarado, modo |
| `POST` | `/api/openclaw/token` | Genera y guarda un token nuevo; devuelve el completo una vez |
| `POST` | `/api/openclaw/port` | Guarda el puerto y reinicia el bridge |
| `POST` | `/api/openclaw/test` | Arranca el bridge si hace falta y espera un poll hasta 30 s |
| `POST` | `/api/openclaw/disconnect` | Pasa a modo local y detiene el bridge |

`POST /api/mode/select` no cambia.

## Manejo de errores

| Caso | Comportamiento |
|---|---|
| Puerto en uso | Error claro, no se guarda el cambio |
| Token vacío o sin generar | El bridge no arranca; la UI pide generar uno |
| OpenClaw no hace poll en 30 s | "No llegó ningún mensaje de OpenClaw" con lista de qué revisar |
| Token incorrecto de OpenClaw | El bridge responde 401; la UI sugiere revisar el token |
| `.env` no se puede escribir | Error visible; el bridge no cambia de configuración |
| Modo agente sin bridge | No puede pasar: el cambio a agente arranca el bridge primero |

## Seguridad

- El bridge es HTTP, sin TLS, y escucha en todas las interfaces, como hoy.
  **Decisión:** se mantiene así. El token es la única protección. Esto
  expone el bridge a cualquier red a la que la Pi esté conectada, y queda
  como riesgo aceptado. Si cambia el contexto de red (por ejemplo, la Pi
  pasa a una red pública), hay que revisar esta decisión.
- El token nunca se devuelve completo después de generarlo.
- El token no se escribe en logs. Se revisa con el checklist anti-secretos de
  `AGENTS.md` antes de cualquier commit.
- El token del bot de Telegram no pasa por esta sección: vive en la
  configuración de OpenClaw (ver `docs/agent-mode.md`).

## Pruebas

El repo no tiene tests automatizados de esta parte. La validación es:

1. `npx tsc --noEmit` en `app/`.
2. Pruebas unitarias de la lógica de "conectado" (ventana de 60 s) y de la
   validación del puerto, con `node:test`.
3. En la Pi:
   - sin agente: la sección muestra el asistente, y "Probar" falla con mensaje claro
   - generar token: se muestra una vez, luego enmascarado
   - configurar OpenClaw con el token y probar: "conectado"
   - cambiar a agente y a local desde la sección
   - rotar token: el agente se desconecta hasta que OpenClaw use el nuevo
   - desconectar: el bridge se detiene y el modo queda en local
   - reiniciar el servicio: el token y el puerto siguen configurados

## Riesgos

- **Bridge expuesto en la red.** Ver Seguridad. Riesgo aceptado: escucha en
  todas las interfaces, y el token es la única protección.
- **Estado "conectado" aproximado.** Depende del long-poll de OpenClaw. Si
  OpenClaw reintenta con pausas largas, la UI puede decir "desconectado"
  cuando no lo está. La ventana de 60 s se ajusta con la práctica.
- **Pérdida de token.** Si se pierde el token y no se guardó, se rota. OpenClaw
  tiene que actualizarse de todas formas.
