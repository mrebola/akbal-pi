import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "./events.js";

test("emit entrega el payload a los listeners suscritos", () => {
  const bus = createEventBus();
  const seen = [];
  bus.on("subject.created", (p) => seen.push(p));
  bus.emit("subject.created", { id: "SUBJ-0001" });
  assert.deepEqual(seen, [{ id: "SUBJ-0001" }]);
});

test("off quita el listener y on() devuelve un desuscriptor", () => {
  const bus = createEventBus();
  let n = 0;
  const fn = () => { n++; };
  const unsub = bus.on("x", fn);
  bus.emit("x"); unsub(); bus.emit("x");
  bus.on("y", fn); bus.off("y", fn); bus.emit("y");
  assert.equal(n, 1);
});

test("emit sin listeners no lanza", () => {
  const bus = createEventBus();
  assert.doesNotThrow(() => bus.emit("nadie", 123));
});

test("múltiples listeners del mismo tipo reciben todos", () => {
  const bus = createEventBus();
  let a = 0, b = 0;
  bus.on("e", () => a++); bus.on("e", () => b++);
  bus.emit("e");
  assert.equal(a, 1); assert.equal(b, 1);
});
