import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { isEmpty } from "lodash";
import {
  shouldResetChatHistory,
  systemPrompt,
  updateLastMessageTime,
} from "../../config/llm-config";
import { llmTools, llmFuncMap } from "../../config/llm-tools";
import dotenv from "dotenv";
import {
  Message,
  OllamaFunctionCall,
  OllamaMessage,
  ToolReturnTag,
} from "../../type";
import { ChatWithLLMStreamFunction, SummaryTextWithLLMFunction } from "../interface";
import { chatHistoryDir } from "../../utils/dir";
import moment from "moment";
import {
  extractToolResponse,
  stimulateStreamResponse,
} from "../../config/common";
import { defaultPortMap } from "./common";
import {
  consumePendingCapturedImgForChat,
  hasPendingCapturedImgForChat,
} from "../../utils/image";
import { compactMessagesForContextWindow } from "../context-window";
import { persistEnvVar } from "../../utils/env-file";

dotenv.config();

// Ollama LLM configuration
const ollamaEndpoint =
  process.env.OLLAMA_ENDPOINT || `http://localhost:${defaultPortMap.ollama}`;
// The documented best-performing local model (see
// docs/llm-model-selection.md) — used as the .env fallback below, and also
// what "modo agente" switches to for its local fallback when OpenClaw
// doesn't answer in time (see chat-flow/states.ts), regardless of whichever
// model a previous voice command left active.
export const DEFAULT_OLLAMA_MODEL = "huihui_ai/qwen3.5-abliterated:2B";
// Mutable so voice commands (see chat-flow/voice-commands.ts) can switch the
// active model at runtime without restarting the process.
let currentOllamaModel = process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
const ollamaEnableTools = process.env.OLLAMA_ENABLE_TOOLS === "true";
const ollamaMaxToolRounds = Math.max(
  0,
  parseInt(process.env.OLLAMA_MAX_TOOL_ROUNDS || "4", 10) || 0,
);
const ollamaPredictNum = process.env.OLLAMA_PREDICT_NUM
  ? parseInt(process.env.OLLAMA_PREDICT_NUM)
  : undefined;
const enableThinking = process.env.ENABLE_THINKING === "true";
const useCapturedImageInChat =
  (process.env.USE_CAPTURED_IMAGE_IN_CHAT || "false").toLowerCase() ===
  "true";

const llmServer = process.env.LLM_SERVER || "";

let ollamaContextWindowCache: number | undefined;

const findContextWindowValue = (value: unknown): number | undefined => {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      /(context_length|num_ctx|context.*length)$/i.test(key) &&
      Number.isFinite(Number(child)) &&
      Number(child) > 0
    ) {
      return Number(child);
    }
    const nested = findContextWindowValue(child);
    if (nested) return nested;
  }
  return undefined;
};

const resolveOllamaContextWindow = async (): Promise<number | undefined> => {
  if (ollamaContextWindowCache) return ollamaContextWindowCache;
  const response = await axios.post(`${ollamaEndpoint}/api/show`, {
    model: currentOllamaModel,
  });
  ollamaContextWindowCache =
    findContextWindowValue(response.data?.model_info) ||
    findContextWindowValue(response.data?.details) ||
    findContextWindowValue(response.data);
  return ollamaContextWindowCache;
};

const chatHistoryFileName = `ollama_chat_history_${moment().format(
  "YYYY-MM-DD_HH-mm-ss",
)}.json`;

const messages: OllamaMessage[] = [
  {
    role: "system",
    content: systemPrompt,
  },
];

const warmUpModel = (model: string): Promise<void> =>
  axios
    .post(`${ollamaEndpoint}/api/chat`, {
      model,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          // Some chat templates raise an error if there's no user turn at
          // all (e.g. "No user query found in messages."), so the warm-up
          // ping needs a minimal one even though we don't care about the
          // answer.
          role: "user",
          content: "Hola",
        },
      ],
      options: {
        temperature: 0.7,
        num_predict: 1,
      },
      think: false,
      stream: false,
      tools: ollamaEnableTools ? llmTools : undefined,
      keep_alive: -1,
    })
    .then((response) => {
      console.log("Ollama keep-alive response:", response.data);
    })
    .catch((err) => {
      console.error("Error initializing Ollama model:", err.message);
      throw err;
    });

if (llmServer.trim().toLowerCase() === "ollama") {
  // initialize request to ollama server with empty prompt, to load the model into memory
  warmUpModel(currentOllamaModel).catch(() => {});
}

