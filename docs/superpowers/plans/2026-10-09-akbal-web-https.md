# Akbal Vision — Hito 3 (HTTPS de la web de Akbal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que toda la web de Akbal se sirva por HTTPS auto-firmado en su puerto actual, para que `getUserMedia` (la cámara de Akbal Vision) funcione desde cualquier dispositivo del tailnet o del WiFi directo —laptop y celular— sin túnel, no solo en localhost.

**Architecture:** El servidor Koa (`web-admin-server.ts`) hoy crea `http.createServer`. Se añade un helper puro que lee un par cert/llave auto-firmado de `data/tls/`; si existe, el server arranca como `https.createServer` (mismo puerto, mismo app, mismo handler de `upgrade` → el WebSocket pasa a `wss` sin cambios); si no existe, cae a `http` como hoy (dev sin cert no se rompe). Un script genera el cert en la Pi (idempotente, gitignored). Las URLs auto-referenciales (el QR de DOOM, el log) usan el esquema correcto según haya TLS.

**Tech Stack:** Node.js `https`, `openssl` (cert self-signed), TypeScript (CommonJS), `node --test` sobre `dist/` (como los tests existentes de `doom/`).

**Spec:** `docs/superpowers/specs/2026-10-08-akbal-vision-design.md` (decisión #2)

## Global Constraints

- **Mismo puerto** que el admin actual; no se abre un puerto nuevo. El `http://` plano en ese puerto deja de funcionar cuando hay cert (es TLS); aceptado en el spec.
- Fallback a http si no hay cert (para no romper dev ni un dispositivo sin cert generado).
- Cert y llave en `data/tls/` (ya gitignored vía `data/`), override con `WEB_ADMIN_TLS_DIR`. Nunca commitear cert/llave.
- Config por `.env`/env (convención del repo): `WEB_ADMIN_TLS_DIR`.
- Comentarios de código en inglés; strings de usuario en español.
- Tests TS: archivo `*.test.ts` junto al módulo, compila a `dist/` con `tsc`, se corre con `node --test dist/<ruta>.test.js` (patrón existente del repo). En el worktree, enlazar `node_modules` del checkout principal para tener `tsc` (`ln -sfn <main>/app/node_modules app/node_modules`).
- Node.js 20+.

## Review Focus

- **Cert ausente o ilegible** → el server arranca en http (no crashea). → test puro en Task 1 (ruta null) + wiring en Task 4.
- **Petición http:// al puerto con TLS** → falla la conexión (no hay downgrade en el mismo puerto). Esperado y documentado; sin test (comportamiento de red).
- **WebSocket `wss` sobre TLS** (WiFi Radar, Aircraft Radar, DOOM) → siguen conectando. → verificación manual en Task 5.
- **QR de DOOM tras el flip** → el celular debe alcanzarlo por `https` (con advertencia de cert), no `http`. → test puro en Task 2 + manual en Task 5.
- **Cámara por https desde un dispositivo cliente** (Mac y celular) → `getUserMedia` funciona. → verificación manual en Task 5.

---

### Task 1: Helper puro de opciones TLS (`tls-options.ts`)

**Files:**
- Create: `app/src/device/tls-options.ts`
- Test: `app/src/device/tls-options.test.ts`

**Interfaces:**
- Consumes: `fs`.
- Produces: `resolveTlsOptions(certDir: string, fsMod?: typeof fs): { key: Buffer; cert: Buffer } | null` (lee `key.pem`+`cert.pem`; null si falta/ilegible/vacío; nunca lanza). `urlScheme(hasTls: boolean): "https" | "http"`.

- [ ] **Step 1: Enlazar node_modules en el worktree (para tsc)**

```bash
ln -sfn "$(git rev-parse --git-common-dir)/../app/node_modules" app/node_modules || \
  ln -sfn /Users/cesar/projects/akbal-pi/app/node_modules app/node_modules
```
(Si ya existe, no pasa nada.)

- [ ] **Step 2: Escribir el test que falla**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveTlsOptions, urlScheme } from "./tls-options";

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "av-tls-")); }

test("resolveTlsOptions devuelve null si el directorio no tiene cert", () => {
  assert.equal(resolveTlsOptions(tmpDir()), null);
});

test("resolveTlsOptions devuelve {key,cert} si ambos existen y no están vacíos", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "key.pem"), "KEY");
  fs.writeFileSync(path.join(d, "cert.pem"), "CERT");
  const r = resolveTlsOptions(d);
  assert.ok(r);
  assert.equal(r.key.toString(), "KEY");
  assert.equal(r.cert.toString(), "CERT");
});

