# Historial de chats persistente — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guardar cada conversación del chat web del admin en la Pi, con reanudar, nuevo chat, fijar, renombrar, eliminar con confirmación, y modelo por chat.

**Architecture:** Un archivo JSON por chat en `app/data/chat_history/web/`, leído y escrito por un módulo `ChatStore` sin dependencias de Koa ni de Ollama (testeable). Las funciones de Ollama (cargar modelo, generar título, leer ventana de contexto) viven aparte. Las rutas REST se registran desde un archivo nuevo que `web-admin-server.ts` llama. `POST /api/chat` acepta `chatId` y, cuando lo recibe, arma el contexto desde disco en vez de confiar en el arreglo que manda el navegador. La UI de lista es un archivo nuevo `web/admin/chat-history.js`; `app.js` solo se modifica donde hoy maneja el historial en memoria.

**Tech Stack:** TypeScript (ES2020, CommonJS, strict), Koa + @koa/router + koa-bodyparser, axios, Node 20 `node:test` para las pruebas unitarias, JS vanilla en el admin.

**Spec:** `docs/superpowers/specs/2026-10-03-chat-history-design.md`

## Decisiones que se apartan del spec

Estas cambian algo del spec. Hay que aprobarlas antes de implementar.

1. **Carga de modelo sin `/api/models/select`.** Ese endpoint llama a `switchModel()`, que cambia el modelo de voz (`currentOllamaModel`, `OLLAMA_MODEL` en `.env`). El chat web se diseñó independiente de voz (`app.js:360-368`). Cambio: `loadChatModel(model)` llama `unloadModel()` (descarga todo lo residente, por el incidente de RAM en `docs/llm-model-selection.md`) y luego precarga el modelo del chat con `keep_alive: -1`, sin tocar `currentOllamaModel`. Efecto secundario: el modelo de voz también se descarga y se recarga la próxima vez que se use voz.
2. **Carpeta `data/chat_history/web/`**, no `data/chat_history/` directo. Gemini, Volcengine y MiniMax ya escriben ahí archivos `*_chat_history_*.json`, y listar esa carpeta los mezclaría.
3. **Sin `POST /api/chats`.** El spec pide crear un chat vacío y, a la vez, no escribir a disco hasta el primer mensaje. Eso no se puede cumplir a la vez. Se crea el chat en el primer `POST /api/chat` (con `chatId: null`) y el servidor devuelve el id en el primer frame del stream.
4. **El modelo de un chat existente lo manda el servidor.** Si llega `model` en `POST /api/chat` para un chat existente, se ignora y se usa `chat.model`. Cambiar de modelo es explícito: `PATCH` + `POST /api/chat-models/load`. Así no hay carreras entre el `<select>` y el stream.
5. **Campo `titleEdited`** además de los del spec. Lo necesita la regla "una vez renombrado, ya no se regenera".
6. **El título se genera antes de cerrar el stream**, con tiempo límite de 15 s. Así el cliente lo recibe en un frame `chat_title` sin polling. Si falla o pasa el límite, queda el título de respaldo.
7. **Riesgo a confirmar:** `src/utils/dir.ts` borra `data/` completo si `cleanDataFolderOnStart` está activo. Con eso activo, los chats se pierden al arrancar. Antes de publicar la función hay que revisar cuándo se activa y documentarlo.

## Global Constraints

- TypeScript ES2020, CommonJS, `strict`. Imports relativos dentro de `src/`.
- Archivos kebab-case, clases PascalCase.
- Comentarios de código en inglés, solo cuando explican el "por qué". Strings de UI en español.
- Nada hardcodeado de entorno. La carpeta de datos sale de `dataDir` en `src/utils/dir.ts`.
- Sin secretos ni IPs reales en commits (AGENTS.md, checklist anti-secretos).
- Cada tarea termina con `npx tsc --noEmit` en `app/` sin errores.
- Pruebas unitarias con `node:test`: `npm run build` compila a `dist/`, y luego `node --test dist/chat-history/`.

## Review Focus

1. **Modelo del chat no instalado.** Un chat cuyo modelo ya no existe debe quedar en solo lectura y no tumbar `GET /api/chats` ni `GET /api/chats/:id`. Test: `store.test.ts` (lectura aunque el modelo no exista) y verificación en la Pi.
2. **Mensaje más grande que la ventana de contexto.** Un mensaje del usuario que no cabe no debe dejar el arreglo vacío ni quitar el mensaje nuevo. Test: `context.test.ts`.
3. **Chat borrado mientras responde.** `DELETE` durante un stream no debe crear el archivo de nuevo al terminar la respuesta. Test: `store.test.ts` (`appendMessage` a un id borrado devuelve error) y verificación en la Pi.
4. **Archivo JSON corrupto o a medias.** Un archivo inválido se omite en la lista y no rompe las demás. Test: `store.test.ts`.
5. **Id inválido o con ruta.** Un `chatId` como `../../algo` no debe salir de la carpeta. Test: `store.test.ts`.

---

## File Structure

**Create:**
- `app/src/chat-history/types.ts` — tipos compartidos (`ChatMeta`, `StoredMessage`, `StoredChat`).
- `app/src/chat-history/store.ts` — `ChatStore`: CRUD sobre JSON, escritura atómica, validación de id.
- `app/src/chat-history/store.test.ts` — pruebas de `ChatStore`.
- `app/src/chat-history/context.ts` — `estimateTokens`, `trimToWindow`.
- `app/src/chat-history/context.test.ts` — pruebas de recorte.
- `app/src/chat-history/title.ts` — `fallbackTitle`.
- `app/src/chat-history/title.test.ts` — pruebas de título de respaldo.
- `app/src/chat-history/ollama.ts` — `loadChatModel`, `getContextWindow`, `generateTitle`, `loadStats`.
- `app/src/device/chat-history-routes.ts` — `registerChatHistoryRoutes(router)`.
- `app/web/admin/chat-history.js` — lista lateral, menú, confirmación, nuevo chat.

**Modify:**
- `app/src/device/web-admin-server.ts` — llamar `registerChatHistoryRoutes(router)`; cambiar el handler de `POST /api/chat` (líneas ~1001-1145).
- `app/web/admin/index.html` — markup de la lista en `#tab-chat`; `<script src="chat-history.js">` antes de `app.js` (línea ~771).
- `app/web/admin/app.js` — `sendMessage` (línea ~622), `modelSelect` change (línea ~388), `loadModels` (línea ~360).
- `app/web/admin/styles.css` — estilos de la lista, al final del bloque de chat (después de línea ~3234).
- `app/web/admin/i18n/es.json` y `en.json` — claves nuevas (ver Task 8).

---

### Task 1: Tipos y `ChatStore` (persistencia)

**Files:**
- Create: `app/src/chat-history/types.ts`
- Create: `app/src/chat-history/store.ts`
- Test: `app/src/chat-history/store.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `ChatStore` con `list(): ChatMeta[]`, `get(id): StoredChat | null`, `create(model): StoredChat`, `appendMessage(id, role, content): StoredChat | null`, `removeLastUserMessage(id): void`, `update(id, patch): StoredChat | null`, `delete(id): boolean`, `isValidId(id): boolean`. Tipos `ChatMeta`, `StoredMessage`, `StoredChat`.

- [ ] **Step 1: Escribir los tipos**

`app/src/chat-history/types.ts`:

```ts
export type ChatRole = "user" | "assistant" | "system";

export interface StoredMessage {
  role: ChatRole;
  content: string;
}

