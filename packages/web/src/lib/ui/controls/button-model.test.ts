import { describe, it, expect } from 'vitest';
import { buttonPointerFire, buttonGateFire } from './button-model';

describe('buttonPointerFire', () => {
  it('trigger fires ONCE on the press edge, nothing on release', () => {
    expect(buttonPointerFire(false, 'down')).toBe('trigger');
    expect(buttonPointerFire(false, 'up')).toBeNull();
  });
  it('momentary presses on down and releases on up (both edges)', () => {
    expect(buttonPointerFire(true, 'down')).toBe('press');
    expect(buttonPointerFire(true, 'up')).toBe('release');
  });
});

describe('buttonGateFire (MIDI note mirror)', () => {
  it('trigger fires once on note-on, ignores note-off', () => {
    expect(buttonGateFire(false, true)).toBe('trigger');
    expect(buttonGateFire(false, false)).toBeNull();
  });
  it('momentary maps note-on → press, note-off → release', () => {
    expect(buttonGateFire(true, true)).toBe('press');
    expect(buttonGateFire(true, false)).toBe('release');
  });
  it('pointer and gate resolve to the SAME action per behaviour', () => {
    // screen + MIDI must agree so a learned NOTE does what a click does.
    expect(buttonGateFire(false, true)).toBe(buttonPointerFire(false, 'down'));
    expect(buttonGateFire(true, true)).toBe(buttonPointerFire(true, 'down'));
    expect(buttonGateFire(true, false)).toBe(buttonPointerFire(true, 'up'));
  });
});
