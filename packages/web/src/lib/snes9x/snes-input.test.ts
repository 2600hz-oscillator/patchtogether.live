// packages/web/src/lib/snes9x/snes-input.test.ts
//
// Pure unit tests for the SNES gamepad → joypad-mask mapping.

import { describe, it, expect } from 'vitest';
import {
  RETRO_JOYPAD,
  SNES_BUTTONS,
  buttonBit,
  buildInputMask,
} from './snes-input';

describe('SNES_BUTTONS', () => {
  it('exposes all 12 SNES buttons', () => {
    expect(SNES_BUTTONS).toHaveLength(12);
    expect(new Set(SNES_BUTTONS).size).toBe(12);
    for (const b of ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select']) {
      expect(SNES_BUTTONS).toContain(b);
    }
  });
});

describe('buttonBit — RETRO_DEVICE_ID_JOYPAD layout', () => {
  it('maps each button to the correct libretro bit', () => {
    expect(buttonBit('b')).toBe(RETRO_JOYPAD.B);
    expect(buttonBit('y')).toBe(RETRO_JOYPAD.Y);
    expect(buttonBit('select')).toBe(RETRO_JOYPAD.SELECT);
    expect(buttonBit('start')).toBe(RETRO_JOYPAD.START);
    expect(buttonBit('up')).toBe(RETRO_JOYPAD.UP);
    expect(buttonBit('down')).toBe(RETRO_JOYPAD.DOWN);
    expect(buttonBit('left')).toBe(RETRO_JOYPAD.LEFT);
    expect(buttonBit('right')).toBe(RETRO_JOYPAD.RIGHT);
    expect(buttonBit('a')).toBe(RETRO_JOYPAD.A);
    expect(buttonBit('x')).toBe(RETRO_JOYPAD.X);
    expect(buttonBit('l')).toBe(RETRO_JOYPAD.L);
    expect(buttonBit('r')).toBe(RETRO_JOYPAD.R);
  });

  it('all bits are distinct', () => {
    const bits = SNES_BUTTONS.map(buttonBit);
    expect(new Set(bits).size).toBe(bits.length);
  });
});

describe('buildInputMask', () => {
  it('empty → 0', () => {
    expect(buildInputMask({})).toBe(0);
  });

  it('single button sets just its bit', () => {
    expect(buildInputMask({ right: true })).toBe(1 << RETRO_JOYPAD.RIGHT);
    expect(buildInputMask({ a: true })).toBe(1 << RETRO_JOYPAD.A);
  });

  it('combines multiple held buttons (run-right + jump)', () => {
    const mask = buildInputMask({ right: true, b: true, y: true });
    expect(mask & (1 << RETRO_JOYPAD.RIGHT)).toBeTruthy();
    expect(mask & (1 << RETRO_JOYPAD.B)).toBeTruthy();
    expect(mask & (1 << RETRO_JOYPAD.Y)).toBeTruthy();
    expect(mask & (1 << RETRO_JOYPAD.A)).toBeFalsy();
  });

  it('falsy entries are not held', () => {
    expect(buildInputMask({ a: false, b: undefined })).toBe(0);
  });
});
