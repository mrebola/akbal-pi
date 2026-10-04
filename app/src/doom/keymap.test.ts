import { test } from "node:test";
import assert from "node:assert/strict";
import { DOOM_KEYS, KEY_CODES, browserKeyToDoomKey } from "./keymap";

test("every logical key has a DoomGeneric code and the codes are unique", () => {
  const codes = DOOM_KEYS.map((k) => KEY_CODES[k]);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) assert.equal(typeof code, "number");
});

test("arrows and WASD both move", () => {
  assert.equal(browserKeyToDoomKey("ArrowUp"), "forward");
  assert.equal(browserKeyToDoomKey("KeyW"), "forward");
  assert.equal(browserKeyToDoomKey("ArrowLeft"), "left");
  assert.equal(browserKeyToDoomKey("KeyA"), "strafeLeft");
});

test("fire is CTRL or Space, USE is E, RUN is Shift, ESC is menu", () => {
  assert.equal(browserKeyToDoomKey("ControlLeft"), "fire");
  assert.equal(browserKeyToDoomKey("Space"), "fire");
  assert.equal(browserKeyToDoomKey("KeyE"), "use");
  assert.equal(browserKeyToDoomKey("ShiftLeft"), "run");
  assert.equal(browserKeyToDoomKey("Escape"), "menu");
});

test("Enter (and the keypad Enter) start the game from the title screen", () => {
  assert.equal(browserKeyToDoomKey("Enter"), "enter");
  assert.equal(browserKeyToDoomKey("NumpadEnter"), "enter");
  assert.equal(KEY_CODES.enter, 13);
});

test("digits 1-7 select weapons, anything else is unmapped", () => {
  assert.equal(browserKeyToDoomKey("Digit1"), "weapon1");
  assert.equal(browserKeyToDoomKey("Digit7"), "weapon7");
  assert.equal(browserKeyToDoomKey("Digit8"), null);
  assert.equal(browserKeyToDoomKey("KeyZ"), null);
});

test("prototype pollution: constructor and toString return null, not Object methods", () => {
  assert.equal(browserKeyToDoomKey("constructor"), null);
  assert.equal(browserKeyToDoomKey("toString"), null);
});
