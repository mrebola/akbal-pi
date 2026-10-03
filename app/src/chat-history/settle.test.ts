import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatStore } from "./store";
import { firstQuestion, needsAutoTitle, needsTitleBeforeReply, settleExchange } from "./settle";

const newStore = (): ChatStore => new ChatStore(fs.mkdtempSync(path.join(os.tmpdir(), "chat-settle-")));

test("a finished reply is saved to the chat", () => {
  const store = newStore();
  const chat = store.createWithMessage("m", "user", "hola");
  const settled = settleExchange(store, chat.id, { assistantText: "qué tal", isNewChat: true });
  assert.equal(settled?.messages.length, 2);
  assert.equal(settled?.messages[1].content, "qué tal");
});

test("a cancelled new chat with no reply is deleted, not left as a stray file", () => {
  const store = newStore();
  const chat = store.createWithMessage("m", "user", "pregunta cancelada");
  const settled = settleExchange(store, chat.id, { assistantText: "", isNewChat: true });
  assert.equal(settled, null);
  assert.equal(store.get(chat.id), null);
  assert.equal(store.list().length, 0);
});

test("an existing chat with no reply drops the orphan user turn and keeps the chat", () => {
  const store = newStore();
  const chat = store.createWithMessage("m", "user", "primera");
  store.appendMessage(chat.id, "assistant", "respuesta");
  store.appendMessage(chat.id, "user", "segunda sin respuesta");
  const settled = settleExchange(store, chat.id, { assistantText: "", isNewChat: false });
  assert.equal(settled?.messages.length, 2);
  assert.equal(settled?.messages[1].role, "assistant");
});

test("a deleted chat is not recreated when a late reply settles", () => {
  const store = newStore();
  const chat = store.createWithMessage("m", "user", "hola");
  store.delete(chat.id);
  assert.equal(settleExchange(store, chat.id, { assistantText: "tarde", isNewChat: false }), null);
  assert.equal(store.get(chat.id), null);
});

test("needsAutoTitle is true only after the first exchange and never after a rename", () => {
  const store = newStore();
  const chat = store.createWithMessage("m", "user", "hola");
  assert.equal(needsAutoTitle(store.appendMessage(chat.id, "assistant", "hola!")), true);
  const renamed = store.update(chat.id, { title: "Mi título", titleEdited: true });
  assert.equal(needsAutoTitle(renamed), false);
  assert.equal(needsAutoTitle(null), false);
  store.appendMessage(chat.id, "user", "segunda");
  assert.equal(needsAutoTitle(store.get(chat.id)), false);
});

test("a brand-new chat gets its title before the reply, once", () => {
  const store = newStore();
  const chat = store.createWithMessage("m", "user", "¿qué es un ataque de BEC?");
  assert.equal(needsTitleBeforeReply(chat), true);
  const titled = store.update(chat.id, { title: "Ataque BEC" });
  assert.equal(needsTitleBeforeReply(titled), false);
});

test("no automatic title is generated after the reply once a title was set before it", () => {
  const store = newStore();
  const chat = store.createWithMessage("m", "user", "pregunta");
  store.update(chat.id, { title: "Título previo" });
  const replied = store.appendMessage(chat.id, "assistant", "respuesta");
  assert.equal(needsAutoTitle(replied), false);
});

test("a chat that started with commands still gets its title from the first real question", () => {
  const store = newStore();
  const chat = store.createWithMessage("m", "user", "/help");
  store.appendMessage(chat.id, "assistant", "Comandos disponibles");
  store.appendMessage(chat.id, "user", "/wifi akbal_lab");
  store.appendMessage(chat.id, "assistant", "akbal_lab · canal 11");
  const withQuestion = store.appendMessage(chat.id, "user", "que wifi tiene mas clientes?");
  assert.equal(needsTitleBeforeReply(withQuestion), true);
  assert.equal(firstQuestion(withQuestion!), "que wifi tiene mas clientes?");
});

test("a command-only chat has no question to title from", () => {
  const store = newStore();
  const chat = store.createWithMessage("m", "user", "/help");
  assert.equal(needsTitleBeforeReply(chat), false);
  assert.equal(firstQuestion(chat), null);
});