// Exposed for the voice-command flow (see chat-flow/voice-commands.ts and
// chat-flow/model-select-mode.ts) so it can read/switch the active model
// without going through LLM tool-calling (which would attach every tool
// schema to every request — far too slow on this hardware, see
// docs/llm-model-selection.md).
export const getCurrentModel = (): string => currentOllamaModel;

// Switches the active model and waits for Ollama to actually load it into
// memory. Ollama has no real progress API for this (only for pulls/
// downloads), so the caller shows an indeterminate "Preparando modelo"
// instead of a fake percentage — see chat-flow/model-select-mode.ts and
// docs/display-ui.md. Used by both direct voice-alias switches and the
// button-driven model menu, so any model change goes through the same wait.
export const switchModel = async (model: string): Promise<void> => {
  if (model !== currentOllamaModel) {
    console.log(`[Ollama] Switching model: ${currentOllamaModel} -> ${model}`);
    currentOllamaModel = model;
    ollamaContextWindowCache = undefined;
    persistEnvVar("OLLAMA_MODEL", model);
  }
  await warmUpModel(model);
};

export const listOllamaModelsWithSize = async (): Promise<
  { name: string; size: number }[]
> => {
  const response = await axios.get(`${ollamaEndpoint}/api/tags`);
  const models = response.data?.models;
  return Array.isArray(models)
    ? models
        .map((m: any) => ({ name: m?.name || m?.model, size: Number(m?.size) || 0 }))
        .filter((m: { name: string }) => Boolean(m.name))
    : [];
};

export const listOllamaModels = async (): Promise<string[]> =>
  (await listOllamaModelsWithSize()).map((m) => m.name);

const resetChatHistory = (): void => {
  messages.length = 0;
  messages.push({
    role: "system",
    content: systemPrompt,
  });
};