test("resolveTlsOptions devuelve null si falta uno o está vacío", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "key.pem"), "KEY"); // falta cert
  assert.equal(resolveTlsOptions(d), null);
  fs.writeFileSync(path.join(d, "cert.pem"), ""); // cert vacío
  assert.equal(resolveTlsOptions(d), null);
});

test("urlScheme", () => {
  assert.equal(urlScheme(true), "https");
  assert.equal(urlScheme(false), "http");
});
```

- [ ] **Step 3: Compilar y correr el test — verificar que falla**

Run: `cd app && npx tsc && node --test dist/device/tls-options.test.js`
Expected: FAIL (`Cannot find module './tls-options'` — el módulo no existe).

- [ ] **Step 4: Implementar `tls-options.ts`**

```ts
import fs from "fs";
import path from "path";

export type TlsOptions = { key: Buffer; cert: Buffer };

// Reads a self-signed key/cert pair from certDir. Returns null if either file
// is missing, empty, or unreadable, so the server falls back to plain http
// (dev, or a device where the cert was never generated). Never throws.
export function resolveTlsOptions(certDir: string, fsMod: typeof fs = fs): TlsOptions | null {
  try {
    const key = fsMod.readFileSync(path.join(certDir, "key.pem"));
    const cert = fsMod.readFileSync(path.join(certDir, "cert.pem"));
    if (key.length > 0 && cert.length > 0) return { key, cert };
    return null;
  } catch {
    return null;
  }
}

export function urlScheme(hasTls: boolean): "https" | "http" {
  return hasTls ? "https" : "http";
}
```

- [ ] **Step 5: Recompilar y correr — verificar que pasa**

Run: `cd app && npx tsc && node --test dist/device/tls-options.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add app/src/device/tls-options.ts app/src/device/tls-options.test.ts
git commit -m "feat(web-https): helper puro de opciones TLS (cert/llave + esquema)"
```

---

### Task 2: Esquema http/https en la URL del QR de DOOM (`doom-mode.ts`)

**Files:**
- Modify: `app/src/core/chat-flow/doom-mode.ts:49-58` (`doomScreenUrl`), `:164-173` (`resolveDoomScreenUrl`)
- Test: `app/src/core/chat-flow/doom-mode.test.ts` (añadir casos)

**Interfaces:**
- Consumes: `urlScheme` no se usa aquí; el esquema entra como parámetro.
- Produces: `doomScreenUrl(input: { tailscaleHost; apActive; lanIp; port; scheme?: "http"|"https" })` — default `"http"`. `resolveDoomScreenUrl(port: number, scheme?: "http"|"https"): Promise<string>` — default `"http"`.

- [ ] **Step 1: Añadir el test que falla**

```ts
// Añadir a doom-mode.test.ts, junto a los casos existentes:
test("doomScreenUrl usa https cuando se le pasa scheme", () => {
  assert.equal(
    doomScreenUrl({ tailscaleHost: "tailnet-host.example.ts.net", apActive: false, lanIp: "203.0.113.5", port: 8090, scheme: "https" }),
    "https://tailnet-host.example.ts.net:8090/doom",
  );
  assert.equal(
    doomScreenUrl({ tailscaleHost: null, apActive: true, lanIp: "203.0.113.5", port: 8090, scheme: "https" }),
    "https://10.42.0.1:8090/doom",
  );
});
```

- [ ] **Step 2: Compilar y correr — verificar que falla**

Run: `cd app && npx tsc && node --test dist/core/chat-flow/doom-mode.test.js`
Expected: FAIL (devuelve `http://...`, el parámetro `scheme` aún no existe).

- [ ] **Step 3: Implementar el esquema**

Reemplazar `doomScreenUrl` (líneas 49-58) por:

