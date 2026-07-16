// packages/web/src/lib/audio/hold-param.test.ts
//
// The CANCEL-AND-HOLD / PIN utils for the clip-automation param-jump policy.
//
// Load-bearing cases:
//  - the FIREFOX FALLBACK (no `cancelAndHoldAtTime`) reimplements cancel-and-hold
//    — and must read the current value BEFORE cancelling. The mock's `value`
//    MUTATES when cancelScheduledValues runs, so the read-then-cancel ORDER is
//    actually asserted (a static mock would pass with the read after the cancel).
//  - FUTURE seams NEVER cancel — a future `cancelScheduledValues` retro-deletes
//    the outgoing clip's final in-flight ramp (its event time is its END time),
//    and native `cancelAndHoldAtTime(futureT)` inserts no hold when nothing is
//    scheduled after it. A future seam PINS an explicit value instead, on BOTH
//    engines.

import { describe, it, expect, vi } from 'vitest';
import {
  holdParam,
  pinParamAt,
  holdParamAtSeam,
  HOLD_NOW_EPS_S,
  type HoldableParam,
} from './hold-param';

/** A mock AudioParam. `native=false` omits cancelAndHoldAtTime (the Firefox
 *  case). Records the call ORDER, and `value` becomes POISONED (NaN) once
 *  cancelScheduledValues runs — so a fallback that reads the value after
 *  cancelling pins garbage and fails the assertion (ordering is load-bearing). */
function mockParam(value: number, native: boolean) {
  const calls: string[] = [];
  let cancelled = false;
  const p = {
    get value() {
      return cancelled ? NaN : value;
    },
    setValueAtTime: vi.fn((v: number, t: number) => calls.push(`set(${v},${t})`)),
    linearRampToValueAtTime: vi.fn((v: number, t: number) => calls.push(`ramp(${v},${t})`)),
    cancelScheduledValues: vi.fn((t: number) => {
      cancelled = true; // poison the computed value — post-cancel reads are wrong
      calls.push(`cancel(${t})`);
    }),
    ...(native
      ? { cancelAndHoldAtTime: vi.fn((t: number) => calls.push(`hold(${t})`)) }
      : {}),
  } as HoldableParam & {
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    cancelScheduledValues: ReturnType<typeof vi.fn>;
    cancelAndHoldAtTime?: ReturnType<typeof vi.fn>;
  };
  return { p, calls };
}

describe('holdParam (near-now cancel-and-hold)', () => {
  it('uses native cancelAndHoldAtTime when present (no manual re-pin)', () => {
    const { p } = mockParam(0.42, true);
    const pinned = holdParam(p, 5);
    expect(p.cancelAndHoldAtTime).toHaveBeenCalledWith(5);
    expect(p.cancelScheduledValues).not.toHaveBeenCalled();
    expect(p.setValueAtTime).not.toHaveBeenCalled();
    expect(pinned).toBeUndefined(); // native path holds the projected value
  });

  it('FIREFOX FALLBACK: no cancelAndHoldAtTime → cancel + re-pin the current value', () => {
    const { p, calls } = mockParam(0.73, false);
    const pinned = holdParam(p, 5);
    expect(p.cancelScheduledValues).toHaveBeenCalledWith(5);
    expect(p.setValueAtTime).toHaveBeenCalledWith(0.73, 5);
    expect(pinned).toBe(0.73);
    expect(calls).toEqual(['cancel(5)', 'set(0.73,5)']);
  });

  it('FALLBACK ordering is load-bearing: the value is read BEFORE the cancel (a post-cancel read would pin NaN)', () => {
    // The mock POISONS .value to NaN once cancelScheduledValues runs. The pin
    // must be the pre-cancel value — reordering the read after the cancel fails.
    const { p } = mockParam(0.9, false);
    const pinned = holdParam(p, 2);
    expect(pinned).toBe(0.9);
    expect(p.setValueAtTime).toHaveBeenCalledWith(0.9, 2);
    const pinnedValue = (p.setValueAtTime.mock.calls[0] as [number, number])[0];
    expect(Number.isNaN(pinnedValue)).toBe(false);
  });
});

