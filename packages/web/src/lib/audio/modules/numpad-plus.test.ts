// packages/web/src/lib/audio/modules/numpad-plus.test.ts
//
// Pure-function coverage for NUMPAD+ — module def shape, default
// keymap, the midiForKey + quantizeToNearestStep helpers, and the
// layer-data coercion machinery. Audio + keyboard interaction is
// covered by e2e/tests/numpad-plus.spec.ts.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYMAP,
  OCTAVE_UP_KEY,
  OCTAVE_DOWN_KEY,
  OCTAVE_UP_ACTION,
  OCTAVE_DOWN_ACTION,
  midiForKey,
  quantizeToNearestStep,
  defaultLayer,
  defaultLayers,
  coerceLayers,
  resolveActiveLayer,
  NUMPAD_PLUS_LAYERS,
  NUMPAD_PLUS_STEPS,
  keyCodeLabel,
  codeForSemitone,
  remapKeymap,
  heldNotesForStep,
  lowestNote,
  stepVoices,
} from './numpad-plus';

describe('numpadPlus: keymap remap helpers', () => {
  it('keyCodeLabel renders numpad / digit / letter / punctuation codes', () => {
    expect(keyCodeLabel('Numpad5')).toBe('5');
    expect(keyCodeLabel('NumpadDivide')).toBe('/');
    expect(keyCodeLabel('NumpadMultiply')).toBe('*');
    expect(keyCodeLabel('Digit7')).toBe('7');
    expect(keyCodeLabel('KeyQ')).toBe('Q');
    expect(keyCodeLabel('Slash')).toBe('/');
    expect(keyCodeLabel('Comma')).toBe(',');
    expect(keyCodeLabel('Space')).toBe('␣');
    expect(keyCodeLabel('F5')).toBe('F5');
    // Unknown codes fall back to the raw code (never empty).
    expect(keyCodeLabel('IntlBackslash')).toBe('IntlBackslash');
  });

  it('codeForSemitone finds the physical key bound to a note', () => {
    expect(codeForSemitone(DEFAULT_KEYMAP, 0)).toBe('Numpad1');   // C
    expect(codeForSemitone(DEFAULT_KEYMAP, 11)).toBe('NumpadMultiply'); // B
    expect(codeForSemitone({}, 0)).toBeNull();
  });

  it('remapKeymap binds a new key to a note and frees the note’s old key', () => {
    const next = remapKeymap(DEFAULT_KEYMAP, 'KeyA', 0); // C → A
    expect(next['KeyA']).toBe(0);
    expect(next['Numpad1']).toBeUndefined(); // old C key released
    // every other mapping survives
    expect(next['Numpad2']).toBe(1);
  });

  it('remapKeymap keeps one note per key (rebinding a key moves it)', () => {
    // Numpad2 currently = C# (1). Rebind it to C (0): it should now be 0,
    // and the previous C key (Numpad1) should be freed.
    const next = remapKeymap(DEFAULT_KEYMAP, 'Numpad2', 0);
    expect(next['Numpad2']).toBe(0);
    expect(next['Numpad1']).toBeUndefined();
    // C# (1) now has no key (its only key was reassigned).
    expect(codeForSemitone(next, 1)).toBeNull();
  });

  it('remapKeymap result keeps midiForKey working for the new binding', () => {
    const next = remapKeymap(DEFAULT_KEYMAP, 'KeyZ', 4); // E → Z
    // octave 4, no modifier → E4 = (4+1)*12 + 4 = 64
    expect(midiForKey('KeyZ', 4, 0, next)).toBe(64);
    expect(midiForKey('Numpad5', 4, 0, next)).toBeNull(); // old E key freed
  });
});

