# Arbitraje de memoria: voz del dispositivo vs chat web — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un solo modelo residente a la vez; el chat web toma la memoria al enviar, y una pulsación larga del botón la devuelve a la voz del dispositivo.

**Architecture:** Un módulo puro `memory-arbiter.ts` decide el dueño de la memoria (`device` / `web`) y las transiciones. Un adaptador `model-memory.ts` aplica esas transiciones con Ollama (`unloadModel`, precarga con `keep_alive`). El chat web y la voz piden la memoria al arbitro antes de generar, y el botón del dispositivo lo usa para tomarla de vuelta cancelando la generación en curso.

**Tech Stack:** TypeScript (ES2020, CommonJS, strict), Koa, axios, `node:test`. Pantalla: `chatbot-ui.py` y `states.ts`.

**Spec:** `docs/superpowers/specs/2026-10-03-model-memory-arbitration-design.md`

## Global Constraints

- TypeScript ES2020, CommonJS, `strict`. Imports relativos dentro de `src/`.
- Archivos kebab-case. Comentarios en inglés, solo para el "por qué". Strings de usuario en español (tuteo).
- Cada tarea termina con `npx tsc -p .` sin errores en `app/`, y con `node --test dist/`… de su módulo.
- Nunca `npm run build` en el repo local (registra un daemon). En la Pi sí, con `whisplay update`.
- Pulsación larga: 3 s (propuesta aprobada).
- Recarga del modelo de voz: bajo demanda, nunca en segundo plano.

## Review Focus

1. El chat web envía mientras la voz responde: no debe cargar un segundo modelo, y la voz debe cancelarse antes de descargar.
2. Pulsación larga durante una respuesta web: la respuesta parcial se guarda y la voz responde.
3. Pulsación larga con la voz ya en reposo: no hace nada raro ni descarga el modelo de voz que acaba de cargar.
4. Chat web con una herramienta de admin durante el arbitraje: la herramienta sigue funcionando.
5. Dos envíos casi simultáneos (chat web y botón): solo uno toma la memoria, y el otro espera o se rechaza sin dejar dos modelos cargados.

---

## File Structure

**Create:**
- `app/src/memory/memory-arbiter.ts` — estado y transiciones puras (sin Ollama).
- `app/src/memory/memory-arbiter.test.ts` — pruebas de transiciones.
- `app/src/memory/model-memory.ts` — aplica las transiciones con Ollama.
- `app/src/memory/model-memory.test.ts` — pruebas de la lógica de qué descargar (con dependencias inyectadas, sin red).

**Modify:**
- `app/src/cloud-api/local/ollama-llm.ts` — `warmUpModel` y las peticiones de voz dejan de usar `keep_alive: -1` fijo; ver Task 3.
- `app/src/device/web-admin-server.ts` — `POST /api/chat` pide la memoria al arbitro antes de generar.
- `app/src/core/chat-flow/states.ts` — la pulsación larga cancela la generación web y toma la memoria; el estado de pensar usa el texto y el loop de wardriving.
- `app/python/chatbot-ui.py` — loop THINKING en rojo mientras piensa (ver Task 6).
- `app/src/config/llm-tools.ts` — subconjunto de herramientas de lectura para voz (Task 7).
- `app/src/chat-history/settle.ts`, `app/src/device/web-admin-server.ts` — título antes de responder (Task 8).

---

### Task 1: Arbitro de memoria (puro)

