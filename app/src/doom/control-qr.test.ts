import { test } from "node:test";
import assert from "node:assert/strict";
import { controlQrFor } from "./control-qr";

const TOKEN = "0123456789abcdef0123456789abcdef";

test("without a running game the answer is 409 with the message", async () => {
  const r = await controlQrFor({ token: null, baseUrl: "http://pi.test:8090/doom" });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: "No hay juego corriendo" });
});

test("with a game, the url carries the token and qr is a PNG data URL", async () => {
  const r = await controlQrFor({ token: TOKEN, baseUrl: "http://pi.test:8090/doom" });
  assert.equal(r.status, 200);
  const body = r.body as { url: string; qr: string };
  assert.equal(body.url, `http://pi.test:8090/doom?t=${TOKEN}`);
  assert.ok(body.qr.startsWith("data:image/png"), "qr must be a PNG data URL");
});
