# Interfaz web (chat + wifi desde el navegador)

`http://<ip-del-dispositivo>:8090` — accesible desde cualquier dispositivo
en la misma red, protegida con autenticación básica HTTP (usuario/
contraseña por defecto **akbal / akbal**, ver más abajo).

## Qué tiene

- **Chat**: conversa con los modelos locales de Ollama, con selector de
  modelo — una versión chica de OpenWebUI, sin historial de conversaciones
  múltiples ni nada más allá de una sesión de chat con streaming.
- **Wifi**: ver la red actual, buscar redes, conectarse a una tipeando la
  contraseña (esto es lo que la pantalla física del dispositivo no puede
  hacer — no tiene con qué escribir texto), y olvidar redes guardadas.

## Cómo prenderla/apagarla y cambiar las credenciales

En el `.env` del dispositivo:

```bash
WEB_ADMIN_ENABLED=true      # false la apaga del todo
WEB_ADMIN_PORT=8090
WEB_ADMIN_USER=akbal
WEB_ADMIN_PASSWORD=akbal
```

Prendida por defecto. **La contraseña por defecto es literalmente
"akbal"** — está bien para probarla rápido, pero para dejarla así en un
dispositivo real conviene cambiarla acá (nunca en el repo — mismo criterio
que el resto de credenciales, ver [`wifi.md`](./wifi.md)).

## Arquitectura (`app/src/device/web-admin-server.ts`)

Mismo stack que `web-display.ts` (Koa + `@koa/router` + `koa-static`, ya
eran dependencias del proyecto) — no comparte servidor ni puerto con ese:
`web-display.ts` es el simulador de la pantalla física para desarrollar sin
hardware (`WHISPLAY_WEB_ENABLED`), esto es una superficie de administración
aparte, siempre corriendo (si `WEB_ADMIN_ENABLED` no está en `false`).

- `POST /api/chat`: reenvía directo a `/api/chat` de Ollama con
  `stream: true` y hace *pipe* de la respuesta NDJSON tal cual — el
  frontend (`app/web/admin/app.js`) la va leyendo línea por línea.

  **Incidente real (18/09):** un modelo (`huihui_ai/qwen3-abliterated:1.7b`,
  ya marcado en `llm-model-selection.md` como propenso a repetirse) entró
  en loop en el chat y corrió al ~70% CPU **45+ minutos** sin que nada lo
  parara — no había ni botón de cancelar ni límite de tokens. Dos redes de
  seguridad independientes, agregadas después:
  1. `options.num_predict` (default 2048, `WEB_ADMIN_CHAT_MAX_TOKENS` en
     `.env`) — techo duro de tokens por respuesta, para que un loop de
     repetición no pueda correr para siempre así nadie lo note.
  2. El botón **Cancelar** en el chat corta la conexión del browser, lo que
     el servidor detecta (`ctx.req`/`ctx.res`/el socket, escuchando los
     cuatro eventos posibles porque cuál dispara depende de cómo se cortó
     la conexión) y usa para **destruir el stream de axios hacia Ollama**
     — nada más que abortar el `AbortController` de axios *no alcanza* una
     vez que la respuesta ya empezó a fluir (confirmado en el dispositivo:
     el proceso seguía corriendo igual). Destruir el stream sí cierra la
     conexión real con Ollama, y Ollama cancela la generación en cuanto
     detecta que su cliente se desconectó — verificado en el dispositivo
     real: el tiempo de CPU del proceso `llama-server` deja de subir
     apenas se cancela.
- `GET /api/models` / `POST /api/models/select`: reusan
  `listOllamaModelsWithSize` / `switchModel` de `ollama-llm.ts` — el mismo
  código que usa el menú físico de modelo.
- `GET/POST /api/wifi/*`: reusan `app/src/utils/wifi.ts` (ver
  [`wifi.md`](./wifi.md)) — mismo camino que el menú físico "Internet
  emergencia", con la diferencia de que acá sí se puede mandar una
  contraseña nueva y hay un botón "Olvidar".

Archivos estáticos en `app/web/admin/` (HTML/CSS/JS planos, sin build step
— mismo criterio que `app/web/whisplay-display/`).

## Seguridad

- Solo alcanzable dentro de la red local (no hay nada exponiéndolo a
  internet) — igual que el resto del dispositivo.
- Autenticación básica HTTP en cada request, sin excepciones — no hay
  rutas públicas.
- No usa HTTPS (autenticación básica en texto plano sobre la red local) —
  suficiente para el caso de uso (red doméstica de confianza), no para
  exponerlo más allá de eso.