export interface ChatMeta {
  id: string;
  title: string;
  model: string;
  pinned: boolean;
  // True once the user renames the chat; stops automatic title generation.
  titleEdited: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredChat extends ChatMeta {
  messages: StoredMessage[];
}

export type ChatPatch = Partial<Pick<ChatMeta, "title" | "pinned" | "model" | "titleEdited">>;
```

- [ ] **Step 2: Escribir la prueba que falla**

`app/src/chat-history/store.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatStore } from "./store";

const newDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "chat-store-"));

test("create writes nothing until a message is appended", () => {
  const dir = newDir();
  const store = new ChatStore(dir);
  const chat = store.create("qwen");
  assert.equal(fs.readdirSync(dir).length, 0);
  assert.equal(store.get(chat.id)?.messages.length, 0);
});

test("appendMessage persists and bumps updatedAt", () => {
  const dir = newDir();
  const store = new ChatStore(dir);
  const chat = store.create("qwen");
  const before = chat.updatedAt;
  store.appendMessage(chat.id, "user", "hola");
  const after = store.appendMessage(chat.id, "assistant", "qué tal");
  assert.equal(after?.messages.length, 2);
  assert.equal(after?.messages[1].content, "qué tal");
  assert.ok(after!.updatedAt >= before);
  assert.equal(new ChatStore(dir).get(chat.id)?.messages.length, 2);
});

test("list puts pinned chats first, then newest first", () => {
  const dir = newDir();
  const store = new ChatStore(dir);
  const a = store.create("m");
  const b = store.create("m");
  const c = store.create("m");
  store.appendMessage(a.id, "user", "a");
  store.appendMessage(b.id, "user", "b");
  store.appendMessage(c.id, "user", "c");
  store.update(a.id, { pinned: true });
  const ids = store.list().map((m) => m.id);
  assert.equal(ids[0], a.id);
  assert.equal(ids.indexOf(c.id) < ids.indexOf(b.id), true);
});

test("a corrupt file is skipped, the rest still list", () => {
  const dir = newDir();
  const store = new ChatStore(dir);
  const good = store.create("m");
  store.appendMessage(good.id, "user", "ok");
  const bad = store.create("m");
  store.appendMessage(bad.id, "user", "x");
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
  const chat = store.create("m");
  store.appendMessage(chat.id, "user", "hola");
  assert.equal(store.delete(chat.id), true);
  assert.equal(store.appendMessage(chat.id, "assistant", "tarde"), null);
  assert.equal(fs.existsSync(path.join(dir, `${chat.id}.json`)), false);
});

test("removeLastUserMessage drops an orphan user turn", () => {
  const dir = newDir();
  const store = new ChatStore(dir);
  const chat = store.create("m");
  store.appendMessage(chat.id, "user", "sin respuesta");
  store.removeLastUserMessage(chat.id);
  assert.equal(store.get(chat.id)?.messages.length, 0);
});

test("update changes title, pinned and model, and returns null for unknown ids", () => {
  const dir = newDir();
  const store = new ChatStore(dir);
  const chat = store.create("m1");
  store.appendMessage(chat.id, "user", "x");
  const updated = store.update(chat.id, { title: "Nuevo", pinned: true, model: "m2", titleEdited: true });
  assert.equal(updated?.title, "Nuevo");
  assert.equal(updated?.pinned, true);
  assert.equal(updated?.model, "m2");
  assert.equal(updated?.titleEdited, true);
  assert.equal(store.update("00000000-0000-4000-8000-000000000000", { pinned: true }), null);
});
```

- [ ] **Step 3: Ejecutar la prueba y verificar que falla**

Run (desde `app/`): `npm run build` — fallará con `Cannot find module './store'`. Eso confirma que la prueba depende de la implementación que falta.

- [ ] **Step 4: Implementar `ChatStore`**

`app/src/chat-history/store.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { ChatMeta, ChatPatch, ChatRole, StoredChat, StoredMessage } from "./types";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Keeps one JSON file per chat. Writes go to a .tmp file and are renamed
// into place, so a power cut mid-save leaves the previous version intact
// (the Pi runs on a PiSugar battery; see docs/SETUP.md).
export class ChatStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  isValidId(id: string): boolean {
    return typeof id === "string" && ID_PATTERN.test(id);
  }

  list(): ChatMeta[] {
    const metas: ChatMeta[] = [];
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      const chat = this.readFile(file.slice(0, -".json".length));
      if (chat) metas.push(stripMessages(chat));
    }
    return metas.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  get(id: string): StoredChat | null {
    if (!this.isValidId(id)) return null;
    return this.readFile(id);
  }

  create(model: string): StoredChat {
    const now = new Date().toISOString();
    // Not written yet: a chat only reaches disk with its first message.
    return {
      id: crypto.randomUUID(),
      title: "Chat nuevo",
      model,
      pinned: false,
      titleEdited: false,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  appendMessage(id: string, role: ChatRole, content: string): StoredChat | null {
    const chat = this.get(id);
    if (!chat) return null;
    chat.messages.push({ role, content });
    chat.updatedAt = new Date().toISOString();
    this.writeFile(chat);
    return chat;
  }

  removeLastUserMessage(id: string): void {
    const chat = this.get(id);
    if (!chat) return;
    const last: StoredMessage | undefined = chat.messages[chat.messages.length - 1];
    if (last?.role !== "user") return;
    chat.messages.pop();
    this.writeFile(chat);
  }

  update(id: string, patch: ChatPatch): StoredChat | null {
    const chat = this.get(id);
    if (!chat) return null;
    Object.assign(chat, patch);
    this.writeFile(chat);
    return chat;
  }

  delete(id: string): boolean {
    if (!this.isValidId(id)) return false;
    const file = this.filePath(id);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private readFile(id: string): StoredChat | null {
    if (!this.isValidId(id)) return null;
    const file = this.filePath(id);
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed?.id !== id || !Array.isArray(parsed.messages)) {
        throw new Error("shape mismatch");
      }
      return parsed as StoredChat;
    } catch (err: any) {
      console.warn(`[ChatStore] skipping unreadable chat ${id}: ${err?.message || err}`);
      return null;
    }
  }

  private writeFile(chat: StoredChat): void {
    const file = this.filePath(chat.id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(chat, null, 2));
    fs.renameSync(tmp, file);
  }
}

const stripMessages = (chat: StoredChat): ChatMeta => {
  const { messages: _messages, ...meta } = chat;
  return meta;
};
```

**Nota de implementación:** `appendMessage` a un id borrado devuelve `null` porque `get` no encuentra el archivo y no lo crea. Eso cubre el Review Focus 3.

- [ ] **Step 5: Ejecutar las pruebas y verificar que pasan**

Run (desde `app/`): `npm run build && node --test dist/chat-history/store.test.js`
Expected: 8 tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/chat-history/types.ts app/src/chat-history/store.ts app/src/chat-history/store.test.ts
git commit -m "feat(chat-history): ChatStore con escritura atómica y validación de id"
```

---

### Task 2: Recorte de contexto

**Files:**
- Create: `app/src/chat-history/context.ts`
- Test: `app/src/chat-history/context.test.ts`

**Interfaces:**
- Consumes: `StoredMessage` de `types.ts`.
- Produces: `estimateTokens(text: string): number`, `trimToWindow(messages: StoredMessage[], budgetTokens: number): StoredMessage[]`.

- [ ] **Step 1: Escribir la prueba que falla**

