// packages/dsp/src/lib/seq-voicing.test.ts
//
// Pins the ported sequencer voicing (mono/maj/min → 5 V/oct lanes) so it stays
// faithful to packages/web/src/lib/audio/poly.ts (the source of truth — see the
// header in seq-voicing.ts). If poly.ts's chordVoicing ever changes, update both
// and this test.

import { describe, it, expect } from 'vitest';
import {
  chordLanesVOct,
  midiToVOct,
  SEQ_POLY_LANES,
  SEQ_MAX_MIDI,
} from './seq-voicing';

describe('midiToVOct (C4=60 ⇒ 0 V, 1 V/oct)', () => {
  it('maps the reference notes', () => {
    expect(midiToVOct(60)).toBe(0);
    expect(midiToVOct(72)).toBeCloseTo(1);
    expect(midiToVOct(48)).toBeCloseTo(-1);
    expect(midiToVOct(63)).toBeCloseTo(0.25);
  });
});

describe('chordLanesVOct', () => {
  it('returns 5 silent lanes for a null / rest root', () => {
    const lanes = chordLanesVOct(null, 'maj', 0);
    expect(lanes).toHaveLength(SEQ_POLY_LANES);
    expect(lanes.every((l) => l.gate === 0)).toBe(true);
  });

  it('returns silent for an out-of-range root', () => {
    expect(chordLanesVOct(200, 'maj', 0).every((l) => l.gate === 0)).toBe(true);
    expect(chordLanesVOct(0, 'maj', 0).every((l) => l.gate === 0)).toBe(true);
  });

  it('mono = root on lane 0, rest silent', () => {
    const l = chordLanesVOct(60, 'mono', 0);
    expect(l[0]).toEqual({ pitch: 0, gate: 1 }); // C4
    expect(l.slice(1).every((x) => x.gate === 0)).toBe(true);
  });

  it('maj triad = root / major-third / fifth / octave', () => {
    const l = chordLanesVOct(60, 'maj', 0); // C4 major
    expect(l[0]).toEqual({ pitch: 0, gate: 1 }); // C4
    expect(l[1].gate).toBe(1);
    expect(l[1].pitch).toBeCloseTo(4 / 12); // E4
    expect(l[2].pitch).toBeCloseTo(7 / 12); // G4
    expect(l[3].pitch).toBeCloseTo(1); // C5 (root + octave)
    expect(l[4].gate).toBe(0); // 5th lane unused for a triad
  });

  it('min triad uses a minor third (3 semis)', () => {
    const l = chordLanesVOct(60, 'min', 0); // C4 minor
    expect(l[1].pitch).toBeCloseTo(3 / 12); // Eb4
    expect(l[2].pitch).toBeCloseTo(7 / 12); // G4
  });

  it('octave param shifts every GATED lane by whole octaves (V/oct)', () => {
    const l = chordLanesVOct(60, 'maj', 1);
    expect(l[0].pitch).toBeCloseTo(1); // C4 + 1 oct
    expect(l[1].pitch).toBeCloseTo(4 / 12 + 1); // E4 + 1 oct
    expect(l[3].pitch).toBeCloseTo(2); // C5 + 1 oct
    expect(l[4]).toEqual({ pitch: 0, gate: 0 }); // silent lane unaffected
  });

  it('silences chord tones that fall above the MIDI range', () => {
    // C8 (=MAX_MIDI 108) major: third/fifth/octave all exceed 108 → silent.
    const l = chordLanesVOct(SEQ_MAX_MIDI, 'maj', 0);
    expect(l[0].gate).toBe(1); // root C8 still in range
    expect(l[0].pitch).toBeCloseTo((108 - 60) / 12); // +4 V
    expect(l[1].gate).toBe(0); // E8 out of range
    expect(l[2].gate).toBe(0);
    expect(l[3].gate).toBe(0);
  });
});
