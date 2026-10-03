import { ChatStore } from "./store";
import { StoredChat } from "./types";

// What a finished, cancelled or failed exchange leaves on disk. Shared by the
// normal, cancelled and pre-stream paths so they cannot drift apart.
export const settleExchange = (
  store: ChatStore,
  chatId: string,
  opts: { assistantText: string; isNewChat: boolean },
): StoredChat | null => {
  if (opts.assistantText) return store.appendMessage(chatId, "assistant", opts.assistantText);
  // No reply at all (cancelled before the first token, or the upstream call
  // failed): a new chat has nothing worth keeping, so its file goes; an
  // existing chat keeps its history and only drops the orphan user turn.
  if (opts.isNewChat) {
    store.delete(chatId);
    return null;
  }
  store.removeLastUserMessage(chatId);
  return store.get(chatId);
};

// The first real question of a chat: commands ("/...") are not questions, so a
// chat that began with commands is still titled by its first question.
export const firstQuestion = (chat: StoredChat): string | null => {
  const found = chat.messages.find((m) => m.role === "user" && !m.content.trim().startsWith("/"));
  return found ? found.content : null;
};

// The title is generated from the first question, before the reply starts,
// as long as the chat still has its default title and was not renamed.
export const needsTitleBeforeReply = (chat: StoredChat | null): boolean =>
  !!chat && !chat.titleEdited && chat.title === "Chat nuevo" && firstQuestion(chat) !== null;

// Automatic titles are for the first exchange only, and never after a rename or
// a title already set before the reply.
export const needsAutoTitle = (chat: StoredChat | null): boolean =>
  !!chat && !chat.titleEdited && chat.title === "Chat nuevo" && chat.messages.length === 2;
