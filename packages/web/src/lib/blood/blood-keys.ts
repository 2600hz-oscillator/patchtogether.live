// packages/web/src/lib/blood/blood-keys.ts
//
// TypeScript mirror of the NBlood / Build-engine `sc_*` SCANCODE constants
// (build/include/scancodes.h) that the engine's keyboard layer reads. The
// BLOOD analogue of doomkeys.ts. Pure-data (no imports) so it unit-tests
// without the WASM shim.
//
// NOTE: unlike DOOM (whose DG_GetKey takes ASCII-ish doomkeys), the Build
// engine's input is SCANCODE-based (KB_KeyDown[scancode] / the CONTROL layer).
// The bpt_set_key shim takes a Build scancode; these are those values.

// Movement / action scancodes (from build/include/scancodes.h).
export const SC_UP_ARROW = 0xc8;
export const SC_DOWN_ARROW = 0xd0;
export const SC_LEFT_ARROW = 0xcb;
export const SC_RIGHT_ARROW = 0xcd;
export const SC_LEFT_CONTROL = 0x1d; // default FIRE
export const SC_RIGHT_CONTROL = 0x9d;
export const SC_SPACE = 0x39; // default OPEN / USE
export const SC_LEFT_ALT = 0x38; // strafe modifier / JUMP in Blood defaults
export const SC_ENTER = 0x1c; // sc_Return
export const SC_ESCAPE = 0x01;
export const SC_TAB = 0x0f;
export const SC_Z = 0x2c; // crouch (Blood default)
export const SC_X = 0x2d;
export const SC_C = 0x2e;
// Weapon cycle: Blood binds these to the mouse-wheel / [ ] by default; for CV
// we expose the comma/period weapon prev/next bindings the engine also accepts.
export const SC_COMMA = 0x33; // weapon prev
export const SC_PERIOD = 0x34; // weapon next

// ---------------- CV-gate port id → Build scancode ----------------
//
// The Phase-1 BLOOD module exposes these semantic CV-gate inputs (single
// player — one input group, unlike DOOM's 4 per-slot groups). A rising edge on
// `up` feels like holding ArrowUp. esc/enter drive the menu. Mirrors the plan's
// port list.
export const SCANCODE_FOR_CV_GATE: Readonly<Record<string, number>> = {
  up: SC_UP_ARROW,
  down: SC_DOWN_ARROW,
  left: SC_LEFT_ARROW,
  right: SC_RIGHT_ARROW,
  fire: SC_LEFT_CONTROL,
  altfire: SC_RIGHT_CONTROL,
  use: SC_SPACE,
  jump: SC_LEFT_ALT,
  crouch: SC_Z,
  weapnext: SC_PERIOD,
  weapprev: SC_COMMA,
  esc: SC_ESCAPE,
  enter: SC_ENTER,
};

/** The base cv-gate semantic ids — drive the def's `inputs` + the edge map. */
export const CV_GATE_PORT_IDS = [
  'up', 'down', 'left', 'right',
  'fire', 'altfire', 'use', 'jump', 'crouch',
  'weapnext', 'weapprev', 'esc', 'enter',
] as const;
export type BloodCvGatePortId = (typeof CV_GATE_PORT_IDS)[number];

// ---------------- KeyboardEvent.code → Build scancode ----------------
//
// The card's focused keyboard listener maps KeyboardEvent.code → scancode.
// Layout-stable (physical positions). We stay off the numpad (NUMPAD+'s
// exclusive collision surface — same rule as doomkeys.ts).
export const SCANCODE_FOR_KEYBOARD_CODE: Readonly<Record<string, number>> = {
  ArrowUp: SC_UP_ARROW,
  ArrowDown: SC_DOWN_ARROW,
  ArrowLeft: SC_LEFT_ARROW,
  ArrowRight: SC_RIGHT_ARROW,
  KeyW: SC_UP_ARROW,
  KeyS: SC_DOWN_ARROW,
  KeyA: SC_LEFT_ARROW,
  KeyD: SC_RIGHT_ARROW,
  ControlLeft: SC_LEFT_CONTROL, // fire
  ControlRight: SC_RIGHT_CONTROL,
  Space: SC_SPACE, // use / open
  AltLeft: SC_LEFT_ALT, // jump
  AltRight: SC_LEFT_ALT,
  KeyZ: SC_Z, // crouch
  Enter: SC_ENTER,
  Escape: SC_ESCAPE,
  Tab: SC_TAB,
  Comma: SC_COMMA,
  Period: SC_PERIOD,
};