`app/src/chat-history/context.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, trimToWindow } from "./context";

test("estimateTokens is about 4 characters per token, rounded up", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("trimToWindow keeps the newest turns that fit and preserves order", () => {
  const msgs = [
    { role: "user" as const, content: "a".repeat(40) },      // 10 tokens
    { role: "assistant" as const, content: "b".repeat(40) },  // 10 tokens
    { role: "user" as const, content: "c".repeat(40) },      // 10 tokens
  ];
  const out = trimToWindow(msgs, 25);
  assert.deepEqual(out.map((m) => m.content[0]), ["b", "c"]);
});

test("system messages are always kept and do not count against the turn budget", () => {
  const msgs = [
    { role: "system" as const, content: "s".repeat(400) },   // 100 tokens, still kept
    { role: "user" as const, content: "a".repeat(40) },
    { role: "assistant" as const, content: "b".repeat(40) },
  ];
  const out = trimToWindow(msgs, 10);
  assert.equal(out[0].role, "system");
  assert.equal(out.length, 2);
  assert.equal(out[1].content[0], "b");
});

test("the newest user message is kept even when it alone exceeds the budget", () => {
  const msgs = [
    { role: "user" as const, content: "a".repeat(40) },
    { role: "user" as const, content: "z".repeat(4000) },    // 1000 tokens
  ];
  const out = trimToWindow(msgs, 50);
  assert.equal(out.length, 1);
  assert.equal(out[0].content[0], "z");
});
```

- [ ] **Step 2: Ejecutar la prueba y verificar que falla**

Run (desde `app/`): `npm run build` — falla con `Cannot find module './context'`.

- [ ] **Step 3: Implementar**

`app/src/chat-history/context.ts`:

```ts
import { StoredMessage } from "./types";

// Rough on purpose: an exact tokenizer would mean loading one more thing
// on an 8GB Pi. Off by a bit either way is fine, the window only has to
// avoid overflowing the model's context.
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

// System messages always go in (persona + RAG). Turns are then added from
// newest to oldest until the budget is spent, so the model sees the most
// recent exchange. The newest user message is never dropped, even if it
// alone is over budget; a single huge paste should fail visibly, not
// silently answer a previous question.
export const trimToWindow = (messages: StoredMessage[], budgetTokens: number): StoredMessage[] => {
  const system = messages.filter((m) => m.role === "system");
  const turns = messages.filter((m) => m.role !== "system");
  const systemCost = system.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  let remaining = budgetTokens - systemCost;

  const kept: StoredMessage[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = estimateTokens(turns[i].content);
    const mustKeep = kept.length === 0 && turns[i].role === "user";
    if (cost > remaining && !mustKeep) break;
    kept.unshift(turns[i]);
    remaining -= cost;
  }

  // Put system messages back at the front, keeping their original order.
  return [...system, ...kept];
};
```

**Nota:** el `break` corta al primer mensaje que no cabe, así no se saltean turnos y el contexto queda continuo.

- [ ] **Step 4: Ejecutar las pruebas**

Run: `npm run build && node --test dist/chat-history/context.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/chat-history/context.ts app/src/chat-history/context.test.ts
git commit -m "feat(chat-history): recorte de contexto por presupuesto de tokens"
```

---

### Task 3: Título de respaldo

**Files:**
- Create: `app/src/chat-history/title.ts`
- Test: `app/src/chat-history/title.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `fallbackTitle(text: string): string`.

- [ ] **Step 1: Escribir la prueba que falla**

`app/src/chat-history/title.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackTitle } from "./title";

test("uses the first six words, whitespace collapsed", () => {
  assert.equal(
    fallbackTitle("  cómo   funciona nmap  con   una  red grande y lenta  "),
    "cómo funciona nmap con una red",
  );
});

test("caps length at 60 characters even with long words", () => {
  const out = fallbackTitle("a".repeat(200));
  assert.equal(out.length, 60);
});

test("empty input falls back to a neutral label", () => {
  assert.equal(fallbackTitle("   "), "Chat nuevo");
});
```

- [ ] **Step 2: Ejecutar la prueba y verificar que falla**

Run: `npm run build` — falla con `Cannot find module './title'`.

- [ ] **Step 3: Implementar**

`app/src/chat-history/title.ts`:

```ts
const MAX_WORDS = 6;
const MAX_CHARS = 60;

export const fallbackTitle = (text: string): string => {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  if (words.length === 0) return "Chat nuevo";
  return words.join(" ").slice(0, MAX_CHARS);
};
```

- [ ] **Step 4: Ejecutar las pruebas**

Run: `npm run build && node --test dist/chat-history/title.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/chat-history/title.ts app/src/chat-history/title.test.ts
git commit -m "feat(chat-history): título de respaldo a partir del primer mensaje"
```

---

### Task 4: Funciones de Ollama para chats

Sin pruebas unitarias: dependen de Ollama. Se validan con `tsc` y en la Pi (Task 9).

**Files:**
- Create: `app/src/chat-history/ollama.ts`

**Interfaces:**
- Consumes: `ollamaEndpoint` y `unloadModel` de `cloud-api/local/ollama-llm.ts`.
- Produces:
  - `loadChatModel(model: string): Promise<{ durationMs: number }>`
  - `getContextWindow(model: string): Promise<number | undefined>`
  - `generateTitle(model: string, firstUserMessage: string, firstAssistantMessage: string, timeoutMs?: number): Promise<string | null>`
  - `loadStats: Record<string, number>` (última duración de carga por modelo, en ms)

- [ ] **Step 1: Implementar**

`app/src/chat-history/ollama.ts`:

```ts
import axios from "axios";
import { ollamaEndpoint, unloadModel } from "../cloud-api/local/ollama-llm";

// Last observed load time per model, so the UI can show a real estimate
// in the "switch model" warning instead of a made-up number.
export const loadStats: Record<string, number> = {};

// Unloads everything first (see unloadModel in ollama-llm.ts for the RAM
// incident), then warms only the chat's model with keep_alive -1. Does NOT
// call switchModel(): the web chat must not change the voice model.
export const loadChatModel = async (model: string): Promise<{ durationMs: number }> => {
  const started = Date.now();
  await unloadModel();
  await axios.post(`${ollamaEndpoint}/api/chat`, {
    model,
    messages: [],
    keep_alive: -1,
  });
  const durationMs = Date.now() - started;
  loadStats[model] = durationMs;
  return { durationMs };
};

// Mirrors resolveOllamaContextWindow but takes the model explicitly.
// Returns undefined when Ollama does not report a window; the caller then
// uses a conservative default.
export const getContextWindow = async (model: string): Promise<number | undefined> => {
  const response = await axios.post(`${ollamaEndpoint}/api/show`, { model });
  const info = response.data?.model_info || {};
  for (const [key, value] of Object.entries(info)) {
    if (/context_length$/i.test(key) && Number(value) > 0) return Number(value);
  }
  return undefined;
};

