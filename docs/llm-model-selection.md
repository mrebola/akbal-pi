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