describe('DEFAULT_KEYMAP', () => {
  it('maps 12 numpad keys to chromatic semitones 0..11', () => {
    const notes = Object.entries(DEFAULT_KEYMAP).filter(([, v]) => v <= 11);
    expect(notes.length).toBe(12);
    const sorted = notes.sort((a, b) => a[1] - b[1]);
    expect(sorted.map(([_, v]) => v)).toEqual([0,1,2,3,4,5,6,7,8,9,10,11]);
  });

  it('maps Numpad1 → C and NumpadMultiply → B', () => {
    expect(DEFAULT_KEYMAP.Numpad1).toBe(0);
    expect(DEFAULT_KEYMAP.NumpadMultiply).toBe(11);
  });

  it('default-maps numpad + / − to the octave up / down ACTIONS (remappable keys)', () => {
    expect(OCTAVE_UP_KEY).toBe('NumpadAdd');
    expect(OCTAVE_DOWN_KEY).toBe('NumpadSubtract');
    expect(DEFAULT_KEYMAP[OCTAVE_UP_KEY]).toBe(OCTAVE_UP_ACTION);
    expect(DEFAULT_KEYMAP[OCTAVE_DOWN_KEY]).toBe(OCTAVE_DOWN_ACTION);
    // Action sentinels sit OUTSIDE the 0..11 note range.
    expect(OCTAVE_UP_ACTION).toBeGreaterThan(11);
    expect(OCTAVE_DOWN_ACTION).toBeGreaterThan(11);
  });

  it('octave actions are remappable via the same bijection as notes', () => {
    const next = remapKeymap(DEFAULT_KEYMAP, 'ArrowUp', OCTAVE_UP_ACTION); // OCT↑ → ↑
    expect(next.ArrowUp).toBe(OCTAVE_UP_ACTION);
    expect(next.NumpadAdd).toBeUndefined();       // old OCT↑ key freed
    expect(codeForSemitone(next, OCTAVE_UP_ACTION)).toBe('ArrowUp');
  });
});

describe('midiForKey', () => {
  it('Numpad1 at octave 4, no modifier → C4 (MIDI 60)', () => {
    expect(midiForKey('Numpad1', 4, 0)).toBe(60);
  });

  it('NumpadMultiply at octave 4 → B4 (MIDI 71)', () => {
    expect(midiForKey('NumpadMultiply', 4, 0)).toBe(71);
  });

  it('Numpad1 with Numpad+ held at octave 4 → C5 (MIDI 72)', () => {
    expect(midiForKey('Numpad1', 4, 1)).toBe(72);
  });

  it('Numpad1 with Numpad- held at octave 4 → C3 (MIDI 48)', () => {
    expect(midiForKey('Numpad1', 4, -1)).toBe(48);
  });

  it('returns null for keys not in the keymap', () => {
    expect(midiForKey('KeyA', 4, 0)).toBeNull();
    expect(midiForKey('NumpadEnter', 4, 0)).toBeNull();
    // NumpadAdd/Subtract ARE in the keymap now (octave ACTIONS, sentinel
    // values ≥12) — midiForKey must still return null since they're not notes.
    expect(midiForKey('NumpadAdd', 4, 0)).toBeNull();
    expect(midiForKey('NumpadSubtract', 4, 0)).toBeNull();
  });

  it('clamps octave to 0..8', () => {
    // Octave 0 → C0 = MIDI 12.
    expect(midiForKey('Numpad1', 0, 0)).toBe(12);
    // Octave 8 → C8 = MIDI 108.
    expect(midiForKey('Numpad1', 8, 0)).toBe(108);
    // Negative octave clamps to 0.
    expect(midiForKey('Numpad1', -5, 0)).toBe(12);
    // Octave 99 clamps to 8.
    expect(midiForKey('Numpad1', 99, 0)).toBe(108);
  });

  it('honors a custom keymap override', () => {
    const custom = { Numpad1: 6 }; // map 1 to F#
    expect(midiForKey('Numpad1', 4, 0, custom)).toBe(66); // F#4
    expect(midiForKey('Numpad2', 4, 0, custom)).toBeNull(); // not in custom map
  });
});

describe('quantizeToNearestStep', () => {
  it('keystroke before step midpoint records to CURRENT step', () => {
    // Step 5 starts at t=2.0s, lasts 0.5s. Midpoint = 2.25s.
    expect(quantizeToNearestStep(2.10, 5, 2.0, 0.5)).toBe(5);
    expect(quantizeToNearestStep(2.24, 5, 2.0, 0.5)).toBe(5);
  });

  it('keystroke at or after midpoint records to NEXT step', () => {
    expect(quantizeToNearestStep(2.25, 5, 2.0, 0.5)).toBe(6);
    expect(quantizeToNearestStep(2.45, 5, 2.0, 0.5)).toBe(6);
  });

  it('wraps step 15 → 0', () => {
    expect(quantizeToNearestStep(0.30, 15, 0, 0.5)).toBe(0);
  });

  it('returns current step if duration is zero (defensive)', () => {
    expect(quantizeToNearestStep(0, 7, 0, 0)).toBe(7);
    expect(quantizeToNearestStep(0, 7, 0, -1)).toBe(7);
  });
});