// Short, non-thinking, non-streaming call. The chat's model is already
// resident (we just answered with it), so this adds no load.
export const generateTitle = async (
  model: string,
  firstUserMessage: string,
  firstAssistantMessage: string,
  timeoutMs = 15000,
): Promise<string | null> => {
  const prompt =
    "Resume esta conversación en un título de máximo 6 palabras, en español, " +
    "sin comillas ni punto final. Responde solo con el título.\n\n" +
    `Usuario: ${firstUserMessage.slice(0, 500)}\n` +
    `Asistente: ${firstAssistantMessage.slice(0, 500)}`;
  try {
    const response = await axios.post(
      `${ollamaEndpoint}/api/chat`,
      {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: false,
        options: { temperature: 0.3, num_predict: 24 },
        keep_alive: -1,
      },
      { timeout: timeoutMs },
    );
    const raw: string = response.data?.message?.content || "";
    const cleaned = raw.replace(/["'«»]/g, "").replace(/[.\s]+$/, "").trim();
    return cleaned || null;
  } catch (err: any) {
    console.warn(`[ChatHistory] title generation failed: ${err?.message || err}`);
    return null;
  }
};
```

**Nota:** `getContextWindow` busca la clave `*.context_length` en `model_info`, igual que `findContextWindowValue` del código existente. Si cambia el formato de Ollama, la función devuelve `undefined` y el llamador usa un valor por defecto.

- [ ] **Step 2: Verificar compilación**

Run (desde `app/`): `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git add app/src/chat-history/ollama.ts
git commit -m "feat(chat-history): carga de modelo por chat, ventana de contexto y título con Ollama"
```

---

### Task 5: Rutas REST de chats

**Files:**
- Create: `app/src/device/chat-history-routes.ts`
- Modify: `app/src/device/web-admin-server.ts` (dentro de `registerRoutes`, cerca de `/api/models/unload`, línea ~901)

**Interfaces:**
- Consumes: `ChatStore`, `loadChatModel`, `getContextWindow`, `loadStats`, `chatHistoryDir` de `utils/dir.ts`.
- Produces: `registerChatHistoryRoutes(router: Router): void` y la instancia `chatStore` exportada para que `POST /api/chat` la use.

- [ ] **Step 1: Implementar el módulo de rutas**

`app/src/device/chat-history-routes.ts`:

```ts
import path from "path";
import Router from "@koa/router";
import { ChatStore } from "../chat-history/store";
import { loadChatModel, loadStats } from "../chat-history/ollama";
import { chatHistoryDir } from "../utils/dir";

// Own subfolder: Gemini/Volcengine/MiniMax already write *_chat_history_*.json
// into chatHistoryDir, and listing that folder would pick them up.
export const chatStore = new ChatStore(path.join(chatHistoryDir, "web"));

export const registerChatHistoryRoutes = (router: Router): void => {
  router.get("/api/chats", (ctx) => {
    ctx.body = chatStore.list();
  });

  router.get("/api/chats/:id", (ctx) => {
    const chat = chatStore.get(ctx.params.id);
    if (!chat) {
      ctx.status = 404;
      ctx.body = { error: "chat no encontrado" };
      return;
    }
    ctx.body = chat;
  });

  router.patch("/api/chats/:id", (ctx) => {
    const body = (ctx.request.body as any) || {};
    const patch: Record<string, unknown> = {};
    if (typeof body.title === "string") {
      const title = body.title.trim().slice(0, 80);
      if (!title) {
        ctx.status = 400;
        ctx.body = { error: "el título no puede estar vacío" };
        return;
      }
      patch.title = title;
      patch.titleEdited = true;
    }
    if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
    // Model changes go through here, but the actual load is a separate
    // call (POST /api/chat-models/load) so the UI can show the warning.
    if (typeof body.model === "string" && body.model) patch.model = body.model;

    const updated = chatStore.update(ctx.params.id, patch);
    if (!updated) {
      ctx.status = 404;
      ctx.body = { error: "chat no encontrado" };
      return;
    }
    ctx.body = updated;
  });

  router.delete("/api/chats/:id", (ctx) => {
    if (!chatStore.delete(ctx.params.id)) {
      ctx.status = 404;
      ctx.body = { error: "chat no encontrado" };
      return;
    }
    ctx.body = { ok: true };
  });

  router.post("/api/chat-models/load", async (ctx) => {
    const model = (ctx.request.body as any)?.model;
    if (!model || typeof model !== "string") {
      ctx.status = 400;
      ctx.body = { error: "model requerido" };
      return;
    }
    try {
      const { durationMs } = await loadChatModel(model);
      ctx.body = { ok: true, model, durationMs };
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { ok: false, error: err?.message || String(err) };
    }
  });

  // Lets the UI show "tardó ~N s la última vez" before the user confirms.
  router.get("/api/chat-models/stats", (ctx) => {
    ctx.body = loadStats;
  });
};
```

- [ ] **Step 2: Registrar las rutas**

En `app/src/device/web-admin-server.ts`, agregar el import junto a los demás imports de `device/`:

```ts
import { registerChatHistoryRoutes } from "./chat-history-routes";
```

Y dentro de `registerRoutes(router)`, justo antes de `router.get("/api/models", ...)` (línea ~865):

```ts
    registerChatHistoryRoutes(router);
```

- [ ] **Step 3: Verificar compilación**

Run (desde `app/`): `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add app/src/device/chat-history-routes.ts app/src/device/web-admin-server.ts
git commit -m "feat(web-admin): rutas REST para listar, leer, renombrar, fijar y borrar chats"
```

---

### Task 6: `POST /api/chat` guarda la conversación

**Files:**
- Modify: `app/src/device/web-admin-server.ts` (handler `router.post("/api/chat", ...)`, líneas ~1001-1145)

**Interfaces:**
- Consumes: `chatStore`, `trimToWindow`, `estimateTokens`, `fallbackTitle`, `generateTitle`, `getContextWindow`.
- Produces: el contrato de stream NDJSON suma dos frames nuevos: `{ chat: { id, title, model } }` al principio (solo cuando se crea el chat) y `{ chat_title: { id, title } }` antes de cerrar el stream.

**Contrato del request:**
- Nuevo: `{ chatId: string | null, message: string }`. Si `chatId` es `null`, se crea el chat con `model` del body.
- Compatibilidad: si llega `messages` sin `chatId`, se sigue el camino viejo sin persistencia. Así no se rompe a quien use el endpoint directo.

- [ ] **Step 1: Agregar imports**

En `web-admin-server.ts`, junto a los imports de chat-history:

```ts
import { chatStore, registerChatHistoryRoutes } from "./chat-history-routes";
import { trimToWindow, estimateTokens } from "../chat-history/context";
import { fallbackTitle } from "../chat-history/title";
import { generateTitle, getContextWindow } from "../chat-history/ollama";
```

Y cambiar el import de la línea 1 de esta tarea para que use solo `registerChatHistoryRoutes` (el `chatStore` ya viene de ese módulo). Ajustar el import de la Task 5 para que quede `import { chatStore, registerChatHistoryRoutes } from "./chat-history-routes";` una sola vez.

- [ ] **Step 2: Reemplazar el inicio del handler**

Reemplazar desde `router.post("/api/chat", async (ctx) => {` hasta el bloque del system prompt (`messages.unshift(...)`, línea ~1021) por:

```ts
    router.post("/api/chat", async (ctx) => {
      const body = ctx.request.body as any;
      const requestedModel = typeof body?.model === "string" && body.model ? body.model : WEB_ADMIN_DEFAULT_MODEL;

      // Persisted path: the server builds the context from disk. The
      // browser only sends the new message. For an existing chat the
      // stored model wins, so a stale <select> can't switch models here.
      const chatId: string | null = typeof body?.chatId === "string" ? body.chatId : null;
      const newMessage: string = typeof body?.message === "string" ? body.message.trim() : "";
      const persisted = chatId !== null || typeof body?.message === "string";

      let chat = null as ReturnType<typeof chatStore.get>;
      if (persisted) {
        if (!newMessage) {
          ctx.status = 400;
          ctx.body = { error: "message requerido" };
          return;
        }
        if (chatId !== null) {
          chat = chatStore.get(chatId);
          if (!chat) {
            ctx.status = 404;
            ctx.body = { error: "chat no encontrado" };
            return;
          }
        } else {
          chat = chatStore.create(requestedModel) as any;
        }
        chatStore.appendMessage(chat!.id, "user", newMessage);
      }

      const model = chat ? chat.model : requestedModel;

      // Legacy direct-API path: the client sends the whole history.
      const messages: AdminChatMessage[] = chat
        ? []
        : Array.isArray(body?.messages) ? body.messages : [];
      if (!chat && messages.length === 0) {
        ctx.status = 400;
        ctx.body = { error: "messages requerido" };
        return;
      }
      if (chat) {
        const stored = chatStore.get(chat.id)!;
        messages.push(...stored.messages.map((m) => ({ role: m.role, content: m.content })));
      }
```

- [ ] **Step 3: Recortar a la ventana de contexto**

Justo después del bloque de RAG (el `try { ... RAG ... }` que termina antes de `const abortController`), insertar:

```ts
      if (chat) {
        // Budget = model window minus room for the reply. Falls back to a
        // conservative 4096 when Ollama doesn't report a window.
        const windowTokens = (await getContextWindow(model).catch(() => undefined)) ?? 4096;
        const replyReserve = Math.min(MAX_PREDICT_TOKENS, Math.floor(windowTokens / 4));
        const trimmed = trimToWindow(messages as any, windowTokens - replyReserve);
        messages.splice(0, messages.length, ...(trimmed as AdminChatMessage[]));
      }
```

Nota: `MAX_PREDICT_TOKENS` se define antes en el mismo handler/closure (línea ~985). Si no está en alcance en ese punto, moverlo arriba del handler.

- [ ] **Step 4: Guardar el resultado y el título**

1. Antes de `await runAdminChatToolLoop(...)`, si `chat` existe y el stream aún no arrancó, escribir el frame del chat nuevo en el primer `startStreaming()`. Cambiar `onUpstream` así:

```ts
          onUpstream: (stream) => {
            const wasStreaming = streaming;
            startStreaming();
            if (!wasStreaming && chat && isNewChat) {
              writeFrame({ chat: { id: chat.id, title: chat.title, model: chat.model } });
            }
            upstream = stream;
          },
```

Declarar `const isNewChat = chatId === null && persisted;` antes del handler de stream.

2. Acumular la respuesta en `fullText`: `onContent` ya escribe frames; agregar un acumulador:

```ts
      let assistantText = "";
      // ...
          onContent: (text) => {
            assistantText += text;
            writeFrame({ message: { content: text } });
          },
```

Nota: `onContent` recibe fragmentos, por eso se concatena. Esto asume que `onContent` recibe solo texto visible; revisar `admin-chat-tool-loop.ts` antes de implementar para confirmar que no mezcla "thinking" en el mismo callback.

3. Al final del handler, reemplazar el bloque de cierre:

```ts
      cleanupListeners();
      if (chat && assistantText) {
        chatStore.appendMessage(chat.id, "assistant", assistantText);
      }
      if (chat && streaming && !abortController.signal.aborted) {
        const stored = chatStore.get(chat.id);
        if (stored && !stored.titleEdited && stored.title === "Chat nuevo" && stored.messages.length === 2) {
          const generated = await generateTitle(model, newMessage, assistantText);
          const title = generated || fallbackTitle(newMessage);
          chatStore.update(chat.id, { title });
          writeFrame({ chat_title: { id: chat.id, title } });
        }
      }
      if (streaming) ctx.res.end();
```

4. En el `catch`, si el error ocurre antes de `streaming` (502), revertir el mensaje del usuario:

```ts
        if (!streaming) {
          cleanupListeners();
          if (chat) chatStore.removeLastUserMessage(chat.id);
          ctx.status = 502;
          ctx.body = { error: err?.message || String(err) };
          return;
        }
```

- [ ] **Step 5: Verificar compilación**

Run (desde `app/`): `npx tsc --noEmit`
Expected: sin errores. Si `AdminChatMessage` no acepta el tipo de `StoredMessage`, ajustar el mapeo, no el tipo de `AdminChatMessage`.

- [ ] **Step 6: Commit**

```bash
git add app/src/device/web-admin-server.ts
git commit -m "feat(web-admin): POST /api/chat persiste la conversación y genera el título"
```

---

### Task 7: Lista lateral y markup

**Files:**
- Create: `app/web/admin/chat-history.js`
- Modify: `app/web/admin/index.html` (dentro de `#tab-chat`, línea ~30; script antes de `app.js`, línea ~771)
- Modify: `app/web/admin/styles.css` (después de línea ~3234)

**Interfaces:**
- Consumes: endpoints de Task 5 y `apiFetch` / `fetch` existentes.
- Produces (globales en `window`): `ChatHistory.init()`, `ChatHistory.refresh()`, `ChatHistory.setActive(id)`, `ChatHistory.onOpen` (callback que app.js asigna).

- [ ] **Step 1: Markup**

En `index.html`, dentro de `<section id="tab-chat">`, envolver el contenido actual en un layout de dos columnas:

```html
    <section id="tab-chat" class="tab-panel active">
      <div class="chat-layout">
        <aside class="chat-sidebar" aria-label="Chats">
          <button type="button" id="chat-new" class="chat-new-btn">+ Nuevo chat</button>
          <div id="chat-list" class="chat-list"></div>
        </aside>
        <div class="chat-main">
          <!-- contenido actual: chat-toolbar, chat-empty, chat-log, chat-form -->
        </div>
      </div>
    </section>
```

Y antes de `<script src="app.js">`:

```html
  <script src="chat-history.js"></script>
```

- [ ] **Step 2: Módulo de lista**

`app/web/admin/chat-history.js`:

```js
// Sidebar for the web chat: pinned, recents, new chat, per-chat menu,
// delete with confirmation. Talks to /api/chats; app.js owns the messages
// and the send flow. Kept separate so app.js doesn't grow further.
(function () {
  const list = document.getElementById("chat-list");
  const newBtn = document.getElementById("chat-new");
  let activeId = null;
  let metas = [];

  // Storage-free: this module keeps no state the server doesn't have.
  async function api(path, options) {
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function relativeDate(iso) {
    const diffMs = Date.now() - Date.parse(iso);
    const min = Math.round(diffMs / 60000);
    if (min < 1) return "ahora";
    if (min < 60) return `hace ${min} min`;
    const hours = Math.round(min / 60);
    if (hours < 24) return `hace ${hours} h`;
    return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
  }

  function row(meta) {
    const el = document.createElement("div");
    el.className = `chat-row${meta.id === activeId ? " active" : ""}`;
    el.dataset.id = meta.id;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "chat-row-main";
    main.addEventListener("click", () => ChatHistory.onOpen && ChatHistory.onOpen(meta.id));

    const title = document.createElement("span");
    title.className = "chat-row-title";
    title.textContent = meta.title;

    const sub = document.createElement("span");
    sub.className = "chat-row-sub";
    const chip = document.createElement("span");
    chip.className = "chat-row-model";
    chip.textContent = meta.model;
    sub.append(chip, document.createTextNode(` · ${relativeDate(meta.updatedAt)}`));

    main.append(title, sub);

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "chat-row-menu";
    menuBtn.setAttribute("aria-label", "Opciones del chat");
    menuBtn.textContent = "⋯";
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openMenu(meta, el);
    });

    el.append(main, menuBtn);
    return el;
  }

  function render() {
    list.innerHTML = "";
    const pinned = metas.filter((m) => m.pinned);
    const recent = metas.filter((m) => !m.pinned);
    if (pinned.length) list.append(section("Fijados", pinned));
    if (recent.length) list.append(section("Recientes", recent));
    if (!metas.length) {
      const empty = document.createElement("div");
      empty.className = "chat-list-empty";
      empty.textContent = "Todavía no hay chats guardados.";
      list.append(empty);
    }
  }

  function section(label, items) {
    const wrap = document.createElement("div");
    wrap.className = "chat-section";
    const head = document.createElement("div");
    head.className = "chat-section-label";
    head.textContent = label;
    wrap.append(head, ...items.map(row));
    return wrap;
  }

  // Single shared menu; closed on any outside click.
  let menu = null;
  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
  }
  document.addEventListener("click", closeMenu);

  function openMenu(meta, anchor) {
    closeMenu();
    menu = document.createElement("div");
    menu.className = "chat-menu";
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.append(
      item(meta.pinned ? "Desfijar" : "Fijar", () => togglePin(meta)),
      item("Renombrar", () => rename(meta)),
      item("Eliminar", () => confirmDelete(meta), true),
    );
    anchor.append(menu);
  }

  function item(label, onClick, danger) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (danger) b.className = "danger";
    b.addEventListener("click", () => {
      closeMenu();
      onClick();
    });
    return b;
  }

  async function togglePin(meta) {
    await api(`/api/chats/${meta.id}`, jsonPatch({ pinned: !meta.pinned }));
    await refresh();
  }

  async function rename(meta) {
    const next = window.prompt("Nuevo nombre del chat", meta.title);
    if (next === null) return;
    if (!next.trim()) return;
    await api(`/api/chats/${meta.id}`, jsonPatch({ title: next }));
    await refresh();
  }

  function confirmDelete(meta) {
    const dialog = document.getElementById("chat-delete-dialog");
    dialog.querySelector(".chat-delete-title").textContent = meta.title;
    dialog.hidden = false;
    dialog.onconfirm = async () => {
      dialog.hidden = true;
      await api(`/api/chats/${meta.id}`, { method: "DELETE" });
      const wasActive = meta.id === activeId;
      if (wasActive) ChatHistory.onDeleted && ChatHistory.onDeleted(meta.id);
      await refresh();
    };
  }

  function jsonPatch(body) {
    return {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  async function refresh() {
    try {
      metas = await api("/api/chats");
      render();
    } catch {
      list.textContent = "No se pudo cargar la lista de chats.";
    }
  }

  window.ChatHistory = {
    onOpen: null,
    onDeleted: null,
    refresh,
    setActive(id) {
      activeId = id;
      render();
    },
    init() {
      newBtn.addEventListener("click", () => ChatHistory.onNew && ChatHistory.onNew());
      refresh();
    },
  };
})();
```

**Nota:** `window.prompt` y `confirm` son diálogos nativos. La guía de Chrome en el sistema pide evitarlos solo para automatización; en la UI normal son aceptables, pero el diálogo de borrado usa un `<dialog>` propio para mostrar el título y dar un botón rojo.

- [ ] **Step 3: Diálogo de confirmación**

En `index.html`, antes de `</main>` o junto al `<script>`:

```html
  <div id="chat-delete-dialog" class="chat-confirm" hidden role="dialog" aria-modal="true">
    <div class="chat-confirm-box">
      <p>¿Eliminar el chat <strong class="chat-delete-title"></strong>?</p>
      <p class="cfg-hint">Se borra del disco y no se puede recuperar.</p>
      <div class="chat-confirm-actions">
        <button type="button" class="secondary" id="chat-delete-cancel">Cancelar</button>
        <button type="button" class="danger" id="chat-delete-ok">Eliminar</button>
      </div>
    </div>
  </div>
```

En `chat-history.js`, al final de `init()`, conectar los botones del diálogo:

```js
      document.getElementById("chat-delete-cancel").addEventListener("click", () => {
        document.getElementById("chat-delete-dialog").hidden = true;
      });
      document.getElementById("chat-delete-ok").addEventListener("click", () => {
        const dialog = document.getElementById("chat-delete-dialog");
        if (dialog.onconfirm) dialog.onconfirm();
      });
```

- [ ] **Step 3b: Confirmación genérica (para cambio de modelo)**

Decisión del spec: el cambio de modelo usa el mismo diálogo propio que el
borrado, no `confirm()` nativo. Este helper sirve para ambos casos.

Agregar en `index.html`, junto al diálogo de borrado:

```html
  <div id="chat-confirm-dialog" class="chat-confirm" hidden role="dialog" aria-modal="true">
    <div class="chat-confirm-box">
      <p class="chat-confirm-title"></p>
      <p class="cfg-hint chat-confirm-body"></p>
      <div class="chat-confirm-actions">
        <button type="button" class="secondary" id="chat-confirm-cancel">Cancelar</button>
        <button type="button" id="chat-confirm-ok">Continuar</button>
      </div>
    </div>
  </div>
```

Agregar en `chat-history.js`, dentro del objeto `window.ChatHistory`:

```js
    // Resolves true only when the user presses the OK button.
    confirm({ title, body, ok = "Continuar" }) {
      const dialog = document.getElementById("chat-confirm-dialog");
      dialog.querySelector(".chat-confirm-title").textContent = title;
      dialog.querySelector(".chat-confirm-body").textContent = body;
      document.getElementById("chat-confirm-ok").textContent = ok;
      dialog.hidden = false;
      return new Promise((resolve) => {
        const finish = (value) => {
          dialog.hidden = true;
          document.getElementById("chat-confirm-ok").onclick = null;
          document.getElementById("chat-confirm-cancel").onclick = null;
          resolve(value);
        };
        document.getElementById("chat-confirm-ok").onclick = () => finish(true);
        document.getElementById("chat-confirm-cancel").onclick = () => finish(false);
      });
    },
```

- [ ] **Step 4: Estilos**

Agregar al final del bloque de chat en `styles.css` (después de `.chat-model-dot`):

```css
.chat-layout { display: flex; gap: 12px; flex: 1; min-height: 0; }
.chat-main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.chat-sidebar { width: 220px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
.chat-new-btn { width: 100%; }
.chat-section-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); margin: 8px 0 4px; }
.chat-row { position: relative; display: flex; align-items: center; border-radius: 6px; }
.chat-row.active { background: rgba(80,255,120,0.08); }
.chat-row-main { flex: 1; min-width: 0; text-align: left; background: none; border: 0; padding: 6px; color: inherit; cursor: pointer; }
.chat-row-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-row-sub { display: block; font-size: 11px; color: var(--text-secondary); }
.chat-row-model { font-family: monospace; }
.chat-row-menu { background: none; border: 0; color: var(--text-secondary); cursor: pointer; padding: 4px 6px; }
.chat-menu { position: absolute; right: 0; top: 100%; z-index: 20; display: flex; flex-direction: column; min-width: 140px; background: var(--surface, #111); border: 1px solid var(--border, #333); border-radius: 6px; }
.chat-menu button { background: none; border: 0; text-align: left; padding: 8px 10px; color: inherit; cursor: pointer; }
.chat-menu button.danger { color: #ff6b6b; }
.chat-list-empty { font-size: 12px; color: var(--text-secondary); }
.chat-confirm { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 50; }
.chat-confirm[hidden] { display: none; }
.chat-confirm-box { background: var(--surface, #111); border: 1px solid var(--border, #333); border-radius: 8px; padding: 16px; max-width: 360px; }
.chat-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 720px) {
  .chat-layout { flex-direction: column; }
  .chat-sidebar { width: 100%; max-height: 40vh; }
}
```

Nota: las variables `--surface` y `--border` tienen fallback; confirmar en `styles.css` los nombres reales de los tokens de color antes de implementar, y cambiar los fallbacks por los reales.

- [ ] **Step 5: Verificación manual**

Sin Pi no hay prueba real. Revisar en el navegador local con `node` sirviendo `web/admin` o en la Pi (Task 9). Verificar en ancho de teléfono (16px de margen, sin scroll horizontal, según la guía de artifacts y del admin).

- [ ] **Step 6: Commit**

```bash
git add app/web/admin/chat-history.js app/web/admin/index.html app/web/admin/styles.css
git commit -m "feat(web-admin): lista de chats con fijados, recientes, menú y confirmación de borrado"
```

---

### Task 8: Integración en `app.js`

**Files:**
- Modify: `app/web/admin/app.js` (`loadModels` línea ~360, `modelSelect` change línea ~388, `sendMessage` línea ~622, y el botón de cancelar sin cambios)
- Modify: `app/web/admin/i18n/es.json` y `en.json` (claves nuevas)

**Interfaces:**
- Consumes: `ChatHistory` (Task 7), endpoints de Tasks 5-6.
- Produces: `activeChatId`, `openChat(id)`, `newChat()`, y el flujo de cambio de modelo con confirmación.

- [ ] **Step 1: Estado activo y nuevo chat**

Reemplazar `let history = [];` (línea 37) por:

```js
// Server is the source of truth now (see chat-history.js). `activeChatId`
// is null until the first message creates a chat on the server.
let activeChatId = null;
```

Y agregar después de `sendMessage`:

```js
function resetChatView() {
  activeChatId = null;
  chatLog.innerHTML = "";
  document.getElementById("chat-empty").classList.remove("hidden");
  ChatHistory.setActive(null);
}

function newChat() {
  if (sending) return;
  resetChatView();
}

async function openChat(id) {
  if (sending) return;
  const res = await fetch(`/api/chats/${id}`);
  if (!res.ok) {
    addMessage("system", "No se pudo abrir el chat.");
    return;
  }
  const chat = await res.json();
  activeChatId = chat.id;
  chatLog.innerHTML = "";
  document.getElementById("chat-empty").classList.add("hidden");
  for (const m of chat.messages) {
    const el = addMessage(m.role === "assistant" ? "assistant" : "user", m.content);
    if (m.role === "assistant") el.innerHTML = renderMarkdown(m.content);
  }
  ChatHistory.setActive(chat.id);
  await ensureModelFor(chat);
}

ChatHistory.onOpen = openChat;
ChatHistory.onNew = newChat;
ChatHistory.onDeleted = (id) => { if (id === activeChatId) resetChatView(); };
```

**Nota:** `addMessage` devuelve el elemento (ver línea ~161). Si el mensaje del asistente se muestra con `addMessage(...)`, el texto va como `textContent`; por eso se reemplaza con `renderMarkdown` después, igual que en `sendMessage`.

- [ ] **Step 2: Cambio de modelo con aviso**

Agregar en `app.js`:

```js
// Opening a chat whose model is not the one loaded: warn with the last
// measured load time, then unload-and-load only after the user says yes.
async function ensureModelFor(chat) {
  if (modelSelect.value === chat.model) return;
  modelSelect.value = chat.model;
  const exists = [...modelSelect.options].some((o) => o.value === chat.model);
  if (!exists) {
    addMessage("system", `El modelo ${chat.model} ya no está instalado. El chat queda en solo lectura hasta reinstalarlo o elegir otro.`);
    setSendingUi(true);
    chatInput.disabled = true;
    return;
  }
  const stats = await fetch("/api/chat-models/stats").then((r) => r.json()).catch(() => ({}));
  const last = stats[chat.model];
  const hint = last ? `La última carga tardó unos ${Math.round(last / 1000)} s.` : "La primera carga puede tardar bastante en la Pi.";
  const ok = await ChatHistory.confirm({
    title: `Cambiar a ${chat.model}`,
    body: `Este chat usa ${chat.model}. Se descargará el modelo actual y se cargará ese. ${hint}`,
    ok: "Cambiar modelo",
  });
  if (!ok) {
    addMessage("system", `Sigue activo ${modelSelect.value}. Para usar ${chat.model} en este chat, abrilo de nuevo y confirmá.`);
    return;
  }
  await loadChatModelWithUi(chat);
}

async function loadChatModelWithUi(chat) {
  addMessage("system", `Cargando ${chat.model}…`);
  chatInput.disabled = true;
  try {
    const res = await fetch("/api/chat-models/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: chat.model }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    addMessage("system", `Listo: ${chat.model}`);
  } catch (err) {
    addMessage("system", `No se pudo cargar ${chat.model}: ${err.message}`);
  } finally {
    chatInput.disabled = false;
  }
}
```

**Nota:** la confirmación usa `ChatHistory.confirm()` de Task 7 (Step 3b), el mismo estilo que el borrado. Ya no hay `window.confirm`.

- [ ] **Step 3: Selector de modelo**

Reemplazar el listener de `modelSelect` change (líneas ~388-393) por:

```js
modelSelect.addEventListener("change", async () => {
  if (!activeChatId) {
    // Nothing persisted yet: the choice applies to the next chat created.
    addMessage("system", `El próximo chat usará ${modelSelect.value}`);
    return;
  }
  const newModel = modelSelect.value;
  const ok = await ChatHistory.confirm({
    title: `Cambiar a ${newModel}`,
    body: "Se descargará el modelo actual y se cargará ese. Este chat usará el nuevo modelo desde ahora.",
    ok: "Cambiar modelo",
  });
  if (!ok) {
    // Put the select back to the chat's model.
    const chat = await fetch(`/api/chats/${activeChatId}`).then((r) => r.json());
    modelSelect.value = chat.model;
    return;
  }
  await fetch(`/api/chats/${activeChatId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: newModel }),
  });
  await loadChatModelWithUi({ model: newModel });
  ChatHistory.refresh();
});
```

Eliminar la línea `history = [];` que existía aquí.

- [ ] **Step 4: `sendMessage` por `chatId`**

Reemplazar `sendMessage` (línea ~622) por la versión que manda solo el mensaje nuevo y actualiza el id y el título cuando llegan frames:

```js
async function sendMessage(text) {
  addMessage("user", text);
  const assistantEl = addMessage("assistant", "");
  const controller = new AbortController();
  activeController = controller;
  setSendingUi(true);
  resetToolChips();
  let fullText = "";
  let hasStartedTalking = false;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: activeChatId, message: text, model: modelSelect.value }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      throw new Error(errText || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.chat) {
            activeChatId = chunk.chat.id;
            ChatHistory.setActive(activeChatId);
          }
          if (chunk.chat_title) {
            ChatHistory.refresh();
          }
          if (chunk.message?.content) {
            if (!hasStartedTalking) {
              hasStartedTalking = true;
              setAvatarTalking(true);
            }
            fullText += chunk.message.content;
            assistantEl.innerHTML = renderMarkdown(fullText);
            chatLog.scrollTop = chatLog.scrollHeight;
          }
          if (chunk.admin_tool_call) {
            const { name, title, status } = chunk.admin_tool_call;
            upsertToolChip(name, title, status);
          }
          if (chunk.admin_links) {
            addLinkRow(chunk.admin_links);
          }
        } catch {
          // ignore a partial/malformed line
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      assistantEl.innerHTML = renderMarkdown(fullText ? `${fullText}\n\n(cancelado)` : "(cancelado)");
    } else {
      assistantEl.textContent = `(error: ${err.message})`;
      assistantEl.classList.add("system");
    }
  } finally {
    activeController = null;
    setSendingUi(false);
    setAvatarTalking(false);
    finishToolRow();
    ChatHistory.refresh();
  }
}
```

**Nota:** se elimina el `history.push` del final. El servidor guarda la respuesta parcial cuando el cliente cancela, así que el cliente ya no mantiene estado. Esto también evita que una recarga pierda la conversación.

- [ ] **Step 5: Inicializar la lista al arrancar**

En el arranque de `app.js`, donde se llama `loadModels()`, agregar después:

```js
ChatHistory.init();
```

- [ ] **Step 6: Claves de i18n**

Agregar a `es.json` y `en.json` las claves que usa la UI nueva. Hoy la lista usa strings literales en español igual que el resto del módulo nuevo; si se quiere i18n completo, reemplazar los strings de `chat-history.js` por `data-i18n` o `t()`. Es decisión de alcance: el spec no lo exige.

- [ ] **Step 7: Verificar sintaxis**

Run (desde `app/`): `node --check web/admin/app.js && node --check web/admin/chat-history.js`
Expected: sin salida (sin errores).

- [ ] **Step 8: Commit**

```bash
git add app/web/admin/app.js app/web/admin/i18n/es.json app/web/admin/i18n/en.json
git commit -m "feat(web-admin): chat web usa chatId y el servidor como fuente de verdad"
```

---

### Task 9: Validación en la Pi

Sin tests automatizados de UI ni de hardware, esta es la validación real. Requiere acceso SSH a la Pi y aviso previo (AGENTS.md, sección de deploy: es hardware en uso).

- [ ] **Step 1: Confirmar acceso antes de tocar nada**

Run: `ssh <usuario>@<host-de-la-pi> echo ok`
Expected: `ok`. Avisar al usuario qué se va a hacer antes de `whisplay update` y `whisplay service restart`.

- [ ] **Step 2: Revisar `cleanDataFolderOnStart`**

Confirmar que la variable está desactivada en el `.env` de la Pi. Si está activa, los chats se borran al reiniciar; decidir antes de publicar.

- [ ] **Step 3: Desplegar**

Run en la Pi: `whisplay update && whisplay service restart`
Expected: build sin errores y servicio arriba.

- [ ] **Step 4: Checklist manual**

1. Crear un chat nuevo, enviar 2 mensajes, recargar la página y reabrirlo. Expected: los mensajes siguen ahí.
2. Verificar que el título se generó (no "Chat nuevo"). Expected: título corto, o el de respaldo si tarda más de 15 s.
3. Fijar el chat. Expected: aparece en "Fijados" arriba.
4. Crear un segundo chat y verificar el orden de "Recientes" (más nuevo arriba).
5. Renombrar un chat. Expected: el nombre cambia y no se regenera aunque se envíen más mensajes.
6. Abrir un chat con otro modelo. Expected: aparece el aviso con tiempo de última carga, y al confirmar se carga el modelo.
7. Cancelar una respuesta a mitad. Expected: al reabrir el chat, la respuesta parcial sigue ahí.
8. Borrar un chat con confirmación. Cancelar primero, después eliminar. Expected: solo se borra al confirmar.
9. Borrar el chat activo durante una respuesta. Expected: la pantalla vuelve a "Nuevo chat" y no reaparece el archivo.
10. Reiniciar el servicio. Expected: los chats siguen en la lista.
11. En una copia, dejar un JSON truncado en `app/data/chat_history/web/`. Expected: la lista sigue cargando y el log muestra la advertencia.
12. Abrir la página en un teléfono. Expected: sin scroll horizontal y con el margen de 16px.
13. En una copia de un chat, cambiar `model` a un nombre que no está instalado y abrirlo. Expected: aviso de modelo no instalado, campo de texto deshabilitado, y la lista sigue funcionando.

- [ ] **Step 5: Revisar RAM durante el cambio de modelo**

Con `htop` o `free -m` en la Pi, verificar que solo queda un modelo cargado después de cambiar de chat (`curl <ollama>/api/ps`). Expected: un solo modelo residente.

---

## Self-Review

**Cobertura del spec:**
- Guardar y reanudar chats: Tasks 1, 6, 8, checklist 1.
- Renombrar, fijar, eliminar con confirmación: Tasks 5, 7, checklist 3, 5, 8.
- Nuevo chat: Task 7 y 8 (`newChat`, `resetChatView`).
- Recientes ordenados y fijados arriba: Task 1 (`list`), Task 7 (`render`), checklist 3-4.
- Modelo por chat y aviso de tiempo: Tasks 4, 5, 8 (`ensureModelFor`), checklist 6.
- Contexto recortado: Task 2, Task 6 paso 3.
- Título generado y de respaldo: Task 3, Task 4, Task 6 paso 4.
- Modelo no instalado en solo lectura: Task 8 (`ensureModelFor`), checklist 6 (parcial; falta probar explícitamente).
- Cancelación guarda parcial: Task 6 paso 4, checklist 7.
- Errores de la tabla del spec: JSON corrupto (Task 1), 502 revierte mensaje (Task 6), título de respaldo (Task 6).

**Consistencia de tipos:**
- `ChatStore.create` devuelve `StoredChat`, y la ruta de Task 6 lo convierte con `as any` solo para la variable `chat`. Revisar al implementar.
- `loadChatModel` devuelve `{ durationMs }` en Task 4 y lo usa Task 5. Coincide.
- `generateTitle(model, user, assistant)` en Task 4 y su llamada en Task 6 paso 4 coinciden.
- `ChatHistory.setActive`, `onOpen`, `onNew`, `onDeleted`, `refresh`, `init` definidos en Task 7 y usados en Task 8. Coinciden.

**Cobertura de Review Focus:**
- 1 (modelo no instalado): `ensureModelFor` en Task 8. Falta prueba automática; queda en checklist 6, que debe incluir un chat con modelo borrado. **Pendiente:** agregar ese caso al checklist de Task 9.
- 2 (mensaje más grande que el contexto): `context.test.ts` último caso.
- 3 (chat borrado durante respuesta): `store.test.ts` caso de `appendMessage` tras `delete`, checklist 9.
- 4 (JSON corrupto): `store.test.ts` caso de archivo corrupto, checklist 11.
- 5 (id con ruta): `store.test.ts` caso de id inválido.

**Huecos conocidos:**
- `onContent` puede mezclar texto de "thinking" si el loop lo emite por el mismo callback. Confirmar en `admin-chat-tool-loop.ts` antes de Task 6.
- `window.confirm` y `prompt` en vez del diálogo propio: decisión de UI a confirmar.
- La carga de modelo en `ensureModelFor` no refresca el `<select>` si el modelo del chat no existe en la lista; ya está cubierto por el caso de modelo no instalado.

---

**Plan complete and saved to `docs/superpowers/plans/2026-10-03-chat-history.md`.** Please review the plan, en especial las 7 decisiones que se apartan del spec. Ya decidimos que la carga de modelo no usa `/api/models/select` porque ese endpoint cambia el modelo de voz.

Which execution approach would you prefer?

- **Subagent-driven**: un subagente nuevo implementa cada tarea y un revisor la valida antes de seguir. Es lo más riguroso, pero cuesta más contexto por tarea y por revisión.
- **Native**: implemento todas las tareas yo en esta sesión y al final un revisor revisa la rama completa. Es más barato y rápido; no hay revisión independiente hasta el final.

Recomiendo **Native**, porque las tareas 1-3 son módulos chicos con interfaces claras y el plan ya trae el código, y el riesgo de un error se concentra en las tareas 6 y 8, que yo puedo revisar con el contexto completo. ¿El plan captura lo que quieres, y qué enfoque usamos?
