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

// Automatic titles are for the first exchange only, and never after a rename.
export const needsAutoTitle = (chat: StoredChat | null): boolean =>
  !!chat && !chat.titleEdited && chat.messages.length === 2;