type ToolLoopState = {
  round: number;
  signatures: Set<string>;
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const toolCallSignature = (call: OllamaFunctionCall): string =>
  `${call.function?.name || ""}:${stableStringify(call.function?.arguments || {})}`;

const previousToolResultFor = (toolName: string): string => {
  const previous = [...messages]
    .reverse()
    .find((message) => message.role === "tool" && message.tool_name === toolName);
  return previous?.content || "";
};

const answerFromAvailableToolResults = async ({
  instruction,
  partialCallback,
  endResolve,
  endCallback,
  partialThinkingCallback,
}: {
  instruction: string;
  partialCallback: (partialAnswer: string) => void;
  endResolve: () => void;
  endCallback: () => void;
  partialThinkingCallback?: (partialThinking: string) => void;
}): Promise<void> => {
  let finalAnswer = "";
  let finalThinking = "";
  try {
    const response = await axios.post(
      `${ollamaEndpoint}/api/chat`,
      {
        model: currentOllamaModel,
        messages: [
          ...messages.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
          {
            role: "user",
            content: instruction,
          },
        ],
        think: enableThinking,
        stream: true,
        options: {
          temperature: 0.7,
          num_predict: ollamaPredictNum,
        },
        keep_alive: -1,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        responseType: "stream",
      },
    );

    await new Promise<void>((resolve) => {
      response.data.on("data", (chunk: Buffer) => {
        const dataLines = chunk
          .toString()
          .split("\n")
          .filter((line) => line.trim() !== "");

        for (const line of dataLines) {
          try {
            const parsedData = JSON.parse(line);
            if (parsedData.message?.content) {
              const content = parsedData.message.content;
              partialCallback(content);
              finalAnswer += content;
            }
            if (parsedData.message?.thinking) {
              const thinking = parsedData.message.thinking;
              partialThinkingCallback?.(thinking);
              finalThinking += thinking;
            }
          } catch (error) {
            console.error("Error parsing final answer data:", error, line);
          }
        }
      });
      response.data.on("end", resolve);
      response.data.on("error", (error: Error) => {
        console.error("Error streaming final answer:", error.message);
        resolve();
      });
    });

    if (finalThinking.trim()) {
      console.log(`[Ollama] Final no-tools thinking length: ${finalThinking.length}`);
    }
    messages.push({
      role: "assistant",
      content: finalAnswer,
    });
  } catch (error: any) {
    console.error("Error generating final answer from tool results:", error.message);
  } finally {
    endResolve();
    endCallback();
  }
};

const chatWithLLMStreamInternal = async (
  inputMessages: Message[] = [],
  partialCallback: (partialAnswer: string) => void,
  endCallback: () => void,
  partialThinkingCallback?: (partialThinking: string) => void,
  invokeFunctionCallback?: (functionName: string, result?: string) => void,
  toolLoopState: ToolLoopState = { round: 0, signatures: new Set<string>() },
): Promise<void> => {
  if (shouldResetChatHistory()) {
    resetChatHistory();
  }
  updateLastMessageTime();
  messages.push(...(inputMessages as OllamaMessage[]));
  await compactMessagesForContextWindow({
    provider: "ollama",
    model: currentOllamaModel,
    messages,
    tools: ollamaEnableTools ? llmTools : undefined,
    outputReserveTokens: ollamaPredictNum,
    contextWindowResolver: resolveOllamaContextWindow,
    invokeFunctionCallback,
  });
  let endResolve: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    endResolve = resolve;
  }).finally(() => {
    // save chat history to file
    fs.writeFileSync(
      path.join(chatHistoryDir, chatHistoryFileName),
      JSON.stringify(messages, null, 2),
    );
  });
  let partialAnswer = "";
  let partialThinking = "";
  const functionCallsPackages: OllamaFunctionCall[][] = [];

  try {
    const lastUserMessageIndex = messages
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => msg.role === "user")
      .map(({ index }) => index)
      .pop();
    const capturedImagePath =
      useCapturedImageInChat &&
      lastUserMessageIndex !== undefined &&
      hasPendingCapturedImgForChat()
        ? consumePendingCapturedImgForChat()
        : "";
    const capturedImageBase64 = capturedImagePath
      ? fs.readFileSync(capturedImagePath).toString("base64")
      : "";

    const response = await axios.post(
      `${ollamaEndpoint}/api/chat`,
      {
        model: currentOllamaModel,
        messages: messages.map((msg, index) => ({
          role: msg.role,
          content: msg.content,
          ...(capturedImageBase64 &&
          msg.role === "user" &&
          lastUserMessageIndex !== undefined &&
          index === lastUserMessageIndex
            ? { images: [capturedImageBase64] }
            : {}),
        })),
        think: enableThinking,
        stream: true,
        options: {
          temperature: 0.7,
          num_predict: ollamaPredictNum,
        },
        tools: ollamaEnableTools ? llmTools : undefined,
        keep_alive: -1,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        responseType: "stream",
      },
    );

    response.data.on("data", (chunk: Buffer) => {
      const data = chunk.toString();
      const dataLines = data.split("\n");
      const filteredLines = dataLines.filter((line) => line.trim() !== "");

      for (const line of filteredLines) {
        try {
          const parsedData = JSON.parse(line);

          // Handle content from Ollama
          if (parsedData.message?.content) {
            const content = parsedData.message.content;
            partialCallback(content);
            partialAnswer += content;
          }

          // Handle thinking from Ollama
          if (parsedData.message?.thinking) {
            const thinking = parsedData.message.thinking;
            partialThinkingCallback?.(thinking);
            partialThinking += thinking;
          }

          // Handle tool calls from Ollama
          if (parsedData.message?.tool_calls) {
            // tool_calls format: [[{"function":{"index":0,"name":"setVolume","arguments":{"percent":50}}}]]
            functionCallsPackages.push(parsedData.message.tool_calls);
          }
        } catch (error) {
          console.error("Error parsing data:", error, line);
        }
      }
    });

    response.data.on("end", async () => {
      console.log("Stream ended");
      const functionCalls = functionCallsPackages.flat().map((call, index) => ({
        id: `call_${Date.now()}_${Math.random()}_${index}`,
        type: "function",
        function: call.function,
      }));
      console.log(
        "functionCallsPackages: ",
        JSON.stringify(functionCallsPackages),
      );
      console.log("functionCalls: ", JSON.stringify(functionCalls));
      messages.push({
        role: "assistant",
        content: partialAnswer,
        tool_calls: functionCallsPackages as any,
      });

      if (!isEmpty(functionCalls)) {
        if (toolLoopState.round >= ollamaMaxToolRounds) {
          console.warn(`[ToolLoop] Reached OLLAMA_MAX_TOOL_ROUNDS=${ollamaMaxToolRounds}.`);
          await answerFromAvailableToolResults({
            instruction:
              "You have already checked enough tool results for this request. Answer the user's latest request now using the available conversation and tool results. Do not call or ask for another tool. Do not mention internal tool instructions, raw status markers such as [success], exit_code, duration_ms, timed_out, truncated, or phrases like previous tool result.",
            partialCallback,
            endResolve,
            endCallback,
            partialThinkingCallback,
          });
          return;
        }

        const duplicateCall = functionCalls.find((call) =>
          toolLoopState.signatures.has(toolCallSignature(call)),
        );
        if (duplicateCall) {
          const signature = toolCallSignature(duplicateCall);
          const name = duplicateCall.function?.name || "tool";
          const previous = previousToolResultFor(name);
          console.warn(`[ToolLoop] Repeated tool call blocked: ${signature}`);
          await answerFromAvailableToolResults({
            instruction: [
              `The ${name} tool was already called for this request, so do not call it again.`,
              "Answer the user's latest request now using the available result below.",
              "Do not mention internal tool instructions, raw status markers such as [success], exit_code, duration_ms, timed_out, truncated, or phrases like previous tool result.",
              previous ? `\nAvailable ${name} result:\n${previous}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            partialCallback,
            endResolve,
            endCallback,
            partialThinkingCallback,
          });
          return;
        }

        for (const call of functionCalls) {
          toolLoopState.signatures.add(toolCallSignature(call));
        }

        const results = await Promise.all(
          functionCalls.map(async (call: OllamaFunctionCall) => {
            const {
              function: { arguments: args, name },
            } = call;
            const func = llmFuncMap[name! as string];
            if (func) {
              invokeFunctionCallback?.(name! as string);
              return [
                name,
                await func(args)
                  .then((res) => {
                    invokeFunctionCallback?.(name! as string, res);
                    return res;
                  })
                  .catch((err) => {
                    console.error(`Error executing function ${name}:`, err);
                    return `Error executing function ${name}: ${err.message}`;
                  }),
              ];
            } else {
              console.error(`Function ${name} not found`);
              return [name, `Function ${name} not found`];
            }
          }),
        );

        const newMessages: OllamaMessage[] = results.map(
          ([name, result]: any) => ({
            role: "tool",
            content: result as string,
            tool_name: name as string,
          }),
        );

        // Directly extract and return the tool result if available
        const describeMessage = newMessages.find((msg) =>
          msg.content.startsWith(ToolReturnTag.Response),
        );
        const responseContent = extractToolResponse(
          describeMessage?.content || "",
        );
        if (responseContent) {
          console.log(
            `[LLM] Tool response starts with "[response]", return it directly.`,
          );
          newMessages.push({
            role: "assistant",
            content: responseContent,
          });
          // append responseContent in chunks
          await stimulateStreamResponse({
            content: responseContent,
            partialCallback,
            endResolve,
            endCallback,
          });
          return;
        }

        await chatWithLLMStreamInternal(
          newMessages as Message[],
          partialCallback,
          () => {
            endResolve();
            endCallback();
          },
          partialThinkingCallback,
          invokeFunctionCallback,
          {
            round: toolLoopState.round + 1,
            signatures: toolLoopState.signatures,
          },
        );
        return;
      } else {
        endResolve();
        endCallback();
      }
    });
  } catch (error: any) {
    console.error("Error:", error.message);
    endResolve();
    endCallback();
  }

  return promise;
};

const chatWithLLMStream: ChatWithLLMStreamFunction = async (
  inputMessages: Message[] = [],
  partialCallback: (partialAnswer: string) => void,
  endCallback: () => void,
  partialThinkingCallback?: (partialThinking: string) => void,
  invokeFunctionCallback?: (functionName: string, result?: string) => void,
): Promise<void> =>
  chatWithLLMStreamInternal(
    inputMessages,
    partialCallback,
    endCallback,
    partialThinkingCallback,
    invokeFunctionCallback,
  );

const summaryTextWithLLM: SummaryTextWithLLMFunction = async (
  text: string, promptPrefix: string
): Promise<string> => {
  const prompt = `${promptPrefix}\n\n${text}\n\n`;

  const response = await axios.post(
    `${ollamaEndpoint}/api/generate`,
    {
      model: currentOllamaModel,
      prompt: prompt,
      stream: false,
      think: false,
    }
  );

  if (response.data && response.data.response) {
    const summary = response.data.response;
    console.log("Ollama summary:", summary);
    return summary;
  } else {
    console.log("No summary returned from Ollama.");
    return "";
  }
}

export default { chatWithLLMStream, resetChatHistory, summaryTextWithLLM };
