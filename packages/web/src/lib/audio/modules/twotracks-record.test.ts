// packages/web/src/lib/audio/modules/twotracks-record.test.ts
//
// Regression unit tests for the TWOTRACKS record-window rule
// (twotracksRecordSpan), the pure mirror of the worklet's recording window.
//
// Bug it locks: while freshly recording, the window MUST span the full physical
// buffer so the cursor advances linearly to the end. Clamping it to the still-
// growing bufLen collapses the loop window to a few ms each block, so the cursor
// loops over the last fragment → "chopped" record that stops after a moment.
// (The worklet processReel() mirrors this exact rule.)

import { describe, it, expect } from 'vitest';
import { twotracksRecordSpan, TWOTRACKS_MAX_SAMPLES } from './twotracks';

describe('twotracksRecordSpan (record window rule)', () => {
  it('fresh rec from empty spans the FULL physical buffer (not 0)', () => {
    expect(twotracksRecordSpan('rec', 0)).toBe(TWOTRACKS_MAX_SAMPLES);
  });

  it('rec NEVER clamps to the growing bufLen — the regression that caused chopped record', () => {
    // As recording writes samples bufLen grows; the window must stay = MAX so
    // the cursor keeps advancing linearly instead of looping the last fragment.
    for (const grown of [1, 128, 48_000, 1_000_000]) {
      expect(twotracksRecordSpan('rec', grown)).toBe(TWOTRACKS_MAX_SAMPLES);
    }
  });

  it('overdub loops over the recorded region (bufLen)', () => {
    expect(twotracksRecordSpan('overdub', 96_000)).toBe(96_000);
  });

  it('playback loops over the recorded region (bufLen)', () => {
    expect(twotracksRecordSpan('play', 96_000)).toBe(96_000);
  });

  it('idle with a recorded tape uses the recorded length', () => {
    expect(twotracksRecordSpan('idle', 96_000)).toBe(96_000);
  });

  it('non-rec states with an empty buffer fall back to the full buffer', () => {
    expect(twotracksRecordSpan('play', 0)).toBe(TWOTRACKS_MAX_SAMPLES);
    expect(twotracksRecordSpan('idle', 0)).toBe(TWOTRACKS_MAX_SAMPLES);
    expect(twotracksRecordSpan('armed', 0)).toBe(TWOTRACKS_MAX_SAMPLES);
  });
});
