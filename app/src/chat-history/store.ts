import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { ChatMeta, ChatPatch, ChatRole, StoredChat, StoredMessage } from "./types";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Keeps one JSON file per chat. Writes go to a .tmp file and are renamed
// into place, so a power cut mid-save leaves the previous version intact
// (the Pi runs on a PiSugar battery).
export class ChatStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  isValidId(id: string): boolean {
    return typeof id === "string" && ID_PATTERN.test(id);
  }

  list(): ChatMeta[] {
    const metas: ChatMeta[] = [];
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      const chat = this.readFile(file.slice(0, -".json".length));
      if (chat) metas.push(stripMessages(chat));
    }
    return metas.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  get(id: string): StoredChat | null {
    if (!this.isValidId(id)) return null;
    return this.readFile(id);
  }

  create(model: string): StoredChat {
    const now = new Date().toISOString();
    // Not written yet: a chat only reaches disk with its first message.
    return {
      id: crypto.randomUUID(),
      title: "Chat nuevo",
      model,
      pinned: false,
      titleEdited: false,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  // The only write path for a chat that is not on disk yet. appendMessage()
  // refuses unknown ids on purpose, so a deleted chat cannot come back.
  createWithMessage(model: string, role: ChatRole, content: string): StoredChat {
    const chat = this.create(model);
    chat.messages.push({ role, content });
    this.writeFile(chat);
    return chat;
  }

  appendMessage(id: string, role: ChatRole, content: string): StoredChat | null {
    const chat = this.get(id);
    if (!chat) return null;
    chat.messages.push({ role, content });
    chat.updatedAt = new Date().toISOString();
    this.writeFile(chat);
    return chat;
  }

  // Records clips on the assistant turn at `index`. A user turn is refused.
  setAudioAt(id: string, index: number, audio: string[]): StoredChat | null {
    const chat = this.get(id);
    if (!chat) return null;
    const message = chat.messages[index];
    if (message?.role !== "assistant") return null;
    message.audio = audio;
    this.writeFile(chat);
    return chat;
  }

  // Marks the last assistant turn as a voice reply and records its clips.
  setLastAssistantAudio(id: string, audio: string[]): StoredChat | null {
    const chat = this.get(id);
    if (!chat) return null;
    const last = chat.messages[chat.messages.length - 1];
    if (last?.role !== "assistant") return chat;
    last.voice = true;
    last.audio = audio;
    this.writeFile(chat);
    return chat;
  }

  removeLastUserMessage(id: string): void {
    const chat = this.get(id);
    if (!chat) return;
    const last: StoredMessage | undefined = chat.messages[chat.messages.length - 1];
    if (last?.role !== "user") return;
    chat.messages.pop();
    this.writeFile(chat);
  }

  update(id: string, patch: ChatPatch): StoredChat | null {
    const chat = this.get(id);
    if (!chat) return null;
    Object.assign(chat, patch);
    this.writeFile(chat);
    return chat;
  }

  delete(id: string): boolean {
    if (!this.isValidId(id)) return false;
    const file = this.filePath(id);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }

  // Removes every chat file. Only names that are valid chat ids are touched,
  // so an unrelated JSON file in the same folder survives.
  deleteAll(): number {
    let removed = 0;
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -".json".length);
      if (!this.isValidId(id)) continue;
      fs.unlinkSync(this.filePath(id));
      removed++;
    }
    return removed;
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private readFile(id: string): StoredChat | null {
    if (!this.isValidId(id)) return null;
    const file = this.filePath(id);
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed?.id !== id || !Array.isArray(parsed.messages)) {
        throw new Error("shape mismatch");
      }
      return parsed as StoredChat;
    } catch (err: any) {
      console.warn(`[ChatStore] skipping unreadable chat ${id}: ${err?.message || err}`);
      return null;
    }
  }

  private writeFile(chat: StoredChat): void {
    const file = this.filePath(chat.id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(chat, null, 2));
    fs.renameSync(tmp, file);
  }
}

const stripMessages = (chat: StoredChat): ChatMeta => {
  const { messages: _messages, ...meta } = chat;
  return meta;
};
