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

// A brand-new chat gets its title from the first question, before the reply
// starts. Only the first turn, and never after a rename.
export const needsTitleBeforeReply = (chat: StoredChat | null): boolean =>
  !!chat && !chat.titleEdited && chat.title === "Chat nuevo" && chat.messages.length === 1;

// Automatic titles are for the first exchange only, and never after a rename or
// a title already set before the reply.
export const needsAutoTitle = (chat: StoredChat | null): boolean =>
  !!chat && !chat.titleEdited && chat.title === "Chat nuevo" && chat.messages.length === 2;