describe('poly: heldNotesForStep / lowestNote / stepVoices', () => {
  it('heldNotesForStep de-dups, sorts ascending, and caps at 5 (keeps lowest)', () => {
    expect(heldNotesForStep([67, 60, 64])).toEqual([60, 64, 67]);
    expect(heldNotesForStep([60, 60, 64])).toEqual([60, 64]); // de-dup
    // 6 held → keep the lowest 5.
    expect(heldNotesForStep([72, 71, 60, 62, 64, 65])).toEqual([60, 62, 64, 65, 71]);
    expect(heldNotesForStep([])).toEqual([]);
  });
  it('lowestNote returns the minimum, or null when empty', () => {
    expect(lowestNote([67, 60, 64])).toBe(60);
    expect(lowestNote([60])).toBe(60);
    expect(lowestNote([])).toBeNull();
  });
  it('stepVoices: poly notes if present, else the single midi, else empty', () => {
    expect(stepVoices({ on: true, midi: 60, midis: [60, 64, 67] })).toEqual([60, 64, 67]);
    expect(stepVoices({ on: true, midi: 60 })).toEqual([60]);          // mono step
    expect(stepVoices({ on: false, midi: 60, midis: [60, 64] })).toEqual([]); // off
    expect(stepVoices({ on: true, midi: null })).toEqual([]);          // on but empty
  });
});

describe('layer data coercion', () => {
  it('defaultLayer is 16 all-off steps', () => {
    const l = defaultLayer();
    expect(l.length).toBe(NUMPAD_PLUS_STEPS);
    for (const s of l) expect(s).toEqual({ on: false, midi: null });
  });

  it('defaultLayers is 4 default layers', () => {
    const ls = defaultLayers();
    expect(ls.length).toBe(NUMPAD_PLUS_LAYERS);
    for (const l of ls) expect(l.length).toBe(NUMPAD_PLUS_STEPS);
  });

  it('coerceLayers fills missing layers with defaults', () => {
    const raw = [
      [{ on: true, midi: 60 }, { on: false, midi: null }],
      // ... only the first layer has data + only 2 steps.
    ];
    const out = coerceLayers(raw);
    expect(out.length).toBe(NUMPAD_PLUS_LAYERS);
    expect(out[0]!.length).toBe(NUMPAD_PLUS_STEPS);
    expect(out[0]![0]).toEqual({ on: true, midi: 60 });
    // Step 1 was {on:false, midi:null} — preserved.
    expect(out[0]![1]).toEqual({ on: false, midi: null });
    // Step 2..15 default-filled.
    for (let s = 2; s < NUMPAD_PLUS_STEPS; s++) {
      expect(out[0]![s]).toEqual({ on: false, midi: null });
    }
    // Layers 1..3 fully default.
    for (let l = 1; l < NUMPAD_PLUS_LAYERS; l++) {
      for (const s of out[l]!) expect(s).toEqual({ on: false, midi: null });
    }
  });

  it('coerceLayers rejects non-array input', () => {
    expect(coerceLayers(undefined)).toEqual(defaultLayers());
    expect(coerceLayers(null)).toEqual(defaultLayers());
    expect(coerceLayers({})).toEqual(defaultLayers());
    expect(coerceLayers('nope')).toEqual(defaultLayers());
  });
});

describe('resolveActiveLayer', () => {
  it('CV input wins when patched', () => {
    // cv=0   → layer 0 (round 0*4)
    expect(resolveActiveLayer(2, 0)).toBe(0);
    // cv=0.25 → round(1.0) = 1
    expect(resolveActiveLayer(2, 0.25)).toBe(1);
    // cv=0.5 → round(2.0) = 2
    expect(resolveActiveLayer(2, 0.5)).toBe(2);
    // cv=0.75 → round(3.0) = 3
    expect(resolveActiveLayer(2, 0.75)).toBe(3);
    // cv=1.0 → round(4) = 4 → clamp 3
    expect(resolveActiveLayer(2, 1.0)).toBe(3);
  });

  it('param wins when CV input is null', () => {
    expect(resolveActiveLayer(0, null)).toBe(0);
    expect(resolveActiveLayer(1, null)).toBe(1);
    expect(resolveActiveLayer(2, null)).toBe(2);
    expect(resolveActiveLayer(3, null)).toBe(3);
  });

  it('clamps to 0..3', () => {
    expect(resolveActiveLayer(-1, null)).toBe(0);
    expect(resolveActiveLayer(99, null)).toBe(3);
    expect(resolveActiveLayer(0, -0.5)).toBe(0);
    expect(resolveActiveLayer(0, 2)).toBe(3);
  });
});