```ts
export function doomScreenUrl(input: {
  tailscaleHost: string | null;
  apActive: boolean;
  lanIp: string | null;
  port: number;
  scheme?: "http" | "https";
}): string {
  const s = input.scheme ?? "http";
  if (input.tailscaleHost) return `${s}://${input.tailscaleHost}:${input.port}/doom`;
  if (input.apActive) return `${s}://10.42.0.1:${input.port}/doom`;
  return `${s}://${input.lanIp ?? "127.0.0.1"}:${input.port}/doom`;
}
```

Y `resolveDoomScreenUrl` (líneas 164-173) para propagar el esquema:

```ts
export async function resolveDoomScreenUrl(port: number, scheme: "http" | "https" = "http"): Promise<string> {
  const net = await getNetworkInfo(port).catch(() => null);
  const ap = await getApStatus().catch(() => null);
  return doomScreenUrl({
    tailscaleHost: net?.tailscaleFqdn ?? null,
    apActive: ap?.active ?? false,
    lanIp: net?.lanIp ?? null,
    port,
    scheme,
  });
}
```

- [ ] **Step 4: Recompilar y correr — verificar que pasa**

Run: `cd app && npx tsc && node --test dist/core/chat-flow/doom-mode.test.js`
Expected: PASS (los casos previos + los 2 nuevos). El default `"http"` mantiene verdes los tests existentes.

- [ ] **Step 5: Commit**

```bash
git add app/src/core/chat-flow/doom-mode.ts app/src/core/chat-flow/doom-mode.test.ts
git commit -m "feat(web-https): doomScreenUrl/resolveDoomScreenUrl aceptan esquema http/https"
```
(Solo fuentes `.ts`: el `.test.js` vive en `dist/`, gitignored.)

---

### Task 3: Script de generación del cert auto-firmado

**Files:**
- Create: `app/scripts/gen-tls-cert.sh`
- Modify: `app/install_dependencies.sh` (llamar al script cerca del final)

**Interfaces:**
- Consumes: `openssl`, opcionalmente `tailscale` y `hostname`.
- Produces: `data/tls/key.pem` + `data/tls/cert.pem` (gitignored). Idempotente: no regenera si ya existen.

- [ ] **Step 1: Crear `app/scripts/gen-tls-cert.sh`**

```bash
#!/usr/bin/env bash
# Self-signed TLS cert for the Akbal web admin so getUserMedia (camera) works
# over https from any device on the tailnet / direct-AP, not just localhost.
# Idempotent: regenerates only if missing. cert/key live under data/tls/
# (gitignored). The browser shows a one-time "not trusted" warning per device.
set -euo pipefail
cd "$(dirname "$0")/.."   # app/
TLS_DIR="${WEB_ADMIN_TLS_DIR:-data/tls}"
mkdir -p "$TLS_DIR"
if [ -s "$TLS_DIR/cert.pem" ] && [ -s "$TLS_DIR/key.pem" ]; then
  echo "[tls] cert already present in $TLS_DIR — skipping"
  exit 0
fi
HOST="$(hostname)"
SANS="DNS:localhost,DNS:${HOST},DNS:${HOST}.local,IP:127.0.0.1"
if command -v tailscale >/dev/null 2>&1; then
  TS_DNS="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName":"\([^"]*\)\.".*/\1/p' | head -1)"
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1)"
  [ -n "${TS_DNS:-}" ] && SANS="$SANS,DNS:$TS_DNS"
  [ -n "${TS_IP:-}" ] && SANS="$SANS,IP:$TS_IP"
fi
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" \
  -subj "/CN=${HOST}" -addext "subjectAltName=${SANS}"
chmod 600 "$TLS_DIR/key.pem"
echo "[tls] generated self-signed cert in $TLS_DIR (SANs: $SANS)"
```

- [ ] **Step 2: Hacerlo ejecutable y probarlo**

Run:
```bash
chmod +x app/scripts/gen-tls-cert.sh
WEB_ADMIN_TLS_DIR=/tmp/av-tls-test bash app/scripts/gen-tls-cert.sh
openssl x509 -in /tmp/av-tls-test/cert.pem -noout -subject -ext subjectAltName
```
Expected: genera `key.pem`+`cert.pem`; `openssl x509` imprime el subject y los SAN (incluye `localhost` y `127.0.0.1`). Correr de nuevo imprime "skipping". Limpieza: `rm -rf /tmp/av-tls-test`.

- [ ] **Step 3: Enganchar en `install_dependencies.sh`**

Añadir cerca del final de `app/install_dependencies.sh` (antes del mensaje de cierre):

```bash
# Generate the self-signed TLS cert for the web admin (https → camera works
# off-localhost). Non-fatal: if openssl is missing the server falls back to http.
bash scripts/gen-tls-cert.sh || echo "[tls] cert generation skipped (openssl missing?)"
```

- [ ] **Step 4: Verificar sintaxis del instalador**

Run: `bash -n app/install_dependencies.sh && echo "bash OK"`
Expected: `bash OK`.

- [ ] **Step 5: Commit**

```bash
git add app/scripts/gen-tls-cert.sh app/install_dependencies.sh
git commit -m "feat(web-https): script idempotente de cert auto-firmado + hook en install_dependencies"
```

---

### Task 4: Arrancar el server como https cuando hay cert (`web-admin-server.ts`)

**Files:**
- Modify: `app/src/device/web-admin-server.ts` (imports; `start()` ~2440; log ~2517; `refreshDoomUrl` ~2521; nuevo campo `tlsEnabled`)

**Interfaces:**
- Consumes: `resolveTlsOptions`, `urlScheme` (Task 1); `resolveDoomScreenUrl(port, scheme)` (Task 2).
- Produces: el server escucha https si hay cert, http si no. `this.server` sigue tipado `http.Server | null` (https.Server es asignable).

- [ ] **Step 1: Añadir imports**

En la cabecera de imports de `web-admin-server.ts`:

```ts
import https from "https";
import { resolveTlsOptions, urlScheme } from "./tls-options";
```
(`import http from "http"` ya existe.)

- [ ] **Step 2: Añadir el campo `tlsEnabled`** junto a `private server: http.Server | null = null;`

```ts
  private tlsEnabled = false;
