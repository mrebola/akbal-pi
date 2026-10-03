import Router from "@koa/router";
import { parseMessage } from "../chat-commands/parse";
import { buildHelp } from "../chat-commands/help";
import { commandRegistry, findCommand } from "../chat-commands/registry";
import { adminFuncMap } from "../config/admin-tools/registry";
import { formatAircraft, formatWifi, formatGnss, formatWardrive, formatSystem, formatGeneric } from "../chat-commands/format";
import { readAircraft, readWifi, readGnss, readWardrive, readSystem } from "../chat-commands/sources";
import { chatStore } from "./chat-history-routes";
import { WEB_ADMIN_DEFAULT_MODEL } from "../cloud-api/local/ollama-llm";

// Runs one command and returns its fixed-text answer. Errors are reported
// as text; a failed read never shows invented numbers.
const runCommand = async (name: string, args: string): Promise<string> => {
  if (name === "estado") {
    try {
      return formatSystem(await readSystem(Date.now()));
    } catch (err: any) {
      return `Error al leer el estado: ${err?.message || err}`;
    }
  }
  const command = findCommand(commandRegistry(), name);
  if (!command) return "Comando no existe. Escribe /help.";
  try {
    switch (command.toolName) {
      case "getNearbyAircraft":
        return formatAircraft(readAircraft(Date.now()));
      case "getWifiRadarStatus":
        return formatWifi(readWifi(args), args);
      case "getGnssStatus":
        return formatGnss(await readGnss());
      case "getWardriveDriveStatus":
        return formatWardrive(readWardrive());
      default: {
        const fn = adminFuncMap[command.toolName];
        if (!fn) return `El comando /${command.alias} no tiene función disponible.`;
        return formatGeneric(await fn({}));
      }
    }
  } catch (err: any) {
    return `Error al leer /${command.alias}: ${err?.message || err}`;
  }
};

// Commands never reach the LLM. The question and its answer are saved to the
// active chat, so the history shows what was asked.
export const registerChatCommandRoutes = (router: Router): void => {
  router.post("/api/commands/run", async (ctx) => {
    const body = (ctx.request.body as any) || {};
    const text = typeof body.text === "string" ? body.text : "";
    const parsed = parseMessage(text);

    let reply: string;
    if (parsed.kind === "help") {
      reply = buildHelp(commandRegistry());
    } else if (parsed.kind === "command") {
      reply = await runCommand(parsed.name, parsed.args);
    } else {
      ctx.status = 400;
      ctx.body = { error: "el mensaje no es un comando" };
      return;
    }

    const chatId: string | null = typeof body.chatId === "string" ? body.chatId : null;
    const chat = chatId
      ? chatStore.appendMessage(chatId, "user", text.trim())
      : chatStore.createWithMessage(WEB_ADMIN_DEFAULT_MODEL, "user", text.trim());
    if (!chat) {
      ctx.status = 404;
      ctx.body = { error: "chat no encontrado" };
      return;
    }
    chatStore.appendMessage(chat.id, "assistant", reply);
    ctx.body = { chatId: chat.id, reply };
  });
};
