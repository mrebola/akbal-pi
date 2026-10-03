// Logical keys the web controls and the keyboard both produce. Codes are
// values from doomkeys.h of ozkl/doomgeneric. The commit is pinned in
// fetch-doom-engine.sh (Task 4).
export const DOOM_KEYS = [
  "forward", "back", "left", "right", "strafeLeft", "strafeRight",
  "fire", "use", "run", "menu",
  "weapon1", "weapon2", "weapon3", "weapon4", "weapon5", "weapon6", "weapon7",
] as const;

export type DoomKey = (typeof DOOM_KEYS)[number];

export const KEY_CODES: Record<DoomKey, number> = {
  forward: 0xad,      // KEY_UPARROW
  back: 0xaf,         // KEY_DOWNARROW
  left: 0xac,         // KEY_LEFTARROW (turn)
  right: 0xae,        // KEY_RIGHTARROW (turn)
  strafeLeft: 0xa0,   // KEY_STRAFE_L
  strafeRight: 0xa1,  // KEY_STRAFE_R
  fire: 0xa3,         // KEY_FIRE (CTRL)
  use: 0xa2,          // KEY_USE (E / space)
  run: 0xb6,          // KEY_RSHIFT
  menu: 27,           // KEY_ESCAPE
  weapon1: 0x31,
  weapon2: 0x32,
  weapon3: 0x33,
  weapon4: 0x34,
  weapon5: 0x35,
  weapon6: 0x36,
  weapon7: 0x37,
};

// Browser KeyboardEvent.code → logical key. Space is fire and E is use, as the
// spec asks; the same map drives the on-screen buttons.
const BROWSER_TO_KEY: Record<string, DoomKey> = {
  ArrowUp: "forward", KeyW: "forward",
  ArrowDown: "back", KeyS: "back",
  ArrowLeft: "left",
  ArrowRight: "right",
  KeyA: "strafeLeft",
  KeyD: "strafeRight",
  ControlLeft: "fire", ControlRight: "fire", Space: "fire",
  KeyE: "use",
  ShiftLeft: "run", ShiftRight: "run",
  Escape: "menu",
  Digit1: "weapon1", Digit2: "weapon2", Digit3: "weapon3", Digit4: "weapon4",
  Digit5: "weapon5", Digit6: "weapon6", Digit7: "weapon7",
};

export function browserKeyToDoomKey(code: string): DoomKey | null {
  return Object.prototype.hasOwnProperty.call(BROWSER_TO_KEY, code) ? BROWSER_TO_KEY[code] : null;
}
