import { StoredMessage } from "./types";

// Rough on purpose: an exact tokenizer would mean loading one more thing
// on an 8GB Pi. Off by a bit either way is fine, the window only has to
// avoid overflowing the model's context.
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

// System messages always go in (persona + RAG) and do not count against the
// turn budget. Turns are then added from newest to oldest until the budget
// is spent, so the model sees the most recent exchange. The newest user
// message is never dropped, even if it alone is over budget; a single huge
// paste should fail visibly, not silently answer a previous question.
export const trimToWindow = (messages: StoredMessage[], budgetTokens: number): StoredMessage[] => {
  const system = messages.filter((m) => m.role === "system");
  const turns = messages.filter((m) => m.role !== "system");
  let remaining = budgetTokens;

  const kept: StoredMessage[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = estimateTokens(turns[i].content);
    const mustKeep = kept.length === 0 && turns[i].role === "user";
    if (cost > remaining && !mustKeep) break;
    kept.unshift(turns[i]);
    remaining -= cost;
  }

  // System messages go back at the front, in their original order.
  return [...system, ...kept];
};
