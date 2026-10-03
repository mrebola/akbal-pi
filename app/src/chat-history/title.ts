const MAX_WORDS = 6;
const MAX_CHARS = 60;

// Used when the model title is missing, slow, or failed: the first words of
// the user's first message are still a usable label.
export const fallbackTitle = (text: string): string => {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  if (words.length === 0) return "Chat nuevo";
  return words.join(" ").slice(0, MAX_CHARS);
};
