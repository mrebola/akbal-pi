export type ChatRole = "user" | "assistant" | "system";

export interface StoredMessage {
  role: ChatRole;
  content: string;
}

export interface ChatMeta {
  id: string;
  title: string;
  model: string;
  pinned: boolean;
  // True once the user renames the chat; stops automatic title generation.
  titleEdited: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredChat extends ChatMeta {
  messages: StoredMessage[];
}

export type ChatPatch = Partial<Pick<ChatMeta, "title" | "pinned" | "model" | "titleEdited">>;
