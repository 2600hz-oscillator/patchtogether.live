// packages/web/src/lib/ui/modules/tempolock/tempolock-status-model.test.ts
//
// The status surface's strings, decided in the unit lane — they are UNPAINTED
// (aria/title only), so no VRT baseline and no human reviewing one can catch
// a wrong sentence here.

import { describe, expect, it } from 'vitest';
import type { TempolockState } from '$lib/audio/modules/tempolock';
import {
  tempolockBeatDetail,
  tempolockBeatLit,
  tempolockBpmText,
  tempolockLockDetail,
  tempolockLockLit,
} from './tempolock-status-model';

function state(over: Partial<TempolockState>): TempolockState {
  return { mode: 'cold', locked: false, bpm: null, beatRecent: false, skips: 0, ...over };
}

describe('tempolock status model', () => {
  it('the three modes produce three DIFFERENT lock sentences (dark-lamp ambiguity)', () => {
    const cold = tempolockLockDetail(state({}));
    const locked = tempolockLockDetail(state({ mode: 'locked', locked: true, bpm: 108 }));
    const coast = tempolockLockDetail(state({ mode: 'coast', bpm: 108 }));
    expect(new Set([cold, locked, coast]).size).toBe(3);
    // The value lives in the sentence — the owner's number, one decimal.
    expect(locked).toContain('108.0 BPM');
    expect(coast).toContain('108.0 BPM');
    expect(cold).not.toMatch(/\d+\.\d+ BPM/);
    // A null engine snapshot (body mounted before the node materialized)
    // reads as cold, not as a crash.
    expect(tempolockLockDetail(null)).toBe(cold);
  });

  it('lock lamp lights iff locked; beat lamp follows beatRecent', () => {
    expect(tempolockLockLit(state({ locked: true, mode: 'locked' }))).toBe(true);
    expect(tempolockLockLit(state({ mode: 'coast' }))).toBe(false);
    expect(tempolockLockLit(null)).toBe(false);
    expect(tempolockBeatLit(state({ beatRecent: true }))).toBe(true);
    expect(tempolockBeatLit(null)).toBe(false);
  });

  it('the skip counter reaches the beat detail and a zero stays quiet', () => {
    expect(tempolockBeatDetail(state({}))).not.toMatch(/\d/);
    expect(tempolockBeatDetail(state({ skips: 1 }))).toContain('1 pulse could not be scheduled');
    expect(tempolockBeatDetail(state({ skips: 3 }))).toContain('3 pulses');
    expect(tempolockBeatDetail(null)).toBe(tempolockBeatDetail(state({})));
  });

  it('one decimal of BPM — the tracker wobbles by tenths, a second decimal is noise', () => {
    expect(tempolockBpmText(103.6842)).toBe('103.7 BPM');
    expect(tempolockBpmText(108)).toBe('108.0 BPM');
  });
});
