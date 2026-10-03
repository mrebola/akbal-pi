# Selección de modelo LLM local (Ollama)

Registro de por qué se cambió el modelo por defecto de `qwen3:1.7b` a
`huihui_ai/qwen3.5-abliterated:2B`, y por qué se descartó un tercer modelo
probado en el camino (`hf.co/mradermacher/Qwen3.5-4B-Uncensored-GGUF:Q4_K_M`).

## Metodología

Medir siempre con una llamada directa a la API de Ollama, con `think:false`
(la misma opción que manda `app/src/cloud-api/local/ollama-llm.ts` cuando
`ENABLE_THINKING=false`) — probar sin esa opción da tiempos y comportamiento
engañosos, porque el modelo entra en modo "thinking" y el conteo de tokens
incluye el razonamiento interno, no la respuesta real:

```bash
curl -s http://localhost:11434/api/chat -d '{
  "model": "<modelo>",
  "messages": [{"role": "user", "content": "di hola en una palabra"}],
  "stream": false,
  "think": false
}'
```

## Modelos probados

| Modelo | Tamaño en disco | Velocidad | Veredicto |
|---|---|---|---|
| `qwen3:1.7b` | 1.4 GB | Rápido (referencia original) | Usado desde el setup inicial, ver [`SETUP.md`](./SETUP.md). |
| `hf.co/mradermacher/Qwen3.5-4B-Uncensored-GGUF:Q4_K_M` | 3.2 GB | ~2.9 tok/s | **Descartado.** Además de lento (4B en CPU pura), no respetaba el token de stop: con `think:false` igual siguió generando más de 500 tokens para "di hola en una palabra" sin terminar. El `.gguf` trae un `mmproj` (es una variante VL/multimodal) y el `llama-server` que levanta Ollama para este modelo no fuerza `--chat-template chatml` como sí hace para `qwen3:1.7b` — probablemente la plantilla Jinja embebida en este quant comunitario no emite bien el EOS. |
| `huihui_ai/qwen3.5-abliterated:2B` | 1.9 GB | ~9 tok/s, responde en <1s para respuestas cortas | **El que se usa ahora.** Con `think:false` corta bien (`done_reason: "stop"`) y es más rápido que el modelo de 4B. |
| `huihui_ai/qwen3-abliterated:1.7b` (modelo 4 del menú de voz) | 1.1 GB | Rápido | **No usar como default.** Con prompts cortos ("Dime algo.", "¡Venga!") a veces repite el prompt del usuario en vez de responder — se detectó en producción el 2026-09-17 después de que un comando de voz mal reconocido lo dejó activo (ver `docs/voice-commands.md`, el menú de voz ya no cambia de modelo a ciegas por esto). Sigue disponible como opción manual en el menú, pero no como fallback automático. |

## Configuración actual

```
OLLAMA_MODEL=huihui_ai/qwen3.5-abliterated:2B
ENABLE_THINKING=false
```

## Si se quiere probar otro modelo

1. `ollama pull <modelo>` en la Pi.
2. Medir con la llamada `curl` de arriba (`think:false`) antes de asumir que
   sirve — un modelo más grande no es necesariamente mejor en este hardware
   (CPU-only, sin GPU/NPU en el camino de Ollama).
3. Cambiar `OLLAMA_MODEL` en `.env` y `sudo systemctl restart chatbot.service`.

## Benchmark 2026-10-03: velocidad + corrección de los 7 modelos instalados

Con estos modelos instalados (`ollama list`):

```
hf.co/Unrestricted/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive:Q4_K_M  3.4 GB
huihui_ai/qwen3-abliterated:1.7b-v2                                  1.1 GB
deepseek-r1:1.5b                                                     1.1 GB
llama3.2:3b                                                          2.0 GB
qwen3.5:2B                                                           2.7 GB
huihui_ai/qwen3.5-abliterated:2B                                     1.9 GB  (default actual)
qwen3:1.7b                                                           1.4 GB
```