**Files:**
- Create: `app/src/memory/memory-arbiter.ts`
- Test: `app/src/memory/memory-arbiter.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `type Owner = "device" | "web"`; `class MemoryArbiter` con `owner(): Owner`, `requestWeb(): Decision`, `preemptDevice(): Decision`, `release(by: Owner): void`. `Decision = { action: "load" | "none"; cancel: Owner | null; unloadAll: boolean; loadModel: "device" | "web" | null }`.

- [ ] **Step 1: Escribir la prueba que falla**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryArbiter } from "./memory-arbiter";

test("starts owned by the device", () => {
  assert.equal(new MemoryArbiter().owner(), "device");
});

test("a web request takes memory, unloads everything and loads the web model", () => {
  const arb = new MemoryArbiter();
  const d = arb.requestWeb();
  assert.equal(d.unloadAll, true);
  assert.equal(d.loadModel, "web");
  assert.equal(d.cancel, "device");
  assert.equal(arb.owner(), "web");
});

test("a web request while web already owns memory does not reload anything", () => {
  const arb = new MemoryArbiter();
  arb.requestWeb();
  const d = arb.requestWeb();
  assert.equal(d.unloadAll, false);
  assert.equal(d.loadModel, null);
  assert.equal(d.cancel, null);
});

test("a device long press takes memory back from web and cancels the web reply", () => {
  const arb = new MemoryArbiter();
  arb.requestWeb();
  const d = arb.preemptDevice();
  assert.equal(d.cancel, "web");
  assert.equal(d.unloadAll, true);
  assert.equal(d.loadModel, "device");
  assert.equal(arb.owner(), "device");
});

test("a device long press while the device already owns memory is a no-op", () => {
  const arb = new MemoryArbiter();
  const d = arb.preemptDevice();
  assert.equal(d.unloadAll, false);
  assert.equal(d.loadModel, null);
  assert.equal(d.cancel, null);
});

test("release by the non-owner is ignored", () => {
  const arb = new MemoryArbiter();
  arb.requestWeb();
  arb.release("device");
  assert.equal(arb.owner(), "web");
});

test("release by web hands memory back to the device without loading it", () => {
  const arb = new MemoryArbiter();
  arb.requestWeb();
  arb.release("web");
  assert.equal(arb.owner(), "device");
});
```

- [ ] **Step 2: Ejecutar y verificar que falla**

Run (desde `app/`): `npx tsc -p . 2>&1 | head -3` → error `Cannot find module './memory-arbiter'`.

- [ ] **Step 3: Implementar**

```ts
export type Owner = "device" | "web";

export interface Decision {
  // Generation to cancel before the change (the other owner's reply), if any.
  cancel: Owner | null;
  // Unload every resident model before loading the new owner's model.
  unloadAll: boolean;
  // Which owner's model to load now; null when nothing changes.
  loadModel: Owner | null;
}

const NOOP: Decision = { cancel: null, unloadAll: false, loadModel: null };

// Pure: decides who holds the one resident model. Ollama effects live in
// model-memory.ts so this can be tested without a Pi.
export class MemoryArbiter {
  private current: Owner = "device";

  owner(): Owner {
    return this.current;
  }

  requestWeb(): Decision {
    if (this.current === "web") return NOOP;
    const cancel = this.current;
    this.current = "web";
    return { cancel, unloadAll: true, loadModel: "web" };
  }

  preemptDevice(): Decision {
    if (this.current === "device") return NOOP;
    const cancel = this.current;
    this.current = "device";
    return { cancel, unloadAll: true, loadModel: "device" };
  }

  // The web chat finished or went idle: memory goes back to the device on
  // demand (the device reloads its model when it next needs it).
  release(by: Owner): void {
    if (by !== this.current) return;
    this.current = "device";
  }
}
```

- [ ] **Step 4: Ejecutar pruebas**

