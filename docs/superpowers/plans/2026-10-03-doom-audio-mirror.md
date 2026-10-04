# DOOM: dueño del juego (Pi o web), sonido y control horizontal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El juego DOOM se juega en la Pi o en la web (una a la vez; la otra es espejo), suena por la bocina de la Pi (efectos y música con fluidsynth), el volumen va de 0 a 100 en pasos de 5 desde el iPhone (inicio 60, guardado entre partidas), y el control del celular es horizontal estilo SNES.

**Architecture:** El motor C mezcla los efectos y los entrega como PCM por un descriptor propio (fd 3). La música la convierte de MUS a MIDI y se la pide a Node por otro descriptor (fd 4). Node reproduce el PCM con `aplay` al dispositivo `default` (dmix compartido de la Pi) y la música con `fluidsynth` en un proceso hijo, para que la voz de Akbal y el juego suenen a la vez. `DoomSession` tiene un dueño (`pi` o `web`); el espejo solo recibe estado y video.

**Tech Stack:** TypeScript (ES2020, CommonJS, strict, node:test), C (DoomGeneric, GPL-2.0), Python 3 (`chatbot-ui.py`), vanilla JS (`doom.js`), `fluidsynth` (paquete del sistema en la Pi), `aplay` (alsa-utils).

**Spec:** `docs/superpowers/specs/2026-10-03-doom-audio-mirror-design.md` (y su base `docs/superpowers/specs/2026-10-03-doom-design.md`)

## Global Constraints

- Volumen: entero de 0 a 100, pasos de 5, inicial 60. Persistencia en `app/data/doom/settings.json` con `{ "volume": <n> }`.
- Un solo dueño del juego: `owner: "pi" | "web" | null`. El espejo no manda teclas ni volumen.
- Al cambiar de dueño, todas las teclas presionadas reciben key-up.
- Música: fluidsynth con soundfont General MIDI verificado por SHA-256; el soundfont no se commitea.
- La voz de Akbal pausa el audio del juego y lo reanuda al terminar. Si la voz falla, se reanuda igual.
- El sonido sale por el dispositivo `default` de ALSA (dmix compartido en `/etc/asound.conf`).
- Control horizontal estilo SNES; en iPhone vertical la página pide girar el teléfono.
- Sin IPs reales, hosts reales ni secretos en el repo. Pruebas con `203.0.113.5` y `tailnet-host.example.ts.net`.
- Comentarios en inglés, textos de usuario en español.

## Review Focus

1. Dos superficies mandando teclas a la vez (Pi y web): solo el dueño puede enviar teclas.
2. Voz de Akbal durante el juego: el audio del juego se pausa y se reanuda, aunque la voz falle.
3. `fluidsynth` ausente o soundfont ausente: el juego corre sin música y muestra el aviso, no se cae.
4. `settings.json` dañado o con volumen fuera de rango: se usa 60 y se corrige el archivo.
5. Proceso de música que muere mientras está pausado (SIGSTOP): no deja la pantalla ni el audio bloqueados.

---

### Task 1: Volumen y configuración (puro)

**Files:**
- Create: `app/src/doom/volume.ts`
- Test: `app/src/doom/volume.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `export const VOLUME_DEFAULT = 60; export const VOLUME_STEP = 5;`
  - `export function clampVolume(value: unknown): number`: entero entre 0 y 100, múltiplo de 5. Cualquier otra cosa (NaN, no número, fuera de rango) devuelve 60 o el límite más cercano; `clampVolume(62)` devuelve 60, `clampVolume(101)` devuelve 100, `clampVolume(-3)` devuelve 0, `clampVolume("x")` devuelve 60.
  - `export function readSettings(raw: string | null): { volume: number; repaired: boolean }`: parsea el JSON; si falla o el volumen es inválido, devuelve `{ volume: 60, repaired: true }`.
  - `export function gainFor(volume: number): number`: factor 0..1 para escalar PCM, `volume / 100`.

- [ ] **Step 1: Escribir la prueba que falla**

```typescript
// app/src/doom/volume.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { VOLUME_DEFAULT, clampVolume, readSettings, gainFor } from "./volume";

test("clampVolume snaps to multiples of 5 within 0..100", () => {
  assert.equal(clampVolume(62), 60);
  assert.equal(clampVolume(65), 65);
  assert.equal(clampVolume(101), 100);
  assert.equal(clampVolume(-3), 0);
});

test("clampVolume falls back to the default for non-numbers", () => {
  assert.equal(clampVolume("x"), VOLUME_DEFAULT);
  assert.equal(clampVolume(undefined), VOLUME_DEFAULT);
  assert.equal(clampVolume(NaN), VOLUME_DEFAULT);
});

test("readSettings returns the saved volume when the file is valid", () => {
  assert.deepEqual(readSettings('{"volume":40}'), { volume: 40, repaired: false });
});

test("readSettings repairs a broken file to the default", () => {
  assert.deepEqual(readSettings("no es json"), { volume: 60, repaired: true });
  assert.deepEqual(readSettings(null), { volume: 60, repaired: true });
  assert.deepEqual(readSettings('{"volume":"mucho"}'), { volume: 60, repaired: true });
});

