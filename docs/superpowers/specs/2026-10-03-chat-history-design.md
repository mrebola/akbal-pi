# Historial de chats persistente — chat web del admin

Fecha: 2026-10-03
Estado: aprobado para implementación (pendiente de plan)

## Objetivo

Que cada conversación del chat web (`/#chat` del admin) se guarde, que se
pueda reanudar, renombrar, fijar y eliminar, y que cada chat recuerde qué
modelo usó. Una interfaz parecida a la de ChatGPT, pero con los modelos
locales de la Raspberry Pi 5 (8 GB de RAM).

Fuera de alcance por ahora: búsqueda de texto dentro de los chats,
exportar y compartir chats. Tampoco cambia el chat de voz ni el historial
de la pantalla LCD.

## Estado actual (referencia)

- El historial vive en el navegador: `web/admin/app.js` tiene
  `let history = []`. Recargar la página lo borra.
- Cambiar de modelo en el `<select>` limpia ese historial
  (`app.js:391`).
- `POST /api/chat` (`src/device/web-admin-server.ts:1001`) no tiene estado:
  recibe el arreglo completo de mensajes y el modelo en cada petición, y
  responde en NDJSON.
- `/api/models/select` descarga los demás modelos. Solo hay un modelo
  residente a la vez.
- `data/chat_history/` ya existe (`src/utils/dir.ts:37`), hoy lo usa Gemini.

## Decisiones

| Tema | Decisión |
|---|---|
| Almacenamiento | Un archivo JSON por chat en `data/chat_history/` |
| Contexto que ve el modelo | Ventana fija con los turnos más recientes que quepan en el límite de contexto |
| Cambio de modelo al reabrir | Se descarga el modelo actual y se carga el del chat, con aviso de tiempo |
| Modelo no instalado | El chat queda en solo lectura hasta reinstalarlo o elegir otro |
| Título | Generado por el modelo del chat después de la primera respuesta |
| Título de respaldo | Primeras palabras del primer mensaje del usuario |
| Organización en la lista | Sección "Fijados" arriba, luego "Recientes" de más nuevo a más viejo |
| Borrar | Confirmación en la UI con el título del chat; el backend borra solo cuando recibe la petición |

## Modelo de datos

Archivo `data/chat_history/<id>.json`:

```json
{
  "id": "k3j2a9…",
  "title": "Cómo funciona nmap",
  "model": "huihui_ai/qwen3.5-abliterated:2B",
  "pinned": false,
  "createdAt": "2026-10-03T14:20:00Z",
  "updatedAt": "2026-10-03T14:35:12Z",
  "messages": [
    { "role": "user", "content": "…" },
    { "role": "assistant", "content": "…" }
  ]
}
```

- `id`: generado con `crypto.randomUUID()`.
- `updatedAt`: se actualiza al guardar una respuesta. Determina el orden
  de "Recientes" y de los fijados.
- Las escrituras son atómicas: se escribe `<id>.json.tmp` y luego se
  renombra. Un corte de luz no deja un JSON a medias.
- Un archivo que no se puede leer se omite en la lista y se registra en
  consola; no tumba el endpoint.

## Ventana de contexto

- Al enviar, el servidor toma los turnos más recientes que quepan en el
  límite de contexto del modelo, dejando margen para la respuesta.
- La estimación de tokens es por caracteres (aprox. 4 caracteres por
  token). No se usa un tokenizador exacto.
- El mensaje de sistema (identidad de Akbal y conocimiento RAG) siempre
  se incluye y no cuenta contra el recorte de turnos.
- Los mensajes viejos siguen en disco y en la UI. Solo se recortan para el
  modelo.

## Modelo por chat

- Cada chat guarda el modelo con el que se creó.
- Al abrir un chat cuyo modelo no es el residente, la UI muestra el aviso
  con el tiempo estimado y, al confirmar, el backend descarga el modelo
  actual y carga el del chat (reutiliza `/api/models/select`).
