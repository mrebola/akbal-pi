export type Parsed =
  | { kind: "text" }
  | { kind: "help" }
  | { kind: "ask"; text: string }
  | { kind: "command"; name: string; args: string };

// A message starting with "/" is a command; everything else is for the LLM.
// /help and /ask never reach the command registry.
export const parseMessage = (input: string): Parsed => {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { kind: "text" };
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = (head || "").toLowerCase();
  const args = rest.join(" ").trim();
  if (name === "help") return { kind: "help" };
  if (name === "ask") return { kind: "ask", text: args };
  return { kind: "command", name, args };
};
