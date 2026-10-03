# Comandos en el chat web (`/aviones`, `/wifi`, `/estado`, `/help`, `/ask`)

Fecha: 2026-10-03
Estado: borrador, pendiente de aprobación.

## Objetivo

Que en el chat web (`/#chat`) se pueda consultar la Pi con comandos directos, sin pasar por
el LLM. Cada función de solo lectura del admin tiene su comando. `/help` lista todos los
comandos. Y se puede pedir ayuda o una consulta abierta al LLM local con `/ask`.

Motivo: el LLM local (2B) tarda, a veces elige la herramienta equivocada y agrega frases
que no vienen de los datos. Un comando devuelve el dato exacto del sistema.

## Decisiones (acordadas)

| Tema | Decisión |
|---|---|
| Texto sin `/` | Va al LLM, como hoy. Los comandos son un atajo opcional. |
| Alcance de la primera versión | Solo lectura: `/aviones`, `/wifi`, `/gps`, `/wardrive`, `/estado`, `/help`, `/ask`. Las acciones van en una segunda versión. |
| Confirmación de acciones (segunda versión) | Doble paso en el chat: `/scan` muestra qué hará y pide `/si`. |
| `/ask` | El LLM puede usar herramientas de lectura, con la regla de no inventar datos. |
| Formato de respuesta | Texto fijo, una línea por dato. No tarjetas. |

## Arquitectura

Tres piezas nuevas, cada una con una responsabilidad:

1. **Registro de comandos** (`src/chat-commands/registry.ts`). Se construye desde las
   funciones de solo lectura del admin (`ADMIN_TOOL_DESCRIPTORS` en
   `src/config/admin-tools/registry.ts`). Cada función tiene:
   - un nombre de comando (alias explícito, por ejemplo `getNearbyAircraft` → `aviones`);
   - una descripción, tomada de la descripción de la función;
   - un formateador de texto fijo.
   Si una función no tiene alias, su comando sale del nombre (`getGnssStatus` → `gnss`).
2. **Analizador** (`src/chat-commands/parse.ts`). Decide si un mensaje es un comando, un
   `/ask`, o texto normal. Función pura, sin red.
3. **Ejecutor y ruta** (`POST /api/commands/run`). Llama la función del admin directamente,
   formatea el resultado y lo devuelve como texto. El resultado se guarda en el chat activo
   como dos turnos: el comando del usuario y la respuesta del asistente.

### Flujo

```
mensaje
  ├─ empieza con "/help"      → lista generada desde el registro
  ├─ empieza con "/ask "      → chat con el LLM (herramientas de lectura, mismas reglas)
  ├─ empieza con "/<alias>"   → POST /api/commands/run → función → formateador → texto
  ├─ empieza con "/" otro     → "Comando no existe. Escribe /help."
  └─ texto normal             → chat con el LLM (como hoy)
```

### `/help`

- Se genera desde el registro, no desde una lista escrita a mano. Una función nueva aparece
  en `/help` sin tocar el chat.
- Muestra por cada comando: `/alias` y la descripción de la función.
- No consulta datos: no llama a ninguna función.

### `/ask`

- Pasa por el mismo camino que el texto normal del LLM, con las herramientas de solo lectura.
- El filtro por palabras clave de herramientas sigue activo.
- La regla de "no inventar datos" del chat web se aplica igual.

## Formato de respuesta

Texto fijo, una línea por dato. Ejemplos:

- `/aviones` → `✈ 8 aviones en la zona (24 h)` y luego una línea por avión:
  `AMX217 · visto 03-oct 11:01:07 · 9450 ft · 244 kt`
- `/wifi akbal_lab` → `akbal_lab · canal 11 · -67 dBm · WPA2/WPA3 · 0 clientes`
- `/wifi` sin nombre → las primeras 15 redes, igual que la herramienta.
- `/estado` → modo del radar, GPS (fix sí/no), hora del reloj y memoria.

Los formateadores son funciones puras: reciben el resultado de la función y devuelven texto.
Los números, unidades y horas salen del dato, nunca los escribe el LLM.

## Persistencia

- Un comando y su respuesta se guardan en el chat activo, igual que un mensaje normal, para
  que el historial muestre lo que se consultó.
- Si no hay chat activo, se crea uno con el primer comando, igual que con el primer mensaje.

## Errores

| Caso | Respuesta |
|---|---|
| Comando desconocido | `Comando no existe. Escribe /help.` |
| La función falla (por ejemplo el radar apagado) | Mensaje de error corto con el motivo de la función, sin inventar datos. |
| Sin datos (por ejemplo cero aviones) | `Sin aviones en la zona en las últimas 24 h.` |
| `/wifi <red>` que no existe | `No se encontró ninguna red llamada "<red>"` (ya lo devuelve la herramienta). |

## Pruebas

El repo no tiene tests automatizados de chat. La validación es:

1. **Pruebas unitarias con `node:test`:**
   - el analizador reconoce `/`, `/ask`, `/help` y texto normal
   - el registro tiene un comando por cada función de solo lectura, y ninguno para acciones
   - `/help` lista todos los comandos del registro
   - cada formateador produce el formato fijo con datos de ejemplo
   - un alias desconocido responde con el mensaje de comando inexistente
2. **En la Pi:** cada comando contra datos reales, `/ask` con una pregunta de aviones, y un
   comando con el radar apagado (si se puede apagar sin riesgo).

## Riesgos

- **Alias que chocan.** Dos funciones con el mismo alias. El registro falla al arrancar si
  eso pasa, en vez de elegir uno en silencio.
- **Descripciones pobres.** `/help` muestra la descripción de la función; si está mal
  escrita, `/help` también. Hay que revisarlas al implementar.
- **Formateadores por función.** Cada función necesita su formateador. Las funciones nuevas
  usan un formato genérico hasta que se les escribe uno.

## Fuera de alcance (segunda versión)

- Acciones: escaneo WiFi, auditoría, capturas, borrado de datos.
- Confirmación `/si` para acciones.
- Comandos en el CLI `whisplay` de la Pi (se verán después, sobre la misma API).