- Si el modelo del chat no está instalado, `POST /api/chat` responde con
  un error claro, la UI deja el chat en solo lectura y ofrece elegir otro
  modelo. Elegir otro modelo cambia el campo `model` del chat.
- El `<select>` de modelo cambia el modelo del chat activo. No limpia el
  historial.

## Título

- Después de la primera respuesta, el servidor pide al modelo del chat un
  título corto (máximo unas 6 palabras). Ese modelo ya está residente, así
  que no hay carga extra.
- Si la generación falla o pasa de un tiempo límite, el título queda como
  las primeras palabras del primer mensaje del usuario.
- El título se puede renombrar en cualquier momento. Una vez renombrado,
  ya no se regenera.

## API

El contrato de `POST /api/chat` no cambia para quien ya lo usa. Se agrega
un campo opcional `chatId`.

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/api/chats` | Lista: id, título, modelo, `pinned`, `updatedAt` |
| `POST` | `/api/chats` | Crea un chat vacío con `model` |
| `GET` | `/api/chats/:id` | Chat completo con mensajes |
| `PATCH` | `/api/chats/:id` | Cambia `title`, `pinned` o `model` |
| `DELETE` | `/api/chats/:id` | Borra el archivo |
| `POST` | `/api/chat` | Igual que hoy, más `chatId` opcional: si viene, guarda la conversación |

- Un chat nuevo no se escribe en disco hasta que llega el primer mensaje.
  Así no se acumulan chats vacíos.
- Al terminar de responder, el servidor guarda el mensaje del usuario y la
  respuesta completa. Si el cliente corta a mitad (botón Cancelar), se
  guarda la respuesta parcial, igual que hoy se conserva en el historial.

## UI

- **Botón "Nuevo chat"** arriba del panel lateral.
- **Fijados**: sección arriba, con los chats marcados. Se ordenan por
  `updatedAt`.
- **Recientes**: el resto, de más nuevo a más viejo por `updatedAt`.
- Cada fila muestra título, chip con el modelo y fecha relativa.
- Menú por chat: fijar o desfijar, renombrar, eliminar.
- **Eliminar** abre una confirmación con el título del chat. Solo al
  confirmar se llama al `DELETE`. Si el chat eliminado es el activo, la
  pantalla vuelve a "Nuevo chat".
- Si el servidor no responde, la UI conserva el texto escrito y muestra el
  error sin perder la conversación en pantalla.

## Manejo de errores

| Caso | Comportamiento |
|---|---|
| JSON corrupto | Se omite en la lista, se registra en consola |
| Modelo no instalado | Solo lectura, aviso con opción de elegir otro modelo |
| Descarga o carga de modelo falla | Error visible, el chat no cambia de modelo |
| Generación de título falla o tarda | Título de respaldo |
| Corte de conexión durante la respuesta | Se guarda lo recibido hasta el momento |

## Pruebas

El repo no tiene tests automatizados. La validación es:

1. `npx tsc --noEmit` en `app/`
2. En la Pi, después de `whisplay update` y `whisplay service restart`:
   - crear un chat, enviar mensajes, recargar la página y reanudarlo
   - fijar y desfijar, y verificar el orden de "Recientes"
   - cambiar de modelo y verificar la carga con aviso
   - renombrar y verificar que el título ya no se regenera
   - eliminar con confirmación, y cancelar la confirmación
   - reiniciar el servicio y verificar que los chats siguen ahí
   - corromper a propósito un JSON en una copia y verificar que la lista sigue funcionando

## Riesgos

- **Tiempo de carga de modelos en la Pi.** Reabrir un chat con otro modelo
  puede tardar. El aviso con tiempo estimado es parte del diseño, no un
  detalle.
- **Estimación de tokens.** Por caracteres puede recortar de más o de
  menos. Se ajusta con una constante si hace falta.
