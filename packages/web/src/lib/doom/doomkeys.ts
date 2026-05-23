// packages/web/src/lib/doom/doomkeys.ts
//
// TypeScript mirror of the doomgeneric/doomkeys.h ASCII constants that the
// engine's input layer (DG_GetKey) expects. Keeping this as a pure-data
// module (no imports) so it can be unit-tested without dragging in the
// WASM shim.

/** doomkeys.h KEY_* constants — the values DG_GetKey hands back to the
 *  engine, NOT the JS KeyboardEvent.code values. The runtime shim
 *  translates from KeyboardEvent codes / CV-gate semantic names to these
 *  via DOOM_KEY_FOR_INPUT (below) before calling dgpt_set_key. */
export const KEY_RIGHTARROW = 0xae;
export const KEY_LEFTARROW = 0xac;
export const KEY_UPARROW = 0xad;
export const KEY_DOWNARROW = 0xaf;
export const KEY_STRAFE_L = 0xa0;
export const KEY_STRAFE_R = 0xa1;
export const KEY_USE = 0xa2;
export const KEY_FIRE = 0xa3;
export const KEY_ESCAPE = 27;
export const KEY_ENTER = 13;
export const KEY_TAB = 9;
export const KEY_BACKSPACE = 0x7f;
export const KEY_SPACE = 0x20;
// KEY_RCTRL = (0x80 + 0x1d) = 0x9d. The plan calls out this exact value.
export const KEY_RCTRL = 0x9d;
// KEY_RALT = (0x80 + 0x38) = 0xb8. doomkeys.h aliases KEY_LALT = KEY_RALT.
export const KEY_RALT = 0xb8;
export const KEY_LALT = KEY_RALT;
// Shift keys (used by run modifier; doomkeys.h: KEY_RSHIFT = 0x80 + 0x36 = 0xb6).
export const KEY_RSHIFT = 0xb6;

// ASCII fallthroughs for letters in the default DOOM bindings. doomgeneric
// expects lowercase ASCII codes for these — the engine uppercases internally.
export const KEY_w = 0x77;
export const KEY_a = 0x61;
export const KEY_s = 0x73;
export const KEY_d = 0x64;
export const KEY_y = 0x79;  // menu confirm
export const KEY_n = 0x6e;  // menu cancel

// ---------------- KeyboardEvent.code → doomkey ----------------
//
// Card-focused listener gets KeyboardEvent.code strings; map them into the
// doomkeys.h constants. Layout-stable (uses physical key positions per
// the spec) so this works across QWERTY/AZERTY/Dvorak/etc.
//
// We intentionally STAY OFF the numpad keys here — those are NUMPAD+'s
// exclusive collision surface (see NUMPAD+ docs + the defensive guard
// in lib/audio/modules/numpad-plus.ts). Doom's defaults don't touch
// numpad codes, so this isn't a functional loss.
export const KEY_FOR_KEYBOARD_CODE: Readonly<Record<string, number>> = {
  // Cardinal movement (default forward/back/strafe = WASD).
  KeyW: KEY_w,
  KeyA: KEY_a,
  KeyS: KEY_s,
  KeyD: KEY_d,
  ArrowUp: KEY_UPARROW,
  ArrowDown: KEY_DOWNARROW,
  ArrowLeft: KEY_LEFTARROW,
  ArrowRight: KEY_RIGHTARROW,
  // Combat + interaction.
  Space: KEY_FIRE,        // primary fire (default DOOM binding)
  ControlRight: KEY_RCTRL, // run modifier
  ControlLeft: KEY_RCTRL,
  AltRight: KEY_RALT,      // strafe modifier
  AltLeft: KEY_RALT,
  ShiftRight: KEY_RSHIFT,
  ShiftLeft: KEY_RSHIFT,
  // Menu / system.
  Escape: KEY_ESCAPE,
  Enter: KEY_ENTER,
  Tab: KEY_TAB,
  Backspace: KEY_BACKSPACE,
  // Menu y/n.
  KeyY: KEY_y,
  KeyN: KEY_n,
  // USE (door / switch) defaults to E.
  KeyE: KEY_USE,
};

// ---------------- CV-gate port id → doomkey ----------------
//
// 7 cv-typed gate ports per the plan. The first letter / 'space' / 'ctrl' /
// 'alt' port ids map to the same KEY_* constants the keyboard listener uses
// so a patch driving CV gates feels identical to typing on the keyboard.
export const KEY_FOR_CV_GATE: Readonly<Record<string, number>> = {
  w: KEY_w,
  a: KEY_a,
  s: KEY_s,
  d: KEY_d,
  space: KEY_FIRE,
  ctrl: KEY_RCTRL,
  alt: KEY_RALT,
};

/** All cv-gate port ids the DOOM module declares (drives both the
 *  ModuleDef.inputs schema AND the CV→key mapping table). */
export const CV_GATE_PORT_IDS = ['w', 'a', 's', 'd', 'space', 'ctrl', 'alt'] as const;
export type CvGatePortId = (typeof CV_GATE_PORT_IDS)[number];
