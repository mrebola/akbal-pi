// Tool-calling loop for the web admin chat (POST /api/chat in
// device/web-admin-server.ts) — Fase 1 of the admin-chat plan.
//
// Deliberately NOT sharing code with chatWithLLMStreamInternal in
// ollama-llm.ts: that function owns a module-level `messages` singleton
// that's also written to disk and shared with the physical voice flow.
// This loop is stateless with respect to history — the caller passes in
// (and owns) the messages array for a single HTTP request — so a web chat
// session and a voice conversation can never race over the same array.
// The tool-calling algorithm itself (parse tool_calls, dedupe, round
// limit, run via funcMap, recurse) mirrors that file's proven logic; a
// follow-up refactor can extract a single shared implementation once this
// has run on real hardware, but that's a larger, riskier change than
// Fase 1 needs.
import axios from "axios";
import { Readable } from "stream";
import { isEmpty } from "lodash";
import { LLMTool, ToolReturnTag } from "../../type";
import { extractToolResponse } from "../../config/common";
import { ollamaEndpoint } from "./ollama-llm";

export type AdminChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_calls?: unknown;
};

type FunctionCall = { function: { name: string; arguments: Record<string, any> } };

export type AdminToolLoopOptions = {
  model: string;
  // Mutated in place as the conversation progresses (assistant/tool turns
  // get pushed here) — same shape Ollama's /api/chat expects.
  messages: AdminChatMessage[];
  tools: LLMTool[];
  funcMap: Record<string, (params: any) => Promise<string>>;
  maxToolRounds: number;
  numPredict?: number;
  think: boolean;
  signal?: AbortSignal;
  onContent: (text: string) => void;
  onToolStart?: (name: string) => void;
  onToolEnd?: (name: string, result: string) => void;
  // Fires once per Ollama request issued (one per round) so the caller can
  // keep a reference to the live stream and destroy it on client
  // disconnect — same reasoning as the existing /api/chat passthrough's
  // comment on why aborting the signal alone isn't enough once streaming
  // has started.
  onUpstream?: (stream: Readable) => void;
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const callSignature = (call: FunctionCall): string => `${call.function?.name || ""}:${stableStringify(call.function?.arguments || {})}`;

async function requestOllamaChat(opts: {
  model: string;
  messages: AdminChatMessage[];
  tools?: LLMTool[];
  numPredict?: number;
  think: boolean;
  signal?: AbortSignal;
  onContent: (text: string) => void;
  onUpstream?: (stream: Readable) => void;
}): Promise<{ content: string; toolCalls: FunctionCall[] }> {
  const response = await axios.post(
    `${ollamaEndpoint}/api/chat`,
    {
      model: opts.model,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content, ...(m.tool_name ? { tool_name: m.tool_name } : {}) })),
      think: opts.think,
      stream: true,
      options: { num_predict: opts.numPredict },
      tools: opts.tools && opts.tools.length > 0 ? opts.tools : undefined,
      keep_alive: -1,
    },
    { responseType: "stream", signal: opts.signal },
  );
  const upstream: Readable = response.data;
  opts.onUpstream?.(upstream);

  let content = "";
  const toolCallPackages: FunctionCall[][] = [];
  await new Promise<void>((resolve) => {
    let buffer = "";
    upstream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) {
            content += parsed.message.content;
            opts.onContent(parsed.message.content);
          }
          if (parsed.message?.tool_calls) {
            toolCallPackages.push(parsed.message.tool_calls);
          }
        } catch {
          // ignore a partial/malformed line, same as the voice-flow loop
        }
      }
    });
    upstream.on("end", () => resolve());
    upstream.on("error", () => resolve());
  });

  return { content, toolCalls: toolCallPackages.flat() };
}

// Runs until the model stops requesting tools (or the round/duplicate
// guards kick in), mutating `options.messages` with every assistant/tool
// turn along the way. Returns once there's nothing left to stream.
export async function runAdminChatToolLoop(options: AdminToolLoopOptions): Promise<void> {
  const signatures = new Set<string>();
  let round = 0;

  for (;;) {
    const { content, toolCalls } = await requestOllamaChat({
      model: options.model,
      messages: options.messages,
      tools: options.tools,
      numPredict: options.numPredict,
      think: options.think,
      signal: options.signal,
      onContent: options.onContent,
      onUpstream: options.onUpstream,
    });

    options.messages.push({ role: "assistant", content, tool_calls: toolCalls.length > 0 ? toolCalls : undefined });

    if (isEmpty(toolCalls)) return;

    if (round >= options.maxToolRounds) {
      console.warn(`[AdminChat] Reached WEB_ADMIN_CHAT_MAX_TOOL_ROUNDS=${options.maxToolRounds}, stopping tool loop.`);
      return;
    }

    const duplicate = toolCalls.find((call) => signatures.has(callSignature(call)));
    if (duplicate) {
      console.warn(`[AdminChat] Repeated tool call blocked: ${callSignature(duplicate)}`);
      return;
    }
    for (const call of toolCalls) signatures.add(callSignature(call));

    const results = await Promise.all(
      toolCalls.map(async (call) => {
        const name = call.function?.name;
        const func = name ? options.funcMap[name] : undefined;
        if (!func) return { name: name || "unknown", result: `Function ${name} not found` };
        options.onToolStart?.(name!);
        try {
          const result = await func(call.function.arguments);
          options.onToolEnd?.(name!, result);
          return { name: name!, result };
        } catch (err: any) {
          const result = `${ToolReturnTag.Error}Error executing function ${name}: ${err?.message || err}`;
          options.onToolEnd?.(name!, result);
          return { name: name!, result };
        }
      }),
    );

    for (const { name, result } of results) {
      options.messages.push({ role: "tool", content: result, tool_name: name });
    }

    // Same shortcut as the voice-flow loop: a tool result tagged
    // "[response]" is returned to the user as-is instead of asking the
    // model to re-phrase it.
    const direct = results.find((r) => r.result.startsWith(ToolReturnTag.Response));
    if (direct) {
      const text = extractToolResponse(direct.result);
      options.onContent(text);
      options.messages.push({ role: "assistant", content: text });
      return;
    }

    round += 1;
  }
}
