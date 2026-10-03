// Turns an answer into chunks a voice can read: markdown symbols removed,
// paragraphs kept apart, and long paragraphs cut at sentence ends so each
// synthesized clip stays short enough to start playing quickly on a Pi.
const DEFAULT_MAX = 400;

const stripMarkdown = (text: string): string =>
  text
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

const splitLong = (text: string, max: number): string[] => {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const out: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > max) {
      if (current) out.push(current), (current = "");
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
      continue;
    }
    if ((current + " " + s).trim().length > max) {
      out.push(current);
      current = s;
    } else {
      current = (current + " " + s).trim();
    }
  }
  if (current) out.push(current);
  return out;
};

export const toSpeechChunks = (answer: string, max = DEFAULT_MAX): string[] =>
  answer
    .split(/\n\s*\n/)
    .map((p) => stripMarkdown(p))
    .filter((p) => p.length > 0)
    .flatMap((p) => (p.length > max ? splitLong(p, max) : [p]));