(`huihui_ai/qwen3-abliterated:1.7b`, sin `-v2`, se borró — mismo ID/mismo
peso que `-v2`, era un duplicado exacto.)

### Velocidad (API directa de Ollama, `think:false`, prompt corto en español)

| Modelo | Carga en frío | Tokens/s generando | Respuesta completa (caliente) |
|---|---|---|---|
| qwen3:1.7b | 17 s | 8.0 | 5.6 s |
| huihui_ai/qwen3.5-abliterated:2B | 25 s | 6.6 | 6.1 s |
| huihui_ai/qwen3-abliterated:1.7b-v2 | 15 s | 9.0 | 7.2 s |
| deepseek-r1:1.5b | 14 s | 10.4 | 9.7 s (siempre usa el cupo de tokens) |
| qwen3.5:2B | 34 s | 4.5 | 11.0 s |
| llama3.2:3b | 26-30 s | 5.0 | 20.3 s |
| hf.co/.../Qwen3.5-4B-Uncensored-HauhauCS-Aggressive:Q4_K_M | 28-30 s | 2.9 | 21.1 s |

(Metodología como arriba — ver `bench.py` usado para medir, no versionado
porque era de un solo uso; repetir con la receta de este doc si hace falta.)

### Corrección (desde el chat real en `/` — no API directa) — "inteligencia práctica"

Prompt usado (requiere 2 pasos de aritmética + seguir una instrucción de
formato, representativo de lo que un asistente de voz necesita resolver
bien y corto):

> Tengo 8 manzanas. Le doy 3 a un amigo y me como 2. ¿Cuántas me quedan?
> Responde solo con el número.

Respuesta correcta: **3**.

| Modelo | Respondió | Correcto | Notas |
|---|---|---|---|
| hf.co/.../Qwen3.5-4B-Uncensored-HauhauCS-Aggressive:Q4_K_M | 3 | ✅ | El único grande que acierta y responde corto. |
| deepseek-r1:1.5b | 3 | ✅ | Acierta, pero **ignoró la instrucción** "responde solo con el número": contestó con un desarrollo paso a paso en **LaTeX crudo sin renderizar** (`\[`, `\text{...}`, `\boxed{3}`) — en este chat (texto plano) se ve como símbolos sueltos, y si algún día esto se lee por voz (TTS) sonaría roto. Tardó ~30 s. |
| huihui_ai/qwen3-abliterated:1.7b-v2 | 1 | ❌ | Calculó `3 - 2 = 1`, ignorando por completo las 8 manzanas iniciales. |
| llama3.2:3b (fallback de "modo agente", `DEFAULT_OLLAMA_MODEL`) | 5 | ❌ | Solo restó `8 - 3`, ignoró que además se comió 2. |
| qwen3.5:2B | 4 | ❌ | Resultado sin relación clara con el enunciado. |
| **huihui_ai/qwen3.5-abliterated:2B (default actual en `.env`)** | 8 | ❌ | Ni siquiera restó — repitió el número inicial. |
| qwen3:1.7b | 5 | ❌ | Mismo error que llama3.2:3b (`8 - 3`, ignora el "me como 2"). |

**Conclusión incómoda:** de los 7 modelos instalados, los 5 más rápidos
(todos los qwen3 de 1.7-2B, incluido el default actual) fallan una
aritmética de 2 pasos bastante simple. Solo el 4B (lento, 21 s por
respuesta) y deepseek-r1 (lento y con salida rota para este chat) acertaron.
**No hay ganador claro todavía entre "rápido" e "inteligente" con lo que hay
instalado** — ver recomendación abajo.

### Recomendación

- No cambiar el default por ahora: `huihui_ai/qwen3.5-abliterated:2B` sigue
  siendo razonable para charla casual por voz (rápido, formato limpio), pero
  quedó documentado que **falla aritmética simple** — no confiar en él para
  nada que dependa de contar/calcular bien.
