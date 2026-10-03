# Conexión con OpenClaw

Cómo conectar la Pi con un agente OpenClaw para usar el **modo agente**, y
cómo administrar esa conexión.

> **Estado:** la configuración manual de abajo funciona hoy. La configuración
> desde Ajustes → IA de la web está especificada en
> [`superpowers/specs/2026-10-03-openclaw-connection-settings-design.md`](superpowers/specs/2026-10-03-openclaw-connection-settings-design.md)
> y todavía no está implementada.

Para qué sirve el modo agente y cómo se cambia entre modos, ver
[`agent-mode.md`](agent-mode.md). Para la API del bridge, ver
[`app/openclaw/chennel/whisplay-im/README.md`](../app/openclaw/chennel/whisplay-im/README.md).

## Cómo funciona

```
Pi (Akbal)                                OpenClaw (otro equipo / VM)
─────────────────                         ───────────────────────────
voz → ASR → POST /whisplay-im/inbox  ───▶ (queda en cola)
                                          GET  /whisplay-im/poll  (long-poll)
respuesta ◀── POST /whisplay-im/send  ◀── agente responde
TTS → altavoz
```

- La Pi expone un servidor HTTP (el **bridge**) en el puerto 18888 por
  defecto.
- OpenClaw hace long-poll a `/whisplay-im/poll` para recibir lo que dijiste.
- Todas las llamadas llevan `Authorization: Bearer <token>`.
- El bridge solo arranca al entrar en modo agente.

## Datos que necesitas

| Dato | Dónde se define | Ejemplo |
|---|---|---|
| Dirección de la Pi | Tu red (LAN o Tailnet) | `<ip-de-la-pi>` o el nombre de Tailnet |
| Puerto del bridge | `WHISPLAY_IM_BRIDGE_PORT` | `18888` |
| Token | `WHISPLAY_IM_TOKEN` en `app/.env` | 32 bytes en hex, generado por ti |

**El token lo generas tú** y lo pegas en los dos lados. Nunca lo pongas en
este repo ni en un chat con el agente que edita el código (ver
[`agent-mode.md`](agent-mode.md), sección Seguridad).

Generar un token:

```bash
openssl rand -hex 32
```

## Configuración manual (hoy)

### 1. En la Pi

Edita `app/.env` (en el clon real de `~/akbal-pi`, ver
[`deploy.md`](deploy.md)):

```bash
WHISPLAY_IM_BRIDGE_PORT=18888
WHISPLAY_IM_TOKEN=<el-token-que-generaste>
```

Reinicia el servicio para que tome los cambios:

```bash
whisplay service restart
```

### 2. En OpenClaw

Da de alta el canal `whisplay-im` con:

- la dirección de la Pi y el puerto
- el mismo token en `Authorization: Bearer`
- `waitSec` opcional para el long-poll

Los endpoints y el formato de cada llamada están en
[`app/openclaw/chennel/whisplay-im/README.md`](../app/openclaw/chennel/whisplay-im/README.md).

### 3. Probar

Desde cualquier equipo de la red, con el token:

```bash
curl -H "Authorization: Bearer <token>" \
  "http://<ip-de-la-pi>:18888/whisplay-im/poll?waitSec=5"
```

- Si responde en unos segundos, el token y el puerto están bien.
- Si responde `401`, el token no coincide.
- Si no responde, revisa la red y que el servicio esté corriendo.

### 4. Activar modo agente

Desde el menú de la pantalla física (Modo → Modo agente) o por voz
("activa modo agente"), como se describe en [`agent-mode.md`](agent-mode.md).
Desde la web: Ajustes → General → Modo de IA.

## Administrar la conexión (planeado)

Cuando se implemente, Ajustes → IA mostrará una sección OpenClaw con:

- **Sin agente conectado:** asistente de configuración inicial. Pasos:
  puerto, generar token (se muestra una vez), instrucciones para OpenClaw,
  y "Probar conexión".
- **Con agente conectado:** estado y último poll, modo actual, probar
  conexión, rotar token, cambiar puerto y desconectar.

Mientras no esté implementado, usa la configuración manual de arriba. Para
rotar el token a mano: genera uno nuevo, cámbialo en `app/.env` y en
OpenClaw, y reinicia el servicio.

## Solución de problemas

| Síntoma | Qué revisar |
|---|---|
| OpenClaw no recibe nada | Token y puerto iguales en los dos lados; la Pi y OpenClaw se ven en la red |
| `401` en el poll | El token de OpenClaw no coincide con `WHISPLAY_IM_TOKEN` |
| El modo agente tarda 20 s y responde el modelo local | OpenClaw no contestó a tiempo; ver `AGENT_REPLY_TIMEOUT_MS` en [`agent-mode.md`](agent-mode.md) |
| Cambiaste el token y no pasa nada | El servicio no se reinició, o OpenClaw sigue con el token viejo |
| El puerto está ocupado | Otro proceso lo usa; cambia `WHISPLAY_IM_BRIDGE_PORT` en ambos lados |

## Seguridad

- El bridge usa HTTP sin TLS. Expónlo solo en la LAN o en la Tailnet, nunca
  en internet abierto.
- El token es el único control de acceso. Si se filtra, rótalo.
- No pegues el token en logs, capturas de pantalla ni commits. El repo es
  público (ver `AGENTS.md`).