test("gainFor maps the volume to a 0..1 factor", () => {
  assert.equal(gainFor(60), 0.6);
  assert.equal(gainFor(0), 0);
  assert.equal(gainFor(100), 1);
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd app && npx tsc -p . ; node --test dist/doom/volume.test.js`
Expected: FAIL (módulo no existe).

- [ ] **Step 3: Implementar**

```typescript
// app/src/doom/volume.ts
// Volume is a whole number 0..100 in steps of 5. The phone moves it in steps;
// the engine scales its PCM by the same factor, so Akbal's own voice volume is
// never touched.
export const VOLUME_DEFAULT = 60;
export const VOLUME_STEP = 5;

export function clampVolume(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return VOLUME_DEFAULT;
  const clamped = Math.min(100, Math.max(0, value));
  return Math.round(clamped / VOLUME_STEP) * VOLUME_STEP;
}

export function readSettings(raw: string | null): { volume: number; repaired: boolean } {
  if (raw === null) return { volume: VOLUME_DEFAULT, repaired: true };
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { volume: VOLUME_DEFAULT, repaired: true };
  }
  const v = parsed && typeof parsed === "object" ? parsed.volume : undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return { volume: VOLUME_DEFAULT, repaired: true };
  return { volume: clampVolume(v), repaired: false };
}

export function gainFor(volume: number): number {
  return clampVolume(volume) / 100;
}
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `cd app && npx tsc -p . && node --test dist/doom/volume.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/doom/volume.ts app/src/doom/volume.test.ts
git commit -m "feat(doom): volumen 0..100 en pasos de 5 y lectura de settings"
```

---

### Task 2: Dueño del juego en DoomSession

**Files:**
- Modify: `app/src/doom/session.ts`
- Test: `app/src/doom/session.test.ts`

**Interfaces:**
- Consumes: `ControlTokens`, `ControllerLock`, `DoomKey`, `KEY_CODES` (ya existen).
- Produces (añadido a `DoomSession`):
  - `type DoomOwner = "pi" | "web" | null`
  - `owner(): DoomOwner`
  - `claimOwner(who: "pi" | "web"): { ok: boolean; token?: string; error?: string }`: si no hay juego, devuelve error `"No hay juego corriendo"`. Si ya hay dueño y es el mismo, devuelve `ok: true` con el token vigente. Si es distinto, cambia el dueño: suelta las teclas abajo (key-up), revoca el token anterior, emite token nuevo y `ok: true`.
  - `DoomState` gana `owner: DoomOwner`.
  - `stop()` deja `owner = null`.

- [ ] **Step 1: Pruebas que fallan**

Agregar a `app/src/doom/session.test.ts` (usar el `fakeEngine` y `makeSession` que ya existen):

```typescript
test("owner is null until someone claims it, and stop clears it", () => {
  const { session } = makeSession();
  session.start();
  assert.equal(session.owner(), null);
  const r = session.claimOwner("pi");
  assert.equal(r.ok, true);
  assert.equal(session.owner(), "pi");
  session.stop();
  assert.equal(session.owner(), null);
});

test("claimOwner refuses when no game is running", () => {
  const { session } = makeSession();
  const r = session.claimOwner("web");
  assert.equal(r.ok, false);
  assert.match(r.error!, /No hay juego/);
});

test("switching owner releases held keys and revokes the old token", () => {
  const { session, fake } = makeSession();
  const first = session.start().token!;
  session.claimOwner("pi");
  session.claim("pi-client", first);
  session.key("pi-client", "fire", true);
  const second = session.claimOwner("web");
  assert.equal(second.ok, true);
  assert.notEqual(second.token, first);
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.match(fake.written.join(""), /up 163/);
    assert.equal(session.claim("pi-client", first), false);
    resolve();
  }));
});

test("the same owner claiming again keeps the token", () => {
  const { session } = makeSession();
  session.start();
  const a = session.claimOwner("web");
  const b = session.claimOwner("web");
  assert.equal(a.token, b.token);
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd app && npx tsc -p . ; node --test dist/doom/session.test.js`
Expected: FAIL (`owner`, `claimOwner` no existen).

- [ ] **Step 3: Implementar**

En `session.ts`:
- Campo `private ownerValue: DoomOwner = null;`
- `owner()` devuelve `this.ownerValue`.
- `claimOwner(who)`:
  ```typescript
  claimOwner(who: "pi" | "web"): { ok: boolean; token?: string; error?: string } {
    if (!this.engine) return { ok: false, error: "No hay juego corriendo" };
    if (this.ownerValue === who) return { ok: true, token: this.deps.tokens.current() ?? undefined };
    this.releaseKeys();
    this.deps.tokens.revokeAll();
    this.deps.lock.release(this.deps.lock.holder() ?? "");
    this.ownerValue = who;
    const token = this.deps.tokens.issue();
    this.emitState();
    return { ok: true, token };
  }
  ```
  `releaseKeys()` ya existe desde la corrección de teclas atoradas: reúsalo.
- En `stop()` y en `engineLost()`: `this.ownerValue = null;`.
- `state()` incluye `owner: this.ownerValue`.

- [ ] **Step 4: Correr y ver que pasa**

Run: `cd app && npx tsc -p . && node --test dist/doom/session.test.js`
Expected: PASS (las pruebas nuevas y las anteriores).

- [ ] **Step 5: Commit**

```bash
git add app/src/doom/session.ts app/src/doom/session.test.ts
git commit -m "feat(doom): dueño del juego (pi o web) y suelta de teclas al cambiar"
```

---

### Task 3: Protocolo del websocket: play-here, volumen y espejo

**Files:**
- Modify: `app/src/device/doom-routes.ts` (parseDoomMessage, sendState, handlers)
- Test: `app/src/device/doom-routes.test.ts`

**Interfaces:**
- Consumes: `DoomSession.claimOwner`, `DoomSession.owner`, `clampVolume` (Task 1).
- Produces:
  - `type DoomClientMessage` gana:
    - `{ type: "play-here" }` (el cliente pide ser dueño desde la web: `claimOwner("web")`; el token vigente se devuelve en un mensaje `state` con `token` solo a ese cliente).
    - `{ type: "volume"; value: number }`: solo acepta si el cliente es el dueño web. Valor pasa por `clampVolume`.
  - `state` gana `owner`, `mirror: boolean` (true si este cliente no es el dueño), `volume: number`.
  - Mensajes `key` y `claim` de un espejo se ignoran (no llegan a la sesión).

- [ ] **Step 1: Pruebas que fallan**

Agregar a `doom-routes.test.ts`:

```typescript
test("parses play-here and volume", () => {
  assert.deepEqual(parseDoomMessage('{"type":"play-here"}'), { type: "play-here" });
  assert.deepEqual(parseDoomMessage('{"type":"volume","value":65}'), { type: "volume", value: 65 });
});

test("rejects a volume message without a number", () => {
  assert.equal(parseDoomMessage('{"type":"volume","value":"alto"}'), null);
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd app && npx tsc -p . ; node --test dist/device/doom-routes.test.js`
Expected: FAIL (tipos nuevos no existen).

- [ ] **Step 3: Implementar**

- En `parseDoomMessage`, agregar los dos tipos. `volume` exige `typeof m.value === "number"`.
- En los handlers de `ws.on("message")`:
  - `play-here`: `const r = session.claimOwner("web")`. Si `r.ok`, guarda el token en el estado del cliente solo para enviarlo en su `state`. Si no, manda `state` con `error: r.error`.
  - `volume`: si `session.owner() === "web"` y el cliente es el dueño web (`clients.get(ws)?.isWebOwner`), llama `session.setVolume(clampVolume(value))` (método nuevo, ver Task 4 para el motor).
  - `key` y `claim` de un cliente con `mirror` no se pasan a la sesión.
- `sendState(ws)` agrega `owner`, `mirror: owner !== null && !isWebOwner`, `volume: session.volume()`.

- [ ] **Step 4: Correr y ver que pasa**

Run: `cd app && npx tsc -p . && node --test dist/device/doom-routes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/device/doom-routes.ts app/src/device/doom-routes.test.ts
git commit -m "feat(doom): play-here, volumen y espejo en el websocket"
```

---

### Task 4: Motor C: mezcla de efectos y salida PCM (fd 3)

**Files:**
- Modify: `app/doom/engine/doomgeneric_akbal.c`
- Modify: `app/scripts/fetch-doom-engine.sh` (agregar `i_akbal_sound.c` a la lista de fuentes)
- Create: `app/doom/engine/i_akbal_sound.c` (implementación de `I_*` de sonido)
- Test: prueba de humo en la Pi (ver Step 5)

**Interfaces:**
- Consumes: la interfaz `i_sound.h` de DoomGeneric en el commit `dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284`:
  `I_InitSound(boolean)`, `I_ShutdownSound()`, `I_GetSfxLumpNum(sfxinfo_t*)`, `I_UpdateSound()`, `I_UpdateSoundParams(int,int,int)`, `I_StartSound(sfxinfo_t*,int,int,int)`, `I_StopSound(int)`, `I_SoundIsPlaying(int)`, `I_PrecacheSounds(sfxinfo_t*,int)`.
- Produces:
  - Salida: cada bloque de audio se escribe a fd 3 como PCM crudo, mono, 11025 Hz, 16 bits con signo, little-endian, en bloques de 256 muestras.
  - Entrada de volumen: stdin acepta la línea `volume <n>` (0..100). Se aplica como escala del PCM.
  - Entrada de teclas (existente, sin cambios): `down <código>` / `up <código>`.
- Nota: la capa de sonido de DoomGeneric no trae mezclador propio. El mezclador se escribe aquí (canales de 8 voces, mezcla por suma con saturación).

- [ ] **Step 1: Confirmar la interfaz en el commit fijado**

Run: `gh api "repos/ozkl/doomgeneric/contents/doomgeneric/i_sound.h?ref=dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284" --jq .content | base64 -d | grep -n "I_"`
Expected: las firmas listadas en Consumes. Si una difiere, ajustar la implementación al header real y anotarlo en el reporte.

- [ ] **Step 2: Escribir el mezclador**

Crear `app/doom/engine/i_akbal_sound.c` con este núcleo (los nombres de las funciones son los de `i_sound.h` y deben coincidir con la firma real del header):

```c
/* app/doom/engine/i_akbal_sound.c
 * Sound effects for Akbal Pi. DoomGeneric has no mixer of its own: this file
 * mixes up to 8 DMX samples (11025 Hz, 8-bit unsigned, 8-byte header) into a
 * 16-bit mono stream and writes it to AKBAL_AUDIO_FD (fd 3), where Node plays it.
 * Music is not handled here (see i_akbal_music.c). */
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include "doomtype.h"
#include "sounds.h"
#include "i_sound.h"
#include "z_zone.h"
#include "w_wad.h"

#define AKBAL_AUDIO_FD 3
#define MIX_RATE 11025
#define MIX_BLOCK 256
#define MAX_CHANNELS 8

typedef struct {
  const uint8_t *data;   /* 8-bit unsigned samples (after the 8-byte DMX header) */
  int length;
  int pos;               /* fixed-point not needed at 11025 Hz */
  int vol;               /* 0..127 */
  int sep;               /* 0..254, 128 = center */
  int active;
  int sfx;               /* sfxinfo_t* id, to answer I_SoundIsPlaying */
} voice_t;

static voice_t voices[MAX_CHANNELS];
static int16_t out_block[MIX_BLOCK];
static int audio_volume = 100;   /* 0..100, set from stdin "volume <n>" */

void akbal_set_volume(int v) { audio_volume = v < 0 ? 0 : (v > 100 ? 100 : v); }

void I_InitSound(boolean use_sfx_prefix) { (void)use_sfx_prefix; memset(voices, 0, sizeof voices); }
void I_ShutdownSound(void) { memset(voices, 0, sizeof voices); }

int I_GetSfxLumpNum(sfxinfo_t *sfx) {
  char name[9];
  snprintf(name, sizeof name, "ds%s", sfx->name);
  return W_GetNumForName(name);
}

void I_PrecacheSounds(sfxinfo_t *sounds, int num_sounds) { (void)sounds; (void)num_sounds; }

int I_StartSound(sfxinfo_t *sfx, int channel, int vol, int sep) {
  if (channel < 0 || channel >= MAX_CHANNELS) return -1;
  int lump = I_GetSfxLumpNum(sfx);
  const uint8_t *raw = W_CacheLumpNum(lump, PU_STATIC);
  int len = W_LumpLength(lump);
  if (len <= 8) return -1;
  voices[channel].data = raw + 8;   /* skip DMX header */
  voices[channel].length = len - 8;
  voices[channel].pos = 0;
  voices[channel].vol = vol;
  voices[channel].sep = sep;
  voices[channel].active = 1;
  voices[channel].sfx = (int)(intptr_t)sfx;
  return channel;
}

void I_StopSound(int channel) { if (channel >= 0 && channel < MAX_CHANNELS) voices[channel].active = 0; }
boolean I_SoundIsPlaying(int channel) { return channel >= 0 && channel < MAX_CHANNELS && voices[channel].active; }
void I_UpdateSoundParams(int channel, int vol, int sep) {
  if (channel >= 0 && channel < MAX_CHANNELS) { voices[channel].vol = vol; voices[channel].sep = sep; }
}

/* Called by the game loop. Mixes one block and writes it to fd 3. */
void I_UpdateSound(void) {
  for (int i = 0; i < MIX_BLOCK; i++) {
    int32_t acc = 0;
    for (int c = 0; c < MAX_CHANNELS; c++) {
      voice_t *v = &voices[c];
      if (!v->active) continue;
      if (v->pos >= v->length) { v->active = 0; continue; }
      int s = (int)v->data[v->pos++] - 128;     /* unsigned 8-bit to signed */
      acc += (s * v->vol) >> 4;                 /* vol 0..127 */
    }
    acc = (acc * audio_volume) / 100;           /* DOOM volume, from the phone */
    if (acc > 32767) acc = 32767;
    if (acc < -32768) acc = -32768;
    out_block[i] = (int16_t)acc;
  }
  /* Raw PCM, little-endian on the Pi. Failure to write is not fatal: the game
   * keeps running silently if Node closed the audio pipe. */
  ssize_t n = write(AKBAL_AUDIO_FD, out_block, sizeof out_block);
  (void)n;
}
```

- [ ] **Step 3: Conectar fd 3 y la línea `volume` en `doomgeneric_akbal.c`**

- En `DG_Init` (o `main` antes de `doomgeneric_Create`): dejar el descriptor 3 sin tocar (lo abre Node). No duplicar.
- En `pump_stdin`: reconocer la línea `volume <n>` con `akbal_set_volume(atoi(line + 7))`.
- Declarar `void akbal_set_volume(int v);` en el archivo.
- Agregar `i_akbal_sound.c` a la lista de fuentes en `fetch-doom-engine.sh` (la lista del Makefile de upstream más este archivo).

- [ ] **Step 4: Compilar en local**

Run (en el Mac, en el scratch del clon, como en la Tarea 4):
`clang -c -Wall -Wextra -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 -I<clon>/doomgeneric app/doom/engine/i_akbal_sound.c -o /tmp/i_akbal_sound.o`
Expected: sin errores. Warnings de tipos de DoomGeneric: anotarlos en el reporte.

- [ ] **Step 5: Prueba de humo en la Pi**

Run (en la Pi, con el WAD): `./doom/bin/doom-engine -iwad data/doom/freedoom1.wad < /dev/null 3>/tmp/pcm.bin > /dev/null` durante 4 s (con `timeout 4`).
Expected: `/tmp/pcm.bin` con tamaño múltiplo de 512 (256 muestras × 2 bytes) y no todo ceros durante la demo (el título trae sonidos de menú). Borrar `/tmp/pcm.bin` al terminar.

- [ ] **Step 6: Commit**

```bash
git add app/doom/engine/i_akbal_sound.c app/doom/engine/doomgeneric_akbal.c app/scripts/fetch-doom-engine.sh
git commit -m "feat(doom): efectos de sonido por fd 3 con volumen desde stdin"
```

---

### Task 5: Motor C: música MUS a MIDI por fd 4

**Files:**
- Create: `app/doom/engine/i_akbal_music.c`
- Modify: `app/doom/engine/doomgeneric_akbal.c` (abrir fd 4 como canal de control; no cambia el resto)
- Modify: `app/scripts/fetch-doom-engine.sh` (agregar `i_akbal_music.c`)

**Interfaces:**
- Consumes: `mus2mid.h` de DoomGeneric (conversión MUS → MIDI). Verificar el nombre exacto de la función exportada en el commit fijado con `gh api ... mus2mid.h` antes de usarla.
- Produces: por fd 4, una línea por evento:
  - `song <ruta-absoluta-al-.mid> <loop 0|1>`
  - `stop`
  - `pause`
  - `resume`
- Ruta del MIDI: `app/data/doom/music/<n>.mid` (directorio creado por Node al arrancar).

- [ ] **Step 1: Confirmar la interfaz de mus2mid en el commit fijado**

Run: `gh api "repos/ozkl/doomgeneric/contents/doomgeneric/mus2mid.h?ref=dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284" --jq .content | base64 -d`
Expected: la firma de conversión. Anotar el nombre real en el reporte.

- [ ] **Step 2: Implementar las funciones `I_*` de música**

`app/doom/engine/i_akbal_music.c`:
- `I_InitMusic(void)`, `I_ShutdownMusic(void)`: no hacen nada más que marcar estado.
- `I_RegisterSong(data, len)`: convierte MUS a MIDI con la función de `mus2mid.h`, escribe el resultado en `app/data/doom/music/<n>.mid` (n incremental) y devuelve un handle con la ruta.
- `I_PlaySong(handle, looping)`: escribe `song <ruta> <looping>\n` en fd 4.
- `I_StopSong()`: escribe `stop\n` en fd 4.
- `I_PauseSong()`: `pause\n`. `I_ResumeSong()`: `resume\n`.
- `I_UnRegisterSong(handle)`: no borra el archivo (Node lo limpia al arrancar).
- `I_SetMusicVolume(v)`: no hace nada (el volumen de la música lo maneja Node con fluidsynth).
- `I_MusicIsPlaying()`: devuelve el último estado escrito.

- [ ] **Step 3: Compilar y revisar**

Run: compilar igual que en Task 4 Step 4 con `i_akbal_music.c`. Expected: sin errores.

- [ ] **Step 4: Prueba de humo en la Pi**

Run: correr el motor 6 s con `4>/tmp/ctl.txt`. Expected: `/tmp/ctl.txt` contiene al menos una línea `song ...` (la demo de título tiene música). Borrar archivos temporales.

- [ ] **Step 5: Commit**

```bash
git add app/doom/engine/i_akbal_music.c app/doom/engine/doomgeneric_akbal.c app/scripts/fetch-doom-engine.sh
git commit -m "feat(doom): música MUS a MIDI con control por fd 4"
```

---

### Task 6: Salida de audio en Node (aplay) con volumen

**Files:**
- Create: `app/src/doom/audio-out.ts`
- Test: `app/src/doom/audio-out.test.ts`
- Modify: `app/src/doom/session.ts` (spawn del motor con fd 3 y fd 4; enviar `volume` al motor)

**Interfaces:**
- Consumes: `gainFor`, `clampVolume` (Task 1).
- Produces:
  - `export function aplayArgs(): string[]`: `["-q", "-D", "default", "-t", "raw", "-f", "S16_LE", "-r", "11025", "-c", "1"]`.
  - `export function parseControlLine(line: string): { kind: "song"; path: string; loop: boolean } | { kind: "stop" | "pause" | "resume" } | null`.
  - `export class AudioOut { constructor(spawn: (cmd: string, args: string[]) => { stdin: Writable; kill(): void; onExit(cb: () => void): void }); start(): void; write(pcm: Buffer): void; stop(): void; }`
- Cambio en `session.ts`: `spawnEngine` usa `stdio: ["pipe", "pipe", "inherit", "pipe", "pipe"]` (fd 3 = PCM hacia Node, fd 4 = control hacia Node). `DoomSession` recibe `onAudio(pcm)` y `onControl(line)`.

- [ ] **Step 1: Pruebas que fallan**

`app/src/doom/audio-out.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { aplayArgs, parseControlLine } from "./audio-out";

test("aplay uses the shared default device, 11025 Hz mono 16-bit", () => {
  assert.deepEqual(aplayArgs(), ["-q", "-D", "default", "-t", "raw", "-f", "S16_LE", "-r", "11025", "-c", "1"]);
});

test("parses song, stop, pause and resume lines from the engine", () => {
  assert.deepEqual(parseControlLine("song /tmp/a.mid 1"), { kind: "song", path: "/tmp/a.mid", loop: true });
  assert.deepEqual(parseControlLine("stop"), { kind: "stop" });
  assert.deepEqual(parseControlLine("pause"), { kind: "pause" });
  assert.deepEqual(parseControlLine("resume"), { kind: "resume" });
});

test("rejects unknown or broken control lines", () => {
  assert.equal(parseControlLine("hack"), null);
  assert.equal(parseControlLine("song"), null);
  assert.equal(parseControlLine(""), null);
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd app && npx tsc -p . ; node --test dist/doom/audio-out.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementar**

`app/src/doom/audio-out.ts` con `aplayArgs`, `parseControlLine` (rechaza `song` sin ruta, valida que la ruta sea absoluta y termine en `.mid`) y `AudioOut`:
- `start()`: lanza `aplay` con `aplayArgs()`.
- `write(pcm)`: escribe al stdin de `aplay` si está abierto; si no, descarta sin lanzar.
- `stop()`: mata el proceso y marca cerrado.
- Si `aplay` sale con error, `AudioOut` queda cerrado y se registra un aviso; el juego sigue.

En `session.ts`:
- `spawnEngine` acepta `stdio` con cinco entradas (fd 3 y fd 4 como `pipe`).
- Leer `engine.audio` (fd 3) y reenviar a `onAudio`.
- Leer `engine.control` (fd 4), separar por líneas y pasar cada una por `parseControlLine` → `onControl`.
- Al arrancar el motor, enviar `volume <n>` con el volumen vigente.
- `setVolume(v)`: guarda en `settings.json` (Task 7) y escribe `volume <n>\n` en stdin del motor.

- [ ] **Step 4: Correr y ver que pasa**

Run: `cd app && npx tsc -p . && node --test dist/doom/*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/doom/audio-out.ts app/src/doom/audio-out.test.ts app/src/doom/session.ts
git commit -m "feat(doom): salida de audio con aplay y canales fd 3 y fd 4"
```

---

### Task 7: Persistencia del volumen y arranque de música con fluidsynth

**Files:**
- Create: `app/src/doom/settings-store.ts` (lee y escribe `app/data/doom/settings.json`)
- Create: `app/src/doom/music.ts` (proceso de fluidsynth por canción)
- Create: `app/scripts/fetch-doom-soundfont.sh`
- Test: `app/src/doom/music.test.ts`

**Interfaces:**
- Consumes: `readSettings`, `VOLUME_DEFAULT` (Task 1), `parseControlLine` (Task 6).
- Produces:
  - `settings-store.ts`: `loadVolume(dir: string): number` (usa `readSettings`; si `repaired`, reescribe el archivo) y `saveVolume(dir: string, volume: number): void`.
  - `music.ts`: `fluidsynthArgs(soundfont: string, midi: string, gain: number): string[]` y `class MusicPlayer { constructor(spawn, soundfont: string | null); handle(line: ControlLine): void; setGain(g: number): void; }`. Maneja `song`, `stop`, `pause` (SIGSTOP al proceso), `resume` (SIGCONT). Si no hay soundfont o no está `fluidsynth`, registra `musicAvailable = false` y no lanza nada.
  - `fetch-doom-soundfont.sh`: descarga un soundfont General MIDI con licencia permisiva, verifica SHA-256 y lo deja en `app/data/doom/soundfont.sf2`. No se commitea.

- [ ] **Step 1: Pruebas que fallan**

`app/src/doom/music.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { fluidsynthArgs, MusicPlayer } from "./music";

test("fluidsynth plays one MIDI file through the shared ALSA default, with gain", () => {
  assert.deepEqual(fluidsynthArgs("/s.sf2", "/m.mid", 0.6), [
    "-ni", "-a", "alsa", "-o", "audio.alsa.device=default", "-g", "0.6", "/s.sf2", "/m.mid",
  ]);
});

test("without a soundfont the player stays silent and reports unavailable", () => {
  let spawned = 0;
  const player = new MusicPlayer(() => { spawned++; return null as any; }, null);
  player.handle({ kind: "song", path: "/m.mid", loop: true });
  assert.equal(spawned, 0);
  assert.equal(player.available(), false);
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd app && npx tsc -p . ; node --test dist/doom/music.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- `fluidsynthArgs` exactamente como en la prueba.
- `MusicPlayer.handle(line)`:
  - `song`: si hay proceso, lo mata; lanza `fluidsynth` con `fluidsynthArgs(soundfont, path, gain)` si `soundfont` existe y `fluidsynth` está en el PATH. Si `loop`, al salir el proceso se vuelve a lanzar la misma canción.
  - `stop`: mata el proceso y cancela el reinicio.
  - `pause`: `process.kill(pid, "SIGSTOP")`. `resume`: `SIGCONT`.
  - Si el proceso muere mientras está pausado, `pause` queda sin efecto y `resume` no reinicia la canción; se registra un aviso.
- `setGain(g)`: se aplica a la siguiente canción (documentado; el cambio en vivo queda para una fase posterior, ver Riesgos del spec).
- `loadVolume` y `saveVolume`: `settings.json` en `app/data/doom/`.
- Script de soundfont: `curl -fL`, verificar `sha256sum` contra la constante del script; si no coincide, abortar sin dejar archivo.

- [ ] **Step 4: Correr y ver que pasa**

Run: `cd app && npx tsc -p . && node --test dist/doom/*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/doom/settings-store.ts app/src/doom/music.ts app/src/doom/music.test.ts app/scripts/fetch-doom-soundfont.sh
git commit -m "feat(doom): volumen guardado y música con fluidsynth"
```

---

### Task 8: Pausa del audio durante la voz de Akbal

**Files:**
- Modify: `app/src/doom/session.ts` (métodos `pauseAudio()` y `resumeAudio()`)
- Modify: `app/src/core/ChatFlow.ts` (llamar a pausa al entrar a la respuesta de voz y reanudar al salir)
- Test: `app/src/doom/session.test.ts`

**Interfaces:**
- Consumes: `MusicPlayer` (Task 7), `AudioOut` (Task 6).
- Produces: `DoomSession.pauseAudio(): void` y `resumeAudio(): void`. Ambos son idempotentes. `pauseAudio` deja de enviar PCM al `AudioOut` (el motor sigue generando, el PCM se descarta) y manda `pause` al `MusicPlayer`. `resumeAudio` hace lo contrario.

- [ ] **Step 1: Pruebas que fallan**

En `session.test.ts`:

```typescript
test("pauseAudio drops PCM and pauses music; resumeAudio restores both", () => {
  const { session } = makeSession();
  session.start();
  const sent: Buffer[] = [];
  session.onAudio((pcm) => sent.push(pcm));
  session.pauseAudio();
  session.pauseAudio();
  session.feedAudioForTest(Buffer.alloc(512));
  assert.equal(sent.length, 0);
  session.resumeAudio();
  session.feedAudioForTest(Buffer.alloc(512));
  assert.equal(sent.length, 1);
});
```

`feedAudioForTest` es un método de prueba de `DoomSession` que llama a los listeners de audio. Documentar en el comentario que solo lo usan las pruebas.

- [ ] **Step 2: Correr y ver que falla**

Run: `cd app && npx tsc -p . ; node --test dist/doom/session.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementar**

- En `DoomSession`: campo `audioPaused = false`. `onAudio(cb)` registra listeners que solo reciben PCM si `!audioPaused`.
- `pauseAudio()`: si ya está pausado, no hace nada; si no, `audioPaused = true` y llama `musicPlayer.handle({ kind: "pause" })`.
- `resumeAudio()`: `audioPaused = false` y `musicPlayer.handle({ kind: "resume" })`.
- En `ChatFlow.ts`: al entrar al estado de respuesta de voz (el que habla), llamar `doomSession.pauseAudio()`; al salir (incluso si la voz falla), `doomSession.resumeAudio()`. Hacerlo con `try/finally` alrededor de la llamada de respuesta. Verificar en el código el punto exacto donde empieza y termina la respuesta hablada (`answering` o equivalente) antes de editar.

- [ ] **Step 4: Correr y ver que pasa**

Run: `cd app && npx tsc -p . && node --test dist/doom/*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/doom/session.ts app/src/doom/session.test.ts app/src/core/ChatFlow.ts
git commit -m "feat(doom): la voz de Akbal pausa el audio del juego"
```

---

### Task 9: Dueño desde la pantalla y el espejo en la Pi

**Files:**
- Modify: `app/src/core/chat-flow/doom-mode.ts` (al entrar desde la Pi: `claimOwner("pi")`; estado espejo en pantalla)
- Modify: `app/src/core/chat-flow/doom-mode.test.ts` (solo funciones puras nuevas)
- Modify: `app/python/chatbot-ui.py` (pantalla espejo: sin QR cuando el dueño es la web)

**Interfaces:**
- Consumes: `DoomSession.claimOwner`, `DoomSession.owner` (Task 2).
- Produces:
  - `export function screenFaceFor(owner: "pi" | "web" | null, controller: boolean): "qr" | "game" | "mirror"` en `doom-mode.ts`:
    - `owner === "web"` → `"mirror"`.
    - `owner === "pi"` y `controller` → `"game"`; si no, `"qr"`.
    - `owner === null` → `"qr"`.
  - Al entrar desde la pantalla: `doomSession.claimOwner("pi")` después de `start()`.

- [ ] **Step 1: Prueba que falla**

En `doom-mode.test.ts`:

```typescript
import { screenFaceFor } from "./doom-mode";

test("screen shows the mirror when the web owns the game", () => {
  assert.equal(screenFaceFor("web", true), "mirror");
  assert.equal(screenFaceFor("web", false), "mirror");
});

test("screen shows the game or the QR depending on the Pi controller", () => {
  assert.equal(screenFaceFor("pi", true), "game");
  assert.equal(screenFaceFor("pi", false), "qr");
  assert.equal(screenFaceFor(null, false), "qr");
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd app && npx tsc -p . ; node --test dist/core/chat-flow/doom-mode.test.js`
Expected: FAIL (`screenFaceFor` no existe).

- [ ] **Step 3: Implementar**

- `screenFaceFor` como en Interfaces.
- En `enterDoomMode`, tras `start()` exitoso: `doomSession.claimOwner("pi")`.
- `paintForState` usa `screenFaceFor(s.owner, s.controller)`: `"mirror"` pinta el texto "Jugando desde la web" sin QR; `"game"` y `"qr"` como hoy.
- En `chatbot-ui.py`: la cara `mirror` usa el mismo flujo de cuadros (`game_frame`) pero sin QR. Verificar el orden de llamadas igual que en la Tarea 7 (no crear una carrera nueva).

- [ ] **Step 4: Correr y ver que pasa**

Run: `cd app && npx tsc -p . && node --test dist/core/chat-flow/doom-mode.test.js && python3 -m py_compile app/python/chatbot-ui.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/core/chat-flow/doom-mode.ts app/src/core/chat-flow/doom-mode.test.ts app/python/chatbot-ui.py
git commit -m "feat(doom): la pantalla de la Pi muestra espejo cuando juega la web"
```

---

### Task 10: Página horizontal estilo SNES, volumen y "Jugar aquí"

**Files:**
- Modify: `app/web/admin/doom.html`
- Modify: `app/web/admin/doom.js`
- Modify: `app/web/admin/doom.css`

**Interfaces:**
- Consumes: mensajes `play-here`, `volume`; campos de `state`: `owner`, `mirror`, `volume` (Task 3).
- Produces (UI):
  - Botón "Jugar aquí" (manda `{ type: "play-here" }`). Si `mirror` es verdadero, el botón está visible y el control queda deshabilitado.
  - Controles con texto: D-pad a la izquierda; FIRE "Disparar", USE "Abrir/usar", WEAPON "Cambiar arma", RUN "Correr", MENU "Menú". Cada botón muestra su tecla de escritorio debajo.
  - Volumen: botones `−` y `+` que mandan `{ type: "volume", value: v ± 5 }` con `v` del último `state.volume`; valor visible `NN%`.
  - Vertical: si `matchMedia("(orientation: portrait)")` y el ancho es menor que el alto, mostrar "Gira tu iPhone a horizontal" y ocultar controles.

- [ ] **Step 1: Comprobación de sintaxis y de contenido (antes de editar)**

Run: `node --check app/web/admin/doom.js` y `grep -c "data-key" app/web/admin/doom.html`
Expected: sintaxis OK y el conteo actual de botones. Anotar el conteo en el reporte.

- [ ] **Step 2: Editar el HTML**

En `doom.html`:
- Agregar el botón `#play-here` con texto "Jugar aquí".
- Agregar `#volume-down`, `#volume-up` y `#volume-value`.
- Cada botón de acción tiene un `<span class="label">` con el texto de la función y `<small>` con la tecla (CTRL, E, SHIFT, ESC, 1-7).
- Agregar `#rotate-hint` (oculto por defecto) con "Gira tu iPhone a horizontal".

- [ ] **Step 3: Editar el JS**

En `doom.js`:
- Manejar `state.owner`, `state.mirror`, `state.volume`: actualizar `#volume-value` y deshabilitar controles si `mirror`.
- `#play-here`: `send({ type: "play-here" })`.
- `#volume-down` y `#volume-up`: `send({ type: "volume", value: clampStep(current ± 5) })`, con límites 0 y 100.
- Vertical: escuchar `matchMedia` y `resize`; mostrar `#rotate-hint` y ocultar `#controls`.
- No agregar dependencias. Los nombres de tecla siguen siendo los de `keymap.ts`.

- [ ] **Step 4: Editar el CSS**

En `doom.css`: layout horizontal con D-pad a la izquierda y botones a la derecha; `.label` y `small` visibles; objetivos de al menos 56 px; `#rotate-hint` centrado en pantalla completa en vertical.

- [ ] **Step 5: Verificar**

Run: `node --check app/web/admin/doom.js` y revisar que cada `data-key` del HTML sea un nombre de `DOOM_KEYS`.
Expected: sintaxis OK; nombres válidos. Las pruebas en iPhone y escritorio quedan en el checklist manual del reporte.

- [ ] **Step 6: Commit**

```bash
git add app/web/admin/doom.html app/web/admin/doom.js app/web/admin/doom.css
git commit -m "feat(doom): control horizontal estilo SNES con volumen y Jugar aquí"
```

---

### Task 11: Instalación en la Pi, documentación y checklist

**Files:**
- Modify: `docs/doom.md` (sonido, dueño, volumen, control horizontal, checklist de la Pi)
- Modify: `docs/arquitectura.md` (nodos de audio y dueño)
- Modify: `docs/superpowers/specs/2026-10-03-doom-audio-mirror-design.md` (Estado)

**Interfaces:** ninguna de código.

- [ ] **Step 1: Documentación**

Actualizar `docs/doom.md` con: instalación de `fluidsynth` (`sudo apt install fluidsynth`), `scripts/fetch-doom-soundfont.sh`, uso de "Jugar aquí", volumen y su persistencia, checklist de la Pi (sonido por la bocina, volumen desde el iPhone, voz de Akbal durante el juego, espejo al jugar desde la web, arranque de DOOM desde la web con el juego apagado).

- [ ] **Step 2: Diagrama**

Agregar en `docs/arquitectura.md` los nodos de audio (`audio-out.ts`, `music.ts`) y el de dueño (`session.ts`), con enlaces a los archivos.

- [ ] **Step 3: Estado del spec**

Cambiar la línea `Estado:` del spec a "Implementado en la rama; pendiente de verificación en la Pi" hasta que el dueño corra el checklist.

- [ ] **Step 4: Commit**

```bash
git add docs/doom.md docs/arquitectura.md docs/superpowers/specs/2026-10-03-doom-audio-mirror-design.md
git commit -m "docs(doom): sonido, dueño del juego, volumen y checklist de la Pi"
```

---

## Notas de ejecución

- Instalar `fluidsynth` en la Pi (`sudo apt install fluidsynth`) es un paso del dispositivo: el dueño ya dio permiso. Se hace antes de la Tarea 7 en la Pi.
- Descargar el soundfont (Tarea 7) también se hace en la Pi con su script verificado.
- La compilación del motor en la Pi (Tareas 4 y 5) requiere reiniciar el servicio solo si cambia la lista de fuentes; el script lo recompila al detectar cambios.
- Cada tarea termina con su commit. Los push y el deploy van al final, con permiso del dueño.
