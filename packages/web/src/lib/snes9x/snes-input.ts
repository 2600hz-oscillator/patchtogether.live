// packages/web/src/lib/snes9x/snes-input.ts
//
// PURE SNES gamepad input mapping for the SNES9X module.
//
// The module exposes the full SNES controller as 12 gate inputs (D-pad
// up/down/left/right, face A/B/X/Y, shoulder L/R, Start/Select). Each gate
// edge-detects (cv-gate-edge hysteresis) into a "held" boolean; this module
// turns the held set into the RETRO_DEVICE_ID_JOYPAD_* bitmask the WASM
// bridge's `snes_set_input(mask)` consumes.
//
// The bit layout matches libretro's RETRO_DEVICE_ID_JOYPAD_* enum (and the
// snes9x2005 core's `snes_lut`), so the mask we build is exactly what the
// core expects:
//
//   B=0  Y=1  SELECT=2  START=3  UP=4  DOWN=5  LEFT=6  RIGHT=7
//   A=8  X=9  L=10  R=11
//
// The port ids match the GAMEPAD module's gate OUTPUT ids where they
// overlap, so a user can wire GAMEPAD → SNES9X 1:1 (du→up, a→a, etc.) —
// see SNES_GATE_INPUTS below. Names are SNES-native (a/b/x/y/l/r/start/
// select/up/down/left/right) for clarity on the card.

/** RETRO_DEVICE_ID_JOYPAD bit positions. */
export const RETRO_JOYPAD = {
  B: 0,
  Y: 1,
  SELECT: 2,
  START: 3,
  UP: 4,
  DOWN: 5,
  LEFT: 6,
  RIGHT: 7,
  A: 8,
  X: 9,
  L: 10,
  R: 11,
} as const;

/** SNES button id used by the module's gate input ports. */
export type SnesButton =
  | 'up' | 'down' | 'left' | 'right'
  | 'a' | 'b' | 'x' | 'y'
  | 'l' | 'r'
  | 'start' | 'select';

/** Stable ordered list of the 12 SNES gate-input ports the module exposes. */
export const SNES_BUTTONS: readonly SnesButton[] = [
  'up', 'down', 'left', 'right',
  'b', 'a', 'y', 'x',
  'l', 'r',
  'start', 'select',
] as const;

/** Map a SNES button → its RETRO_DEVICE_ID_JOYPAD bit position. */
export function buttonBit(btn: SnesButton): number {
  switch (btn) {
    case 'b': return RETRO_JOYPAD.B;
    case 'y': return RETRO_JOYPAD.Y;
    case 'select': return RETRO_JOYPAD.SELECT;
    case 'start': return RETRO_JOYPAD.START;
    case 'up': return RETRO_JOYPAD.UP;
    case 'down': return RETRO_JOYPAD.DOWN;
    case 'left': return RETRO_JOYPAD.LEFT;
    case 'right': return RETRO_JOYPAD.RIGHT;
    case 'a': return RETRO_JOYPAD.A;
    case 'x': return RETRO_JOYPAD.X;
    case 'l': return RETRO_JOYPAD.L;
    case 'r': return RETRO_JOYPAD.R;
  }
}

/**
 * Build the joypad bitmask from a per-button "held" map. Missing / falsy
 * entries are treated as not-held. Pure: same input → same mask.
 */
export function buildInputMask(held: Partial<Record<SnesButton, boolean>>): number {
  let mask = 0;
  for (const btn of SNES_BUTTONS) {
    if (held[btn]) mask |= (1 << buttonBit(btn));
  }
  return mask;
}
