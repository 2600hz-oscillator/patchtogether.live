// packages/web/src/lib/video/modules/videobox-sync.test.ts
//
// Drift-correction math + sync-write builder. No DOM, no engine —
// just the pure helpers under videobox-sync.ts.

import { describe, expect, it } from 'vitest';
import {
  expectedPosition,
  decideDriftCorrection,
  buildSyncWrite,
  DRIFT_THRESHOLD_SEC,
  type VideoboxSyncState,
} from './videobox-sync';

const at = (isPlaying: boolean, lastSyncTime: number, lastSyncPosition: number): VideoboxSyncState => ({
  isPlaying,
  lastSyncTime,
  lastSyncPosition,
});

describe('expectedPosition', () => {
  it('returns lastSyncPosition exactly while paused, regardless of elapsed time', () => {
    const state = at(false, 1000, 12.5);
    expect(expectedPosition(state, 1000)).toBe(12.5);
    expect(expectedPosition(state, 50_000)).toBe(12.5);
  });

  it('extrapolates forward by wallclock elapsed while playing', () => {
    const state = at(true, 1000, 10);
    // 250 ms later, expected = 10 + 0.25 = 10.25.
    expect(expectedPosition(state, 1250)).toBeCloseTo(10.25, 6);
    // 2 s later, expected = 12.
    expect(expectedPosition(state, 3000)).toBeCloseTo(12, 6);
  });

  it('never extrapolates backwards if clock skew sends now < lastSyncTime', () => {
    const state = at(true, 5000, 7);
    // now BEFORE lastSyncTime — clamp elapsed to 0 so expected stays at
    // the anchor; otherwise we'd subtract and confuse the drift check.
    expect(expectedPosition(state, 4000)).toBe(7);
  });
});

describe('decideDriftCorrection', () => {
  it('paused + local exactly on anchor → no seek', () => {
    const state = at(false, 1000, 10);
    expect(decideDriftCorrection(state, 10, 5000, 60)).toEqual({ kind: 'ok' });
  });

  it('paused + local within threshold of anchor → no seek', () => {
    const state = at(false, 1000, 10);
    expect(decideDriftCorrection(state, 10.4, 5000, 60)).toEqual({ kind: 'ok' });
    expect(decideDriftCorrection(state, 9.6, 5000, 60)).toEqual({ kind: 'ok' });
  });

  it('paused + local outside threshold of anchor → seek to anchor', () => {
    const state = at(false, 1000, 10);
    const dec = decideDriftCorrection(state, 11.5, 5000, 60);
    expect(dec).toEqual({ kind: 'seek', to: 10 });
  });

  it('playing + local matches extrapolated → no seek', () => {
    const state = at(true, 1000, 10);
    // 2 s elapsed; expected ≈ 12; local is at 12.1 (within threshold).
    expect(decideDriftCorrection(state, 12.1, 3000, 60)).toEqual({ kind: 'ok' });
  });

  it('playing + local drifts >0.5s behind → seek forward to expected', () => {
    const state = at(true, 1000, 10);
    // 5 s elapsed → expected = 15. Local at 13 → 2 s behind.
    const dec = decideDriftCorrection(state, 13, 6000, 60);
    expect(dec.kind).toBe('seek');
    if (dec.kind === 'seek') expect(dec.to).toBeCloseTo(15, 6);
  });

  it('playing + local drifts >0.5s ahead → seek backward to expected', () => {
    const state = at(true, 1000, 10);
    // expected = 15; local = 17.
    const dec = decideDriftCorrection(state, 17, 6000, 60);
    expect(dec.kind).toBe('seek');
    if (dec.kind === 'seek') expect(dec.to).toBeCloseTo(15, 6);
  });

  it('clamps expected to (duration - small epsilon) when extrapolated past end', () => {
    const state = at(true, 1000, 50);
    // 30 s elapsed → expected = 80; duration = 60. Should clamp.
    const dec = decideDriftCorrection(state, 10, 31_000, 60);
    expect(dec.kind).toBe('seek');
    if (dec.kind === 'seek') {
      expect(dec.to).toBeGreaterThan(59.9);
      expect(dec.to).toBeLessThan(60);
    }
  });

  it('handles NaN / 0 duration (file not yet loaded) without clamping', () => {
    const state = at(true, 1000, 10);
    // expected = 15; local = 5 → seek to 15.
    const dec = decideDriftCorrection(state, 5, 6000, NaN);
    expect(dec.kind).toBe('seek');
    if (dec.kind === 'seek') expect(dec.to).toBeCloseTo(15, 6);

    const dec2 = decideDriftCorrection(state, 5, 6000, 0);
    expect(dec2.kind).toBe('seek');
  });

  it('threshold is exactly DRIFT_THRESHOLD_SEC — values at the boundary stay OK', () => {
    const state = at(false, 1000, 10);
    // Drift of exactly the threshold should NOT trigger a seek (>, not >=).
    expect(decideDriftCorrection(state, 10 + DRIFT_THRESHOLD_SEC, 5000, 60)).toEqual({ kind: 'ok' });
    expect(decideDriftCorrection(state, 10 - DRIFT_THRESHOLD_SEC, 5000, 60)).toEqual({ kind: 'ok' });
    // Just past threshold → seek.
    const beyond = decideDriftCorrection(state, 10 + DRIFT_THRESHOLD_SEC + 0.01, 5000, 60);
    expect(beyond.kind).toBe('seek');
  });
});

describe('buildSyncWrite', () => {
  it('captures the current head + isPlaying + wallclock anchor', () => {
    const out = buildSyncWrite({
      isPlaying: true,
      currentPositionSec: 42.5,
      nowWallclockMs: 9_999_000,
    });
    expect(out).toEqual({
      isPlaying: true,
      lastSyncTime: 9_999_000,
      lastSyncPosition: 42.5,
    });
  });

  it('round-trips back through decideDriftCorrection with no drift right after the write', () => {
    // The writer's own local position should match the anchor immediately
    // after committing — meaning the writer's own correction loop must
    // NOT loop on itself.
    const t = 5_000;
    const state = buildSyncWrite({
      isPlaying: true,
      currentPositionSec: 30,
      nowWallclockMs: t,
    });
    expect(decideDriftCorrection(state, 30, t, 120)).toEqual({ kind: 'ok' });
  });
});
