// packages/web/src/lib/audio/modules/twotracks-transport.test.ts
//
// Unit tests for the TWOTRACKS pure transport state machine.
// No AudioContext deps — pure logic only.

import { describe, it, expect } from 'vitest';
import {
  createTransport,
  transportPlay,
  transportStop,
  transportArm,
  transportBeginRec,
  transportCursorCrossedStart,
  transportReachedEnd,
  transportToggleOverdub,
  transportConsumePendingDecay,
  transportSetLoopMode,
  computeDecayFactor,
  isRecording,
  isActive,
} from './twotracks-transport';

describe('twotracks-transport', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Initial state
  // ─────────────────────────────────────────────────────────────────────────

  it('creates fresh idle transport', () => {
    const t = createTransport();
    expect(t.state).toBe('idle');
    expect(t.overdubFlag).toBe(false);
    expect(t.loopMode).toBe('loop');
    expect(t.pendingDecay).toBe(false);
  });

  it('creates fresh oneshot transport', () => {
    const t = createTransport('oneshot');
    expect(t.loopMode).toBe('oneshot');
    expect(t.state).toBe('idle');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // play / stop
  // ─────────────────────────────────────────────────────────────────────────

  it('idle → play', () => {
    const t = transportPlay(createTransport());
    expect(t.state).toBe('play');
  });

  it('play → play (no-op)', () => {
    const t = createTransport();
    const playing = transportPlay(t);
    const again = transportPlay(playing);
    expect(again.state).toBe('play');
    expect(again).toBe(playing); // same reference = no-op
  });

  it('any state → idle via stop', () => {
    for (const state of ['play', 'armed', 'rec', 'overdub'] as const) {
      const t = { ...createTransport(), state };
      const stopped = transportStop(t);
      expect(stopped.state).toBe('idle');
      expect(stopped.pendingDecay).toBe(false);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // arm → rec / overdub
  // ─────────────────────────────────────────────────────────────────────────

  it('idle → armed via arm()', () => {
    const t = transportArm(createTransport());
    expect(t.state).toBe('armed');
    expect(t.pendingDecay).toBe(true);
  });

  it('armed + cursorCrossedStart → rec (destructive)', () => {
    const armed = transportArm(createTransport());
    const t = transportCursorCrossedStart(armed);
    expect(t.state).toBe('rec');
    expect(t.overdubFlag).toBe(false);
  });

  it('armed + cursorCrossedStart → overdub (additive)', () => {
    const base = { ...createTransport(), overdubFlag: true };
    const armed = transportArm(base);
    const t = transportCursorCrossedStart(armed);
    expect(t.state).toBe('overdub');
    expect(t.overdubFlag).toBe(true);
  });

  it('rec state is not affected by arm() (no-op)', () => {
    const rec = { ...createTransport(), state: 'rec' as const };
    const t = transportArm(rec);
    // Currently recording → arm is no-op
    expect(t.state).toBe('rec');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // beginRec (immediate, no arm wait)
  // ─────────────────────────────────────────────────────────────────────────

  it('beginRec enters rec (destructive)', () => {
    const t = transportBeginRec(createTransport());
    expect(t.state).toBe('rec');
    expect(t.pendingDecay).toBe(true);
  });

  it('beginRec enters overdub (additive) when overdubFlag=true', () => {
    const base = { ...createTransport(), overdubFlag: true };
    const t = transportBeginRec(base);
    expect(t.state).toBe('overdub');
    expect(t.pendingDecay).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Axis 2: loop vs one-shot — cursorCrossedStart vs reachedEnd
  // ─────────────────────────────────────────────────────────────────────────

  it('loop+rec: reachedEnd is no-op (wraps instead)', () => {
    const rec = { ...createTransport('loop'), state: 'rec' as const };
    const t = transportReachedEnd(rec);
    expect(t.state).toBe('rec'); // loop never stops on reachedEnd
  });

  it('oneshot+rec: reachedEnd → play', () => {
    const rec = { ...createTransport('oneshot'), state: 'rec' as const };
    const t = transportReachedEnd(rec);
    expect(t.state).toBe('play');
    expect(t.pendingDecay).toBe(false);
  });

  it('oneshot+overdub: reachedEnd → play', () => {
    const ov = { ...createTransport('oneshot'), state: 'overdub' as const, overdubFlag: true };
    const t = transportReachedEnd(ov);
    expect(t.state).toBe('play');
  });

  it('oneshot+play: reachedEnd → idle', () => {
    const playing = { ...createTransport('oneshot'), state: 'play' as const };
    const t = transportReachedEnd(playing);
    expect(t.state).toBe('idle');
  });

  it('loop+play: reachedEnd is no-op (stays play)', () => {
    const playing = { ...createTransport('loop'), state: 'play' as const };
    const t = transportReachedEnd(playing);
    expect(t.state).toBe('play');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // overdub toggle
  // ─────────────────────────────────────────────────────────────────────────

  it('toggleOverdub flips the flag from idle', () => {
    const t = transportToggleOverdub(createTransport());
    expect(t.overdubFlag).toBe(true);
    expect(t.state).toBe('idle');
  });

  it('toggleOverdub in rec → overdub', () => {
    const rec = { ...createTransport(), state: 'rec' as const };
    const t = transportToggleOverdub(rec);
    expect(t.state).toBe('overdub');
    expect(t.overdubFlag).toBe(true);
  });

  it('toggleOverdub in overdub → rec', () => {
    const ov = { ...createTransport(), state: 'overdub' as const, overdubFlag: true };
    const t = transportToggleOverdub(ov);
    expect(t.state).toBe('rec');
    expect(t.overdubFlag).toBe(false);
  });

  it('toggleOverdub twice restores original', () => {
    const base = createTransport();
    const t = transportToggleOverdub(transportToggleOverdub(base));
    expect(t.overdubFlag).toBe(false);
    expect(t.state).toBe('idle');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // All 4 axis combinations
  // ─────────────────────────────────────────────────────────────────────────

  it('loop + destructive: rec wraps at start without stopping', () => {
    // Armed in loop mode, destructive.
    const start = createTransport('loop');
    const armed = transportArm(start);
    const rec = transportCursorCrossedStart(armed); // starts rec
    expect(rec.state).toBe('rec');
    // Cursor wraps again (another loop) — stays in rec.
    const rec2 = transportCursorCrossedStart(rec);
    expect(rec2.state).toBe('rec'); // no state change on crossing (destructive)
  });

  it('loop + additive: overdub sets pendingDecay on each crossing', () => {
    const base = { ...createTransport('loop'), overdubFlag: true };
    const armed = transportArm(base);
    const ov = transportCursorCrossedStart(armed);
    expect(ov.state).toBe('overdub');
    // Consume decay, then cross start again → new pendingDecay.
    const { transport: consumed } = transportConsumePendingDecay(ov);
    const ov2 = transportCursorCrossedStart(consumed);
    expect(ov2.pendingDecay).toBe(true); // new pass → new decay
  });

  it('oneshot + destructive: rec → play → idle', () => {
    const base = createTransport('oneshot');
    const rec = transportBeginRec(base);
    expect(rec.state).toBe('rec');
    const play = transportReachedEnd(rec);
    expect(play.state).toBe('play');
    const idle = transportReachedEnd(play);
    expect(idle.state).toBe('idle');
  });

  it('oneshot + additive: overdub single pass → play → idle', () => {
    const base = { ...createTransport('oneshot'), overdubFlag: true };
    const ov = transportBeginRec(base);
    expect(ov.state).toBe('overdub');
    const play = transportReachedEnd(ov);
    expect(play.state).toBe('play');
    const idle = transportReachedEnd(play);
    expect(idle.state).toBe('idle');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // pendingDecay flag
  // ─────────────────────────────────────────────────────────────────────────

  it('consumePendingDecay returns true and clears flag', () => {
    const t = { ...createTransport(), pendingDecay: true };
    const { transport: t2, shouldDecay } = transportConsumePendingDecay(t);
    expect(shouldDecay).toBe(true);
    expect(t2.pendingDecay).toBe(false);
  });

  it('consumePendingDecay returns false when flag is clear', () => {
    const t = createTransport();
    const { transport: t2, shouldDecay } = transportConsumePendingDecay(t);
    expect(shouldDecay).toBe(false);
    expect(t2.pendingDecay).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // loopMode change
  // ─────────────────────────────────────────────────────────────────────────

  it('setLoopMode changes mode without touching state', () => {
    const t = { ...createTransport('loop'), state: 'play' as const };
    const t2 = transportSetLoopMode(t, 'oneshot');
    expect(t2.loopMode).toBe('oneshot');
    expect(t2.state).toBe('play'); // state unchanged
  });

  // ─────────────────────────────────────────────────────────────────────────
  // computeDecayFactor
  // ─────────────────────────────────────────────────────────────────────────

  it('decay=0 → 0.90', () => {
    expect(computeDecayFactor(0)).toBeCloseTo(0.90);
  });

  it('decay=1 → 0.50', () => {
    expect(computeDecayFactor(1)).toBeCloseTo(0.50);
  });

  it('decay=0.5 → 0.70 (midpoint)', () => {
    expect(computeDecayFactor(0.5)).toBeCloseTo(0.70);
  });

  it('decay is clamped to [0..1]', () => {
    expect(computeDecayFactor(-5)).toBeCloseTo(0.90);
    expect(computeDecayFactor(5)).toBeCloseTo(0.50);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // isRecording / isActive helpers
  // ─────────────────────────────────────────────────────────────────────────

  it('isRecording: true only for rec/overdub', () => {
    expect(isRecording({ ...createTransport(), state: 'rec' })).toBe(true);
    expect(isRecording({ ...createTransport(), state: 'overdub' })).toBe(true);
    expect(isRecording({ ...createTransport(), state: 'play' })).toBe(false);
    expect(isRecording({ ...createTransport(), state: 'armed' })).toBe(false);
    expect(isRecording({ ...createTransport(), state: 'idle' })).toBe(false);
  });

  it('isActive: false only for idle', () => {
    for (const state of ['play', 'armed', 'rec', 'overdub'] as const) {
      expect(isActive({ ...createTransport(), state })).toBe(true);
    }
    expect(isActive(createTransport())).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Immutability: all transitions return NEW objects
  // ─────────────────────────────────────────────────────────────────────────

  it('transitions do not mutate the original', () => {
    const orig = createTransport();
    transportPlay(orig);
    transportArm(orig);
    transportBeginRec(orig);
    transportToggleOverdub(orig);
    transportStop(orig);
    // orig must be unchanged
    expect(orig.state).toBe('idle');
    expect(orig.overdubFlag).toBe(false);
    expect(orig.pendingDecay).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge: reachedEnd from idle/armed (no-op)
  // ─────────────────────────────────────────────────────────────────────────

  it('reachedEnd from idle is no-op', () => {
    const t = createTransport('oneshot');
    const t2 = transportReachedEnd(t);
    expect(t2.state).toBe('idle');
  });

  it('reachedEnd from armed is no-op', () => {
    const armed = transportArm(createTransport('oneshot'));
    const t = transportReachedEnd(armed);
    expect(t.state).toBe('armed'); // still waiting for cursor cross
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Full walk-through: arm → armed → loop-start → rec → stop
  // ─────────────────────────────────────────────────────────────────────────

  it('full walk-through: idle → arm → rec (loop) → stop → idle', () => {
    let t = createTransport('loop');
    expect(t.state).toBe('idle');

    t = transportArm(t);
    expect(t.state).toBe('armed');

    t = transportCursorCrossedStart(t);
    expect(t.state).toBe('rec');
    expect(t.pendingDecay).toBe(true);

    // Consume decay flag.
    const { transport: t2, shouldDecay } = transportConsumePendingDecay(t);
    t = t2;
    expect(shouldDecay).toBe(true);
    expect(t.pendingDecay).toBe(false);

    t = transportStop(t);
    expect(t.state).toBe('idle');
  });
});