```

- [ ] **Step 3: Elegir https/http en `start()`**

Reemplazar la línea `this.server = http.createServer(this.app.callback());` por:

```ts
    const tlsDir = process.env.WEB_ADMIN_TLS_DIR || path.resolve(__dirname, "../..", "data", "tls");
    const tls = resolveTlsOptions(tlsDir);
    this.tlsEnabled = !!tls;
    this.server = tls
      ? https.createServer(tls, this.app.callback())
      : http.createServer(this.app.callback());
```

- [ ] **Step 4: Log con el esquema correcto**

Reemplazar la línea del log de `listen`:

```ts
      console.log(`[WebAdmin] Listening on ${urlScheme(this.tlsEnabled)}://0.0.0.0:${this.port}`);
```

- [ ] **Step 5: Propagar el esquema al QR de DOOM**

En `refreshDoomUrl`, pasar el esquema:

```ts
  private refreshDoomUrl(): void {
    resolveDoomScreenUrl(this.port, urlScheme(this.tlsEnabled))
      .then((url) => {
        this.doomUrl = url;
      })
      .catch(() => {});
  }
```

- [ ] **Step 6: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: sin errores. (Si `tsc` se queja de que `https.Server` no es `http.Server`, no debería: `https.Server extends http.Server`. Si ocurriera, ampliar el tipo a `http.Server | https.Server | null`.)

- [ ] **Step 7: Commit**

```bash
git add app/src/device/web-admin-server.ts
git commit -m "feat(web-https): el admin arranca como https cuando hay cert (fallback http), wss y QR de DOOM incluidos"
```

---

### Task 5: Deploy a la Pi + verificación manual

**Files:** ninguno (deploy/verificación).

**Interfaces:** consume todo lo anterior.

- [ ] **Step 1: Suite completa en el worktree antes de desplegar**

Run: `cd app && npx tsc && node --test dist/device/tls-options.test.js dist/core/chat-flow/doom-mode.test.js`
Expected: PASS (tls-options 4 + doom-mode previos + 2 nuevos).

- [ ] **Step 2: Merge a main + push** (vía superpowers:finishing-a-development-branch al cerrar el plan). Luego en la Pi:

```bash
ssh <usuario>@<host-de-la-pi>
whisplay update            # git pull + install_dependencies.sh (genera el cert) + build
whisplay service restart
```

- [ ] **Step 3: Verificación manual (requiere la Pi + un dispositivo con cámara)**

Expected:
- Log del servicio: `[WebAdmin] Listening on https://0.0.0.0:<puerto>` (si el cert se generó).
- Desde la Mac y desde el celular, abrir `https://akbal-pi.<tailnet>:<puerto>/akbal-vision/` (y por WiFi directo `https://10.42.0.1:<puerto>/akbal-vision/`): el navegador muestra la advertencia de cert auto-firmado una vez → aceptar → la página pide cámara → HUD sigue el rostro.
- WiFi Radar y Aircraft Radar (que usan WebSocket) siguen funcionando (ahora `wss`).
- El QR de DOOM en la pantalla del dispositivo ahora codifica `https://…` y el celular lo abre (con la advertencia una vez).
- Si se borra `data/tls/` y se reinicia, el server vuelve a `http` sin crashear (log con `http://`).

- [ ] **Step 4: Ledger de la verificación manual** (en el progreso del plan: qué se confirmó en la Pi; lo que no se pueda verificar en sesión queda como PENDIENTE USUARIO).

---

## Notas de cierre

- **Es un cambio que afecta a TODO el admin**, no solo a Akbal Vision: tras desplegar, todos acceden por `https://…:<puerto>` y el `http://` plano deja de responder en ese puerto (aceptado en el spec). Hay que avisar/actualizar bookmarks.
- La advertencia de cert auto-firmado es por-dispositivo, una vez. Un cert válido sin advertencia (Tailscale `serve`) queda fuera de alcance de este plan.
- Los demás ítems del Hito 3 del spec (modos HIGH/BALANCED/LOW, overlay de debug, kiosk) no son parte de este plan; son un bloque aparte.
