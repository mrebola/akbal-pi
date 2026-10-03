import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatStore } from "./store";

const newDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "chat-store-"));
// updatedAt has millisecond resolution; a short pause keeps ordering deterministic.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

test("create writes nothing until a message is appended", () => {
  const dir = newDir();
  const store = new ChatStore(dir);
  const chat = store.create("qwen");
  assert.equal(fs.readdirSync(dir).length, 0);
  assert.equal(store.get(chat.id), null);
});

test("appendMessage persists and bumps updatedAt", () => {
  const dir = newDir();
  const store = new ChatStore(dir);
  const chat = store.createWithMessage("qwen", "user", "hola");
  const before = chat.updatedAt;
  const after = store.appendMessage(chat.id, "assistant", "qué tal");
  assert.equal(after?.messages.length, 2);
  assert.equal(after?.messages[1].content, "qué tal");
  assert.ok(after!.updatedAt >= before);
  assert.equal(new ChatStore(dir).get(chat.id)?.messages.length, 2);
});

test("list puts pinned chats first, then newest first", async () => {
  const dir = newDir();
  const store = new ChatStore(dir);
  const a = store.createWithMessage("m", "user", "a");
  await tick();
  const b = store.createWithMessage("m", "user", "b");
  await tick();
  const c = store.createWithMessage("m", "user", "c");
  store.update(a.id, { pinned: true });
  const ids = store.list().map((m) => m.id);
  assert.equal(ids[0], a.id);
  assert.equal(ids.indexOf(c.id) < ids.indexOf(b.id), true);
});

test("a corrupt file is skipped, the rest still list", () => {
  const dir = newDir();
  const store = new ChatStore(dir);
  const good = store.createWithMessage("m", "user", "ok");
  const bad = store.createWithMessage("m", "user", "x");
  fs.writeFileSync(path.join(dir, `${bad.id}.json`), "{\"id\": \"trunca");
  const ids = store.list().map((m) => m.id);
  assert.deepEqual(ids, [good.id]);
});

test("invalid ids are rejected and never touch the filesystem", () => {
  const dir = newDir();
  const store = new ChatStore(dir);
  assert.equal(store.isValidId("../../etc/passwd"), false);
  assert.equal(store.get("../../etc/passwd"), null);
  assert.equal(store.delete("../../etc/passwd"), false);
});

test("appendMessage to a deleted chat does not recreate it", () => {
  const dir = newDir();
  const store = new ChatStore(dir);
  const chat = store.createWithMessage("m", "user", "hola");
  assert.equal(store.delete(chat.id), true);
  assert.equal(store.appendMessage(chat.id, "assistant", "tarde"), null);
  assert.equal(fs.existsSync(path.join(dir, `${chat.id}.json`)), false);
});

test("removeLastUserMessage drops an orphan user turn", () => {
  const dir = newDir();
  const store = new ChatStore(dir);
  const chat = store.createWithMessage("m", "user", "sin respuesta");
  store.removeLastUserMessage(chat.id);
  assert.equal(store.get(chat.id)?.messages.length, 0);
});

test("update changes title, pinned and model, and returns null for unknown ids", () => {
  const dir = newDir();
  const store = new ChatStore(dir);
  const chat = store.createWithMessage("m1", "user", "x");
  const updated = store.update(chat.id, { title: "Nuevo", pinned: true, model: "m2", titleEdited: true });
  assert.equal(updated?.title, "Nuevo");
  assert.equal(updated?.pinned, true);
  assert.equal(updated?.model, "m2");
  assert.equal(updated?.titleEdited, true);
  assert.equal(store.update("00000000-0000-4000-8000-000000000000", { pinned: true }), null);
});