Run: `npx tsc -p . && node --test dist/memory/memory-arbiter.test.js` → 7 pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/memory/memory-arbiter.ts app/src/memory/memory-arbiter.test.ts
git commit -m "feat(memory): arbitro puro de dueño de memoria entre voz y chat web"
```

---

### Task 2: Adaptador con Ollama

**Files:**
- Create: `app/src/memory/model-memory.ts`
- Test: `app/src/memory/model-memory.test.ts`

**Interfaces:**
- Consumes: `MemoryArbiter`, `Decision` (Task 1); `unloadModel` y `ollamaEndpoint` de `cloud-api/local/ollama-llm.ts`.
- Produces: `applyDecision(d: Decision, models: { device: string; web: string | null }, deps?: Deps): Promise<void>`, donde `Deps = { unloadAll(): Promise<void>; warm(model: string, keepAlive: number): Promise<void> }`.

- [ ] **Step 1: Prueba que falla** — con dependencias falsas:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDecision } from "./model-memory";

const fake = () => {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      unloadAll: async () => { calls.push("unloadAll"); },
      warm: async (m: string, k: number) => { calls.push(`warm:${m}:${k}`); },
    },
  };
};

test("web decision unloads first, then warms only the web model with keep_alive", async () => {
  const f = fake();
  await applyDecision({ cancel: "device", unloadAll: true, loadModel: "web" }, { device: "voz", web: "chat" }, f.deps);
  assert.deepEqual(f.calls, ["unloadAll", "warm:chat:-1"]);
});

test("device decision unloads first, then warms the voice model with keep_alive -1", async () => {
  const f = fake();
  await applyDecision({ cancel: "web", unloadAll: true, loadModel: "device" }, { device: "voz", web: "chat" }, f.deps);
  assert.deepEqual(f.calls, ["unloadAll", "warm:voz:-1"]);
});

test("a no-op decision touches nothing", async () => {
  const f = fake();
  await applyDecision({ cancel: null, unloadAll: false, loadModel: null }, { device: "voz", web: "chat" }, f.deps);
  assert.deepEqual(f.calls, []);
});
```

- [ ] **Step 2: Ejecutar y ver que falla** (módulo inexistente).

- [ ] **Step 3: Implementar**

```ts
import axios from "axios";
import { ollamaEndpoint, unloadModel } from "../cloud-api/local/ollama-llm";
import { Decision, Owner } from "./memory-arbiter";

export interface Deps {
  unloadAll(): Promise<void>;
  warm(model: string, keepAlive: number): Promise<void>;
}

// Real Ollama effects. Only the owner's model is kept resident; the other
// owner's model is loaded on demand the next time it is needed.
export const ollamaDeps: Deps = {
  unloadAll: () => unloadModel(),
  warm: (model, keepAlive) =>
    axios
      .post(`${ollamaEndpoint}/api/chat`, { model, messages: [], keep_alive: keepAlive })
      .then(() => undefined),
};

export const applyDecision = async (
  d: Decision,
  models: { device: string; web: string | null },
  deps: Deps = ollamaDeps,
): Promise<void> => {
  if (d.unloadAll) await deps.unloadAll();
  if (d.loadModel) {
    const target: Owner = d.loadModel;
    const model = target === "web" ? models.web : models.device;
    if (model) await deps.warm(model, -1);
  }
};
```

- [ ] **Step 4: Ejecutar pruebas** → 3 pass.

- [ ] **Step 5: Commit** — `feat(memory): aplica las transiciones del arbitro con Ollama`.

---

### Task 3: Quitar `keep_alive` infinito fijo

**Files:**
- Modify: `app/src/cloud-api/local/ollama-llm.ts` (líneas 142, 418, 554, y `warmUpModel`)

**Interfaces:**
- Consumes: `applyDecision` de Task 2.
- Produces: la voz deja de cargar su modelo al arrancar con `keep_alive: -1` fijo cuando la memoria está en `web`.

- [ ] **Step 1: Cambiar `warmUpModel` para que respete el arbitro**: `warmUpModel` ya no se llama al arrancar si el dueño es `web`. El arranque llama `applyDecision` con la decisión inicial `device`.
- [ ] **Step 2:** Las peticiones de respuesta de voz (`keep_alive: -1` en 418 y 554) se mantienen, porque la voz ya es dueña de la memoria cuando responde. Solo el chat web baja a `keep_alive: -1` mientras tiene el turno.
- [ ] **Step 3: Verificar** `npx tsc -p .` y leer el diff: ningún otro punto que cargue modelos sin pasar por el arbitro (buscar `keep_alive` en `src/` y justificar cada uno en el ledger).
- [ ] **Step 4: Commit** — `refactor(memory): la voz carga su modelo solo cuando es dueña de la memoria`.

