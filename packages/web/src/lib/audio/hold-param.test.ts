// packages/web/src/lib/audio/hold-param.test.ts
//
// The CANCEL-AND-HOLD util for the clip-automation param-jump policy. The
// FIREFOX FALLBACK is the load-bearing case: Firefox ships no
// `cancelAndHoldAtTime`, so we reimplement it — read the current value, cancel
// the schedule, re-pin. Tested against a mock param with NO cancelAndHoldAtTime.

import { describe, it, expect, vi } from 'vitest';
import { holdParam, holdAndGlideParam, type HoldableParam } from './hold-param';

/** A mock AudioParam. `native=false` omits cancelAndHoldAtTime (the Firefox
 *  case). Records the call ORDER so we can assert read-then-cancel-then-pin. */
function mockParam(value: number, native: boolean) {
  const calls: string[] = [];
  const p = {
    value,
    setValueAtTime: vi.fn((v: number, t: number) => calls.push(`set(${v},${t})`)),
    linearRampToValueAtTime: vi.fn((v: number, t: number) => calls.push(`ramp(${v},${t})`)),
    cancelScheduledValues: vi.fn((t: number) => calls.push(`cancel(${t})`)),
    ...(native
      ? { cancelAndHoldAtTime: vi.fn((t: number) => calls.push(`hold(${t})`)) }
      : {}),
  } as HoldableParam & {
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    setValueAtTime: ReturnType<typeof vi.fn>;
    cancelScheduledValues: ReturnType<typeof vi.fn>;
    cancelAndHoldAtTime?: ReturnType<typeof vi.fn>;
  };
  return { p, calls };
}

describe('holdParam', () => {
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
    // Reimplements cancel-and-hold: cancel the future schedule, then actively pin
    // the CURRENT computed value so the param stops drifting along its old ramp.
    expect(p.cancelScheduledValues).toHaveBeenCalledWith(5);
    expect(p.setValueAtTime).toHaveBeenCalledWith(0.73, 5);
    expect(pinned).toBe(0.73);
    // Order matters: read value → cancel → pin (value read before cancelling).
    expect(calls).toEqual(['cancel(5)', 'set(0.73,5)']);
  });

  it('FALLBACK pins the value read BEFORE cancelling (not a post-cancel default)', () => {
    // Simulate a param whose .value would read differently if cancel mutated it:
    // we captured 0.9 up-front, so the pin must be 0.9 regardless.
    const { p } = mockParam(0.9, false);
    holdParam(p, 2);
    expect(p.setValueAtTime).toHaveBeenCalledWith(0.9, 2);
  });
});

describe('holdAndGlideParam', () => {
  it('truncate-only (toValue null): holds, no set/ramp to a new value', () => {
    const { p } = mockParam(0.5, true);
    holdAndGlideParam(p as never, 3, null, 0.012);
    expect(p.cancelAndHoldAtTime).toHaveBeenCalledWith(3);
    expect(p.linearRampToValueAtTime).not.toHaveBeenCalled();
    // native path does not re-pin via setValueAtTime
    expect(p.setValueAtTime).not.toHaveBeenCalled();
  });

  it('glide to a value (glideS>0): hold, then a short linearRamp to toValue', () => {
    const { p } = mockParam(0.2, true);
    holdAndGlideParam(p as never, 10, 0.8, 0.012);
    expect(p.cancelAndHoldAtTime).toHaveBeenCalledWith(10);
    expect(p.linearRampToValueAtTime).toHaveBeenCalledWith(0.8, 10.012);
    expect(p.setValueAtTime).not.toHaveBeenCalled();
  });

  it('hard-set to a value (glideS<=0): hold, then setValueAtTime (no ramp)', () => {
    const { p } = mockParam(0.2, true);
    holdAndGlideParam(p as never, 10, 0.8, 0);
    expect(p.cancelAndHoldAtTime).toHaveBeenCalledWith(10);
    expect(p.setValueAtTime).toHaveBeenCalledWith(0.8, 10);
    expect(p.linearRampToValueAtTime).not.toHaveBeenCalled();
  });

  it('FIREFOX FALLBACK + glide: cancel + re-pin current, THEN ramp to toValue', () => {
    const { p, calls } = mockParam(0.3, false);
    holdAndGlideParam(p as never, 4, 0.9, 0.012);
    // hold reimplemented (cancel + re-pin 0.3 at t=4), then glide to 0.9 at t=4.012
    expect(calls).toEqual(['cancel(4)', 'set(0.3,4)', 'ramp(0.9,4.012)']);
  });
});