- Si en algún momento se necesita que el asistente cuente o calcule bien,
  probar modelos de 3-4B *instruct* (no "abliterated", que son fine-tunes
  enfocados en quitar rechazos, no en razonar mejor) antes de asumir que hay
  que subir de tamaño — el 4B Hauhau probado aquí es un quant comunitario
  "uncensored", no uno optimizado para este caso.
- Si se prueba `deepseek-r1` para algo, hay que sanear/renderizar LaTeX
  antes de mostrarlo en el chat o pasarlo a TTS — tal cual sale hoy no sirve
  para este UI.

## Incidente 2026-10-03: la Pi se trabó (hasta perder SSH) al probar varios modelos seguidos

**Qué pasó:** al comparar los 7 modelos cambiando de uno a otro desde el
dropdown del chat web, sin usar "Descargar de memoria" entre cada cambio,
se acumularon 3 modelos residentes a la vez (`llama3.2:3b` 2.9 GB +
`deepseek-r1:1.5b` 1.3 GB + `qwen3.5:2B` cargando, 2.7 GB más ≈ 6.9 GB de
modelos) sobre una Pi de 8 GB con swap de 2 GB en la SD. El sistema entró en
swap thrashing tan severo que **hasta SSH dejó de responder**
(`Connection timed out during banner exchange`) aunque el ping normal
seguía andando (la red estaba bien; era CPU/IO de la SD saturados). Se
resolvió reiniciando la Pi físicamente.

**Causa raíz:** `switchModel()` (`app/src/cloud-api/local/ollama-llm.ts`)
carga cada modelo con `keep_alive: -1` ("Forever") y nunca descarga el
anterior — es una decisión a propósito (comentario en el código) para que
flujos que alternan entre 2 modelos (p. ej. el fallback local de "modo
agente") no paguen una carga en frío cada vez. El botón "Descargar de
memoria" en Ajustes > IA es la válvula de escape manual para esto, pero
nada impedía que el chat web — pensado para que una persona pruebe modelos
uno por uno — fuera acumulando cada modelo que se probaba.

**Fix aplicado:** `POST /api/models/select` (el endpoint que usa el
dropdown del chat web) ahora llama a `unloadModel()` antes de
`switchModel()`, así que esa pantalla nunca mantiene más de un modelo
cargado a la vez — ver `app/src/device/web-admin-server.ts`. El
comportamiento de voz/modo-agente (que no pasa por este endpoint) no
cambió, así que el fallback rápido entre modelos ahí se mantiene.

**Pendiente/a vigilar:** `vm.swappiness` en la Pi está en el default (60),
sin ajustar para una SD card lenta. Si se vuelve a ver este tipo de
cuelgue, bajar `swappiness` (p. ej. a 10) es un siguiente paso razonable —
no se tocó en esta sesión porque es una config de sistema, no de la app.

## Fix 2026-10-03: el chat web gastaba el cupo de tokens "pensando" sin mostrarlo

`POST /api/chat` (el proxy que usa `web/admin/app.js` para el chat) nunca
mandaba `think` a Ollama, a diferencia de `ollama-llm.ts` que sí respeta
`ENABLE_THINKING` (default `false`). Para los modelos qwen3 (son modelos
"thinking"), eso significaba que cada respuesta gastaba la mayoría de
`num_predict` en razonamiento oculto (`message.thinking`, que
`web/admin/app.js` ni siquiera lee) antes de llegar al texto visible:

```
sin think:false  → 366 caracteres de "thinking" + "hola" visible, 107 tokens totales
con think:false  → sin thinking, respuesta visible directa, 11 tokens totales
```

**Fix aplicado:** `/api/chat` ahora manda `think: process.env.ENABLE_THINKING === "true"`,
igual que el resto de la app — ver `app/src/device/web-admin-server.ts`.
