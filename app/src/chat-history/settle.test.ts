import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatStore } from "./store";
import { needsAutoTitle, settleExchange } from "./settle";

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
