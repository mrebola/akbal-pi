const MAX_WORDS = 6;
const MAX_CHARS = 60;

// Used when the model title is missing, slow, or failed: the first words of
// the user's first message are still a usable label.
export const fallbackTitle = (text: string): string => {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  if (words.length === 0) return "Chat nuevo";
  return words.join(" ").slice(0, MAX_CHARS);
};

// A model title that only repeats the question is no title: the sidebar would
// show the same text the user just typed. Returns null so the caller falls back.
const norm = (text: string): string =>
  text.toLowerCase().replace(/[¿?¡!.,;:"'«»]/g, "").replace(/\s+/g, " ").trim();

export const titleFromModelOutput = (raw: string, question: string): string | null => {
  const cleaned = raw.replace(/["'«»]/g, "").replace(/[.\s]+$/, "").trim();
  if (!cleaned) return null;
  if (norm(cleaned) === norm(question)) return null;
  return cleaned;
};
