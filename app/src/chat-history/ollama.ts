import axios from "axios";
import { ollamaEndpoint, unloadModel } from "../cloud-api/local/ollama-llm";

// Last observed load time per model, so the UI can show a real estimate
// in the "switch model" warning instead of a made-up number.
export const loadStats: Record<string, number> = {};

// Unloads everything first (see unloadModel in ollama-llm.ts for the RAM
// incident), then warms only the chat's model with keep_alive -1. Does NOT
// call switchModel(): the web chat must not change the voice model.
export const loadChatModel = async (model: string): Promise<{ durationMs: number }> => {
  const started = Date.now();
  await unloadModel();
  await axios.post(`${ollamaEndpoint}/api/chat`, {
    model,
    messages: [],
    keep_alive: -1,
  });
  const durationMs = Date.now() - started;
  loadStats[model] = durationMs;
  return { durationMs };
};

// Mirrors resolveOllamaContextWindow but takes the model explicitly.
// Returns undefined when Ollama does not report a window; the caller then
// uses a conservative default.
export const getContextWindow = async (model: string): Promise<number | undefined> => {
  const response = await axios.post(`${ollamaEndpoint}/api/show`, { model });
  const info = response.data?.model_info || {};
  for (const [key, value] of Object.entries(info)) {
    if (/context_length$/i.test(key) && Number(value) > 0) return Number(value);
  }
  return undefined;
};

// Short, non-thinking, non-streaming call. The chat's model is already
// resident (we just answered with it), so this adds no load.
export const generateTitle = async (
  model: string,
  firstUserMessage: string,
  firstAssistantMessage: string,
  timeoutMs = 15000,
): Promise<string | null> => {
  const prompt =
    "Resume esta conversación en un título de máximo 6 palabras, en español, " +
    "sin comillas ni punto final. Responde solo con el título.\n\n" +
    `Usuario: ${firstUserMessage.slice(0, 500)}\n` +
    `Asistente: ${firstAssistantMessage.slice(0, 500)}`;
  try {
    const response = await axios.post(
      `${ollamaEndpoint}/api/chat`,
      {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: false,
        options: { temperature: 0.3, num_predict: 24 },
        keep_alive: -1,
      },
      { timeout: timeoutMs },
    );
    const raw: string = response.data?.message?.content || "";
    const cleaned = raw.replace(/["'«»]/g, "").replace(/[.\s]+$/, "").trim();
    return cleaned || null;
  } catch (err: any) {
    console.warn(`[ChatHistory] title generation failed: ${err?.message || err}`);
    return null;
  }
};
