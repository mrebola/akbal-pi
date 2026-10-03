// Spoken-answer requests, matched on accent-free lowercase text. Keyword match
// on purpose: the local model is not asked to decide, and a plain question never
// costs an extra synthesis.
const normalize = (text: string): string =>
  text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const PATTERNS: RegExp[] = [
  /\bpor voz\b/,
  /\ben voz alta\b/,
  /\bcon voz\b/,
  /\bcon audio\b/,
  /\bhablame\b/,
  /\bdimelo (?:con voz|en voz)\b/,
];

export const wantsVoiceReply = (message: string): boolean => {
  const trimmed = message.trim();
  if (trimmed.startsWith("/")) return false;
  const text = normalize(trimmed);
  return PATTERNS.some((p) => p.test(text));
};
