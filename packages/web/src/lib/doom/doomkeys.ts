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
  // Combat + interaction. MacBook-friendly bindings:
  //   Space = USE (open doors / switches) — big reachable key.
  //   F     = FIRE (primary). Ctrl avoided as PRIMARY fire because macOS
  //           binds Ctrl+Arrow to Mission Control space-switching, so
  //           hold-fire-while-turning would be eaten by the OS.
  //   Ctrl / E kept as secondary fire / use for muscle memory.
  Space: KEY_USE,         // open doors / switches (standard DOOM use)
  KeyF: KEY_FIRE,         // primary fire (MacBook-safe)
  ControlRight: KEY_FIRE, // secondary fire
  ControlLeft: KEY_FIRE,
  KeyE: KEY_USE,          // secondary use
  AltRight: KEY_RALT,     // strafe modifier
  AltLeft: KEY_RALT,
  ShiftRight: KEY_RSHIFT, // run modifier
  ShiftLeft: KEY_RSHIFT,
  // Menu / system.
  Escape: KEY_ESCAPE,
  Enter: KEY_ENTER,
  Tab: KEY_TAB,
  Backspace: KEY_BACKSPACE,
  // Menu y/n.
  KeyY: KEY_y,
  KeyN: KEY_n,
};

// ---------------- CV-gate port id → doomkey ----------------
//
// 7 cv-typed gate ports per the plan. The first four (up/down/left/right)
// map to DOOM's default movement (arrow keys); space = fire, ctrl = run,
// alt = strafe. Port ids match the keyboard the user expects to be playing
// the game with — driving a CV gate at `up` feels identical to holding
// ArrowUp on the keyboard.
//
// NOTE: prior to 2026-05-24 these ports were w/a/s/d (the WASD letters).
// Renamed to up/down/left/right because DOOM's defaults map ArrowKeys, not
// WASD, to movement — patches built against the old w/a/s/d ids will
// silently lose their CV connections on load (acceptable: DOOM had only
// been live for hours).
export const KEY_FOR_CV_GATE: Readonly<Record<string, number>> = {
  up: KEY_UPARROW,
  down: KEY_DOWNARROW,
  left: KEY_LEFTARROW,
  right: KEY_RIGHTARROW,
  space: KEY_USE,
  ctrl: KEY_FIRE,
  alt: KEY_RALT,
};

/** All cv-gate port ids the DOOM module declares (drives both the
 *  ModuleDef.inputs schema AND the CV→key mapping table). */
export const CV_GATE_PORT_IDS = ['up', 'down', 'left', 'right', 'space', 'ctrl', 'alt'] as const;
export type CvGatePortId = (typeof CV_GATE_PORT_IDS)[number];