describe('pinParamAt (future seam — pin, NEVER cancel)', () => {
  it('pins with a real setValueAtTime event at the seam time (glideS<=0)', () => {
    const { p } = mockParam(0.2, true);
    pinParamAt(p, 10, 0.8, 0);
    expect(p.setValueAtTime).toHaveBeenCalledWith(0.8, 10);
    expect(p.cancelAndHoldAtTime).not.toHaveBeenCalled();
    expect(p.cancelScheduledValues).not.toHaveBeenCalled();
  });

  it('glides with a linearRamp reaching the value at atTime+glideS (glideS>0)', () => {
    const { p } = mockParam(0.2, false);
    pinParamAt(p, 10, 0.8, 0.012);
    expect(p.linearRampToValueAtTime).toHaveBeenCalledWith(0.8, 10.012);
    expect(p.cancelScheduledValues).not.toHaveBeenCalled();
    expect(p.setValueAtTime).not.toHaveBeenCalled();
  });
});

describe('holdParamAtSeam (the near-now vs future dispatcher)', () => {
  const NOW = 100;

  it('NEAR-NOW truncate-only (toValue null): cancel-and-hold, no new value', () => {
    const { p } = mockParam(0.5, true);
    holdParamAtSeam(p, NOW, NOW, null, 0.012);
    expect(p.cancelAndHoldAtTime).toHaveBeenCalledWith(NOW);
    expect(p.linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(p.setValueAtTime).not.toHaveBeenCalled();
  });

  it('NEAR-NOW with a value + glide: hold, then a short linearRamp to it', () => {
    const { p } = mockParam(0.2, true);
    holdParamAtSeam(p, NOW, NOW, 0.8, 0.012);
    expect(p.cancelAndHoldAtTime).toHaveBeenCalledWith(NOW);
    expect(p.linearRampToValueAtTime).toHaveBeenCalledWith(0.8, NOW + 0.012);
  });

  it('NEAR-NOW FIREFOX: cancel + re-pin pre-cancel value, THEN glide to the new value', () => {
    const { p, calls } = mockParam(0.3, false);
    holdParamAtSeam(p, NOW, NOW, 0.9, 0.012);
    expect(calls).toEqual([`cancel(${NOW})`, `set(0.3,${NOW})`, `ramp(0.9,${NOW + 0.012})`]);
  });

  it('FUTURE + value: pin-only — NEVER cancels on EITHER engine (fix #2)', () => {
    // A future cancel retro-deletes the outgoing clip's boundary-landing ramp in
    // the fallback and is a silent no-op natively; the seam pins explicitly.
    const boundary = NOW + 0.15; // ~a loop boundary inside the 200ms lookahead
    const native = mockParam(0.4, true);
    holdParamAtSeam(native.p, NOW, boundary, 0.7, 0);
    expect(native.p.cancelAndHoldAtTime).not.toHaveBeenCalled();
    expect(native.p.cancelScheduledValues).not.toHaveBeenCalled();
    expect(native.p.setValueAtTime).toHaveBeenCalledWith(0.7, boundary);

    const ff = mockParam(0.4, false);
    holdParamAtSeam(ff.p, NOW, boundary, 0.7, 0);
    expect(ff.p.cancelScheduledValues).not.toHaveBeenCalled(); // no retro-delete
    expect(ff.p.setValueAtTime).toHaveBeenCalledWith(0.7, boundary); // real event, same as native
  });

  it('FUTURE without a value: a no-op (nothing to pin, nothing cancelled)', () => {
    const { p } = mockParam(0.4, false);
    holdParamAtSeam(p, NOW, NOW + 0.15, null, 0);
    expect(p.cancelScheduledValues).not.toHaveBeenCalled();
    expect(p.setValueAtTime).not.toHaveBeenCalled();
    expect(p.linearRampToValueAtTime).not.toHaveBeenCalled();
  });

  it('the near-now boundary is HOLD_NOW_EPS_S: just-inside cancels, just-outside pins', () => {
    const inside = mockParam(0.5, false);
    holdParamAtSeam(inside.p, NOW, NOW + HOLD_NOW_EPS_S * 0.9, 0.6, 0);
    expect(inside.p.cancelScheduledValues).toHaveBeenCalled(); // near-now → cancel path

    const outside = mockParam(0.5, false);
    holdParamAtSeam(outside.p, NOW, NOW + HOLD_NOW_EPS_S * 2, 0.6, 0);
    expect(outside.p.cancelScheduledValues).not.toHaveBeenCalled(); // future → pin path
    expect(outside.p.setValueAtTime).toHaveBeenCalledWith(0.6, NOW + HOLD_NOW_EPS_S * 2);
  });
});