---

### Task 4: Chat web pide la memoria antes de generar

**Files:**
- Modify: `app/src/device/web-admin-server.ts` (handler `POST /api/chat`, antes de `runAdminChatToolLoop`)
- Modify: `app/src/core/chat-flow/states.ts` (singleton del arbitro compartido)

**Interfaces:**
- Consumes: `MemoryArbiter` (Task 1), `applyDecision` (Task 2).
- Produces: un arbitro compartido `memoryArbiter` exportado desde `src/memory/shared.ts`.

- [ ] **Step 1:** Crear `src/memory/shared.ts` con `export const memoryArbiter = new MemoryArbiter();`.
- [ ] **Step 2:** En `POST /api/chat`, antes de generar: `const d = memoryArbiter.requestWeb(); if (d.cancel === "device") cancelDeviceReply(); await applyDecision(d, {device: getDeviceModel(), web: model});`. `cancelDeviceReply()` llama al mismo cancelador que usa la voz (Task 5).
- [ ] **Step 3:** Al terminar el turno web (`finishChat`), `memoryArbiter.release("web")` solo si el chat quedó inactivo; la memoria pasa a `device` sin cargarla (bajo demanda).
- [ ] **Step 4: Probar** — `npx tsc -p .` y prueba manual en la Pi (Task 9).
- [ ] **Step 5: Commit** — `feat(web-admin): el chat web toma la memoria del arbitro antes de responder`.

---

### Task 5: Pulsación larga cancela y toma la memoria

**Files:**
- Modify: `app/src/core/chat-flow/states.ts` (estado de respuesta local y su `onButtonPressed`, líneas ~913-967 como patrón de pulsación larga con `longPressMs`)

**Interfaces:**
- Consumes: `memoryArbiter` (Task 4), `applyDecision` (Task 2), `cancelWebReply()` (expuesto por `web-admin-server.ts`).
- Produces: `cancelDeviceReply()` y `cancelWebReply()`, ambos cancelan la generación en curso del dueño actual.

- [ ] **Step 1:** Reusar el patrón de pulsación larga existente (`longPressMs`, 3 s) en el estado de respuesta. Si se mantiene ≥ 3 s: `const d = memoryArbiter.preemptDevice(); if (d.cancel === "web") cancelWebReply(); await applyDecision(d, …)`.
- [ ] **Step 2:** Si la pulsación es corta, el comportamiento actual no cambia.
- [ ] **Step 3:** La pantalla muestra "Preparando modelo…" mientras carga el modelo de voz (texto existente).
- [ ] **Step 4:** Probar en la Pi (Task 9): pulsación larga durante una respuesta web.
- [ ] **Step 5: Commit** — `feat(chat-flow): pulsación larga de 3 s devuelve la memoria a la voz`.

---

### Task 6: Estado "pensando" como en wardriving

**Files:**
- Modify: `app/src/core/chat-flow/states.ts` (línea ~682, estado `thinking`)
- Modify: `app/python/chatbot-ui.py` (loop THINKING en rojo, referencia en línea ~674)

**Interfaces:**
- Consumes: el texto de wardriving "Escaneando redes…" (`wardrive-mode.ts:84`).
- Produces: texto "Escaneando redes…" y color rojo mientras el modelo piensa.

- [ ] **Step 1:** Cambiar el texto de `thinking` a "Escaneando redes..." y el color `RGB` al rojo del wardriving (copiar el valor de `wardrive-mode.ts`, no inventarlo).
- [ ] **Step 2:** Verificar en `chatbot-ui.py` que el loop THINKING se usa para ese estado.
- [ ] **Step 3:** Prueba en la Pi: pedir algo por voz y ver la pantalla.
- [ ] **Step 4: Commit** — `feat(display): estado pensando con el estilo de escaneo de wardriving`.

