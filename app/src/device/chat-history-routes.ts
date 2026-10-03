import path from "path";
import * as fs from "fs";
import { isSafeClipName } from "../voice/audio-names";
import { clipPath, removeClipsForChat, saveClips } from "../voice/piper-clips";
import { toSpeechChunks } from "../voice/speech-chunks";
import Router from "@koa/router";
import { ChatStore } from "../chat-history/store";
import { loadChatModel, loadStats } from "../chat-history/ollama";
import { chatHistoryDir } from "../utils/dir";

// Own subfolder: Gemini/Volcengine/MiniMax already write *_chat_history_*.json
// into chatHistoryDir, and listing that folder would pick them up.
export const chatStore = new ChatStore(path.join(chatHistoryDir, "web"));

export const registerChatHistoryRoutes = (router: Router): void => {
  router.get("/api/chats", (ctx) => {
    ctx.body = chatStore.list();
  });

  router.get("/api/chats/:id", (ctx) => {
    const chat = chatStore.get(ctx.params.id);
    if (!chat) {
      ctx.status = 404;
      ctx.body = { error: "chat no encontrado" };
      return;
    }
    ctx.body = chat;
  });

  router.patch("/api/chats/:id", (ctx) => {
    const body = (ctx.request.body as any) || {};
    const patch: Record<string, unknown> = {};
    if (typeof body.title === "string") {
      const title = body.title.trim().slice(0, 80);
      if (!title) {
        ctx.status = 400;
        ctx.body = { error: "el título no puede estar vacío" };
        return;
      }
      patch.title = title;
      patch.titleEdited = true;
    }
    if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
    // Model changes go through here, but the actual load is a separate
    // call (POST /api/chat-models/load) so the UI can show the warning.
    if (typeof body.model === "string" && body.model) patch.model = body.model;

    const updated = chatStore.update(ctx.params.id, patch);
    if (!updated) {
      ctx.status = 404;
      ctx.body = { error: "chat no encontrado" };
      return;
    }
    ctx.body = updated;
  });

  // The speaker button: clips for one assistant reply, made once and reused.
  router.post("/api/chats/:id/messages/:index/audio", async (ctx) => {
    const chat = chatStore.get(ctx.params.id);
    const index = Number(ctx.params.index);
    const message = chat && Number.isInteger(index) ? chat.messages[index] : undefined;
    if (!chat || !message || message.role !== "assistant") {
      ctx.status = 404;
      ctx.body = { error: "respuesta no encontrada" };
      return;
    }
    if (message.audio && message.audio.length) {
      ctx.body = { files: message.audio };
      return;
    }
    const chunks = toSpeechChunks(message.content);
    if (chunks.length === 0) {
      ctx.status = 400;
      ctx.body = { error: "no hay texto que leer" };
      return;
    }
    try {
      const files = await saveClips(chat.id, index, chunks);
      chatStore.setAudioAt(chat.id, index, files);
      ctx.body = { files };
    } catch (err: any) {
      ctx.status = 502;
      ctx.body = { error: `no se pudo generar el audio: ${err?.message || err}` };
    }
  });

  // A voice clip. Only names built by clipFileName() are served.
  router.get("/api/chat-audio/:file", (ctx) => {
    const name = ctx.params.file;
    if (!isSafeClipName(name) || !fs.existsSync(clipPath(name))) {
      ctx.status = 404;
      ctx.body = { error: "audio no encontrado" };
      return;
    }
    ctx.type = "audio/wav";
    ctx.body = fs.createReadStream(clipPath(name));
  });

  // Every saved chat. The page asks for confirmation before calling this.
  router.post("/api/chats/delete-all", (ctx) => {
    for (const meta of chatStore.list()) removeClipsForChat(meta.id);
    ctx.body = { deleted: chatStore.deleteAll() };
  });

  router.delete("/api/chats/:id", (ctx) => {
    removeClipsForChat(ctx.params.id);
    if (!chatStore.delete(ctx.params.id)) {
      ctx.status = 404;
      ctx.body = { error: "chat no encontrado" };
      return;
    }
    ctx.body = { ok: true };
  });

  router.post("/api/chat-models/load", async (ctx) => {
    const model = (ctx.request.body as any)?.model;
    if (!model || typeof model !== "string") {
      ctx.status = 400;
      ctx.body = { error: "model requerido" };
      return;
    }
    try {
      const { durationMs } = await loadChatModel(model);
      ctx.body = { ok: true, model, durationMs };
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { ok: false, error: err?.message || String(err) };
    }
  });

  // Lets the UI show "tardó ~N s la última vez" before the user confirms.
  router.get("/api/chat-models/stats", (ctx) => {
    ctx.body = loadStats;
  });
};
