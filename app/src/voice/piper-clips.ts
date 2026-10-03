import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { chatHistoryDir } from "../utils/dir";
import { clipFileName, clipsOfChat } from "./audio-names";

// Akbal's own voice: the Piper HTTP server the device already runs. Clips are
// generated here and saved, never played on the Pi's speaker.
const host = process.env.PIPER_HTTP_HOST || "localhost";
const port = process.env.PIPER_HTTP_PORT || "8805";

export const audioDir = path.join(chatHistoryDir, "web", "audio");
fs.mkdirSync(audioDir, { recursive: true });

export const clipPath = (name: string): string => path.join(audioDir, name);

export const synthesizeWav = async (text: string): Promise<Buffer> => {
  const res = await axios.post(
    `http://${host}:${port}/synthesize`,
    { text },
    { responseType: "arraybuffer", timeout: 120_000 },
  );
  return Buffer.from(res.data);
};

// Deletes the voice clips of one chat. Called before the chat itself goes, so
// a deleted chat leaves no audio behind.
export const removeClipsForChat = (chatId: string): number => {
  if (!fs.existsSync(audioDir)) return 0;
  let removed = 0;
  for (const name of clipsOfChat(fs.readdirSync(audioDir), chatId)) {
    fs.unlinkSync(clipPath(name));
    removed++;
  }
  return removed;
};

// One clip per chunk, in order. Returns the file names to store on the message.
export const saveClips = async (chatId: string, messageIndex: number, chunks: string[]): Promise<string[]> => {
  const names: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const wav = await synthesizeWav(chunks[i]);
    const name = clipFileName(chatId, messageIndex, i);
    fs.writeFileSync(clipPath(name), wav);
    names.push(name);
  }
  return names;
};