---

### Task 7: Voz con herramientas de lectura

**Files:**
- Modify: `app/src/config/llm-tools.ts` (subconjunto de lectura)

**Interfaces:**
- Consumes: `adminTools` y su registro (`src/config/admin-tools/registry.ts`).
- Produces: `llmTools` incluye solo las herramientas marcadas como lectura (estado de wifi, radar, gnss, wardrive), no las de acción.

- [ ] **Step 1: Prueba que falla** — una herramienta de acción no aparece en el subconjunto de voz.
- [ ] **Step 2:** Marcar cada herramienta de admin como `read` o `act` en `types.ts` y filtrar en `llm-tools.ts`.
- [ ] **Step 3: Commit** — `feat(voice): la voz puede usar herramientas de lectura del admin`.

---

### Task 8: Título antes de responder

**Files:**
- Modify: `app/src/device/web-admin-server.ts` (handler `POST /api/chat`)
- Modify: `app/src/chat-history/settle.ts` (regla de cuándo titular, sin cambios de contrato)

**Interfaces:**
- Consumes: `generateTitle` y `fallbackTitle`.
- Produces: en un chat nuevo, el título se genera a partir del primer mensaje del usuario antes de iniciar la respuesta, y llega en el primer frame.

- [ ] **Step 1: Prueba que falla** — `needsTitleBeforeReply` es verdadero solo para el primer turno de un chat nuevo y sin renombrar.
- [ ] **Step 2:** Implementar el paso antes de `runAdminChatToolLoop`: `title = (await generateTitle(model, newMessage, "")) || fallbackTitle(newMessage)`, con límite de 15 s.
- [ ] **Step 3:** Enviar `{ chat_title }` en el primer frame y guardar el título.
- [ ] **Step 4: Commit** — `feat(chat-history): titular el chat antes de responder`.

---

### Task 9: Validación en la Pi

Requiere permiso explícito para: descargar los tres modelos residentes, borrar el chat de prueba (`9f890db6-…`), `whisplay update` y `whisplay service restart`.

- [ ] **Step 1:** Antes de desplegar, `ollama ps` con los tres modelos; confirmar que el usuario aprueba liberarlos.
- [ ] **Step 2:** Enviar desde el chat web con la voz residente: solo queda el modelo del chat (`/api/ps`).
- [ ] **Step 3:** Pulsación larga (3 s) durante una respuesta web: se cancela, se guarda la parcial, responde la voz.
- [ ] **Step 4:** Pulsación larga con la voz en reposo: no pasa nada raro.
- [ ] **Step 5:** Herramienta de admin desde el chat web durante el arbitraje: funciona.
- [ ] **Step 6:** `dmesg` sin OOM durante las pruebas.
- [ ] **Step 7:** Ledger con el resultado de cada prueba.

---

## Self-Review

- **Cobertura del spec:** arbitro (T1), adaptador (T2), `keep_alive` (T3), chat web toma memoria (T4), pulsación larga (T5), pensando (T6), herramientas en voz (T7), título antes de responder (T8), pruebas (T9).
- **Review Focus:** 1 → T2/T4 pruebas; 2 → T5/T9; 3 → T1 (`preemptDevice` no-op); 4 → T9 paso 5; 5 → T1 (solo un dueño) y T4.
- **Huecos conocidos:** T3 y T5 se describen en pasos y no tienen código completo; hay que escribirlo al ejecutar, leyendo `ollama-llm.ts` y `states.ts` en ese momento. T8 depende de cómo se titula antes de responder sin la respuesta; la prueba del paso 1 lo fija.
- **Tipos:** `Decision`, `Owner`, `MemoryArbiter`, `applyDecision` y `Deps` son consistentes entre tareas.

---

**Plan complete and saved to `docs/superpowers/plans/2026-10-03-model-memory-arbitration.md`.** ¿Lo apruebas, y prefieres ejecutarlo en esta sesión (Native) o con subagentes por tarea?
