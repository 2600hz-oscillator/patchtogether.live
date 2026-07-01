// Tests for the pure isomorphic keyboard layout + scale-lighting (design P1):
// LinnStrument chromatic fourths (col +1 semitone, row +5), octave = 2 up + 2
// across, continuous across 16 columns; note-role for LinnStrument lighting.

import { describe, it, expect } from 'vitest';
import {
  keyboardCellToMidi,
  noteRole,
  KEY_SEMIS_PER_COL,
  KEY_SEMIS_PER_ROW,
} from './keyboard-map';

describe('keyboardCellToMidi — chromatic fourths', () => {
  const root = 36; // C2
  it('bottom-left = root', () => {
    expect(keyboardCellToMidi(0, 0, root)).toBe(36);
  });
  it('column right = +1 semitone', () => {
    expect(keyboardCellToMidi(1, 0, root)).toBe(37);
    expect(keyboardCellToMidi(5, 0, root)).toBe(41);
  });
  it('row up = +5 semitones (a perfect fourth)', () => {
    expect(keyboardCellToMidi(0, 1, root)).toBe(41);
    expect(keyboardCellToMidi(0, 2, root)).toBe(46);
  });
  it('octave = 2 rows up + 2 columns right (LinnStrument invariant)', () => {
    expect(keyboardCellToMidi(2, 2, root)).toBe(root + 12); // 2*5 + 2*1 = 12
  });
  it('is continuous across the 16-wide (L|R) surface — same shape crossing the seam', () => {
    // a shape at cols 7→8 (the physical L|R seam) is just +1 semitone, unbroken.
    expect(keyboardCellToMidi(8, 0, root) - keyboardCellToMidi(7, 0, root)).toBe(1);
  });
  it('offsets are the exported LinnStrument defaults', () => {
    expect(KEY_SEMIS_PER_COL).toBe(1);
    expect(KEY_SEMIS_PER_ROW).toBe(5);
  });
});

describe('noteRole — LinnStrument lighting', () => {
  const root = 48; // C3
  it('every octave of the root = root', () => {
    expect(noteRole(48, root)).toBe('root');
    expect(noteRole(60, root)).toBe('root');
    expect(noteRole(36, root)).toBe('root');
  });
  it('chromatic (no scale): every non-root is in-scale, none out-of-scale', () => {
    expect(noteRole(49, root)).toBe('inscale');
    expect(noteRole(55, root)).toBe('inscale');
  });
  it('with a scale: out-of-scale pitches read outscale, in-scale read inscale', () => {
    // C major: E (52) in-scale; C#/Db (49) out-of-scale.
    expect(noteRole(52, root, 'major')).toBe('inscale');
    expect(noteRole(49, root, 'major')).toBe('outscale');
    // root still wins even in a scale
    expect(noteRole(60, root, 'major')).toBe('root');
  });
});
