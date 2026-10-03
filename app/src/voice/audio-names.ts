// Clip files are named from the chat id, message index and chunk number. The
// same pattern is the only one the audio route serves, so a request can never
// reach a file outside the audio folder.
const CLIP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+-\d+\.wav$/;

export const clipFileName = (chatId: string, messageIndex: number, chunk: number): string =>
  `${chatId}-${messageIndex}-${chunk}.wav`;

export const isSafeClipName = (name: string): boolean => CLIP.test(name);
