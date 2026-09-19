# Interfaz web (chat + wifi + USB + AIRSPACE desde el navegador)

`http://<ip-del-dispositivo>:8090` — accesible desde cualquier dispositivo
en la misma red, protegida con una pantalla de login propia (sesión por
cookie, usuario/contraseña por defecto **akbal / akbal**, ver más abajo).
Ya no usa el diálogo nativo de autenticación básica del navegador —
`/login` es una página propia con el mismo estilo del resto del panel.

## Qué tiene

- **Chat**: conversa con los modelos locales de Ollama, con selector de
  modelo (preseleccionado con el que esté activo, se actualiza al cambiar)
  — una versión chica de OpenWebUI, sin historial de conversaciones
  múltiples ni nada más allá de una sesión de chat con streaming. Botón
  **Cancelar** corta la generación de verdad (ver el incidente más abajo),
  y **Unload model** libera de la RAM del Pi todo lo que Ollama tenga
  cargado — sin cambiar cuál modelo está "seleccionado"; elegir un modelo
  de nuevo (acá, por voz, o desde el menú físico) lo vuelve a cargar
  normalmente. El avatar de Akbal en la topbar solo "habla" mientras el
  texto de la respuesta se está imprimiendo, no mientras espera el primer
  token.
- **Wifi**: ver la red actual, buscar redes, conectarse a una tipeando la
  contraseña (esto es lo que la pantalla física del dispositivo no puede
  hacer — no tiene con qué escribir texto), olvidar redes guardadas, y un
  panel de análisis de espectro RF (dBm estimado, BSSID, distancia
  aproximada por modelo de path-loss, gráfico por canal — ver comentarios
  en `app/web/admin/app.js`, sección "RF analysis panel").
- **USB**: dispositivos conectados, adaptadores WiFi USB (con chipset),
  almacenamiento USB con un visor de archivos (carpetas, preview de
  imágenes, descarga de todo lo demás).
- **AIRSPACE**: visualización 3D del espacio WiFi con Three.js — página
  aparte, ver [`airspace.md`](./airspace.md).
- Indicadores en la topbar: batería (%, carga), CPU/RAM/disco del Pi —
  todos se refrescan solos cada 60s sin recargar la página.

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
- Sesión por cookie (token aleatorio de 192 bits, `httpOnly`, 30 días) en
  vez de autenticación básica HTTP — `/login` y `POST /api/login` son las
  únicas rutas públicas; todo lo demás (HTTP y el WebSocket de AIRSPACE)
  exige la cookie de sesión. El secreto que firma nada — no hay firma: el
  token en sí es el secreto, generado con `crypto.randomBytes`, guardado
  en un `Set` en memoria del proceso — un reinicio del servicio invalida
  todas las sesiones (hay que loguearse de nuevo, es lo esperado).
- No usa HTTPS (la cookie de sesión viaja en texto plano sobre la red
  local) — suficiente para el caso de uso (red doméstica de confianza), no
  para exponerlo más allá de eso.
