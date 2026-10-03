import fs from "fs";
import { soulFilePath } from "../utils/dir";

require("dotenv").config();

// The "soul file" (default app/soul/akbal.md, override with SOUL_FILE in
// .env) is Akbal's editable identity/persona — who it is, what it does,
// its boundaries — kept as a plain markdown file instead of a single
// SYSTEM_PROMPT env line so it's easy to read and edit on its own (including
// from the web admin's Settings > Soul tab, see config/soul-files.ts). Falls
// back to SYSTEM_PROMPT (and then the original fork's default persona) so
// upgrading doesn't require creating the file first.
const soulFileOverride = (process.env.SOUL_FILE || "").trim();
const readSoulFile = (): string => {
  const candidate = soulFileOverride || soulFilePath;
  try {
    const raw = fs.readFileSync(candidate, "utf8");
    // Strip HTML comments before using the file as the prompt — lets the
    // file carry editing notes for whoever opens it (see akbal.md's own
    // header) without spending tokens on them every single turn.
    return raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  } catch {
    return "";
  }
};

const DEFAULT_PERSONA_PROMPT =
  "You are a young and cheerful girl who loves to talk, chat, help others, and learn new things. You enjoy using emoji expressions. Never answer longer than 200 words. Always keep your answers concise and to the point.";

const speechFriendlyPrompt =
  " Format your replies for spoken text-to-speech. Do not use Markdown formatting that sounds awkward when read aloud, such as tables, code blocks, headings, bullet lists, numbered lists, inline links, footnote markers, or decorative separators. Use natural conversational sentences and plain punctuation instead.";

const wakeWordEnabled =
  (process.env.WAKE_WORD_ENABLED || "").toLowerCase() === "true";

const wakeWordConversationToolPrompt = wakeWordEnabled
  ? " If the endConversation tool is available and the user clearly wants to end the current conversation, call that tool before giving your brief final reply."
  : "";

// default 5 minutes
export const CHAT_HISTORY_RESET_TIME = parseInt(process.env.CHAT_HISTORY_RESET_TIME || "300" , 10) * 1000; // convert to milliseconds

export let lastMessageTime = 0;

export const updateLastMessageTime = (): void => {
  lastMessageTime = Date.now();
}

export const shouldResetChatHistory = (): boolean => {
  return Date.now() - lastMessageTime > CHAT_HISTORY_RESET_TIME;
}

// Identity/persona only, no speech formatting rules — this is what the web
// admin chat uses (device/web-admin-server.ts): it's a text UI, so the
// "write like it'll be read aloud" constraint below would just make
// replies worse there (no reason to forbid lists/markdown in a chat
// bubble). getSystemPrompt() below adds that on top of the exact same
// identity, for voice.
//
// Both re-read the soul file on every call (readSoulFile() above does no
// caching) — editing it from Settings > Soul applies on the very next
// turn, no `whisplay service restart` needed. ollama-llm.ts's tool loop
// also refreshes its standing system message from this on every turn for
// the same reason (see its chatWithLLMStreamInternal).
export const getBasePersonaPrompt = (): string =>
  readSoulFile() || process.env.SYSTEM_PROMPT || DEFAULT_PERSONA_PROMPT;

export const getSystemPrompt = (): string =>
  `${getBasePersonaPrompt()}${speechFriendlyPrompt}${wakeWordConversationToolPrompt}`;

// Frozen, startup-time copies — kept only because every OTHER cloud
// provider (openai-llm.ts, anthropic-llm.ts, gemini-llm.ts, etc.) still
// imports these exact names and bakes the value into their own
// module-level history singleton once, the same pattern ollama-llm.ts used
// to. None of those providers are active in this deployment
// (LLM_SERVER=ollama), so leaving them on the old frozen behavior is zero
// risk — but don't reach for these in new code, prefer the live functions
// above.
export const basePersonaPrompt = getBasePersonaPrompt();
export const systemPrompt = getSystemPrompt();
