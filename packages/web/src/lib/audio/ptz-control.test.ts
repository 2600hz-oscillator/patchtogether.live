import { describe, expect, it } from 'vitest';
import { planPtzSend, ptzSlewRate, type PtzPlan } from './ptz-control';
import type { PtzCaps } from './ptz-sysex';

// The measured NexiGo P610 caps (hardware probe 2026-08-29). Deliberately
// asymmetric tilt — several assertions depend on midpoint ≠ 0.
const CAPS: PtzCaps = {
  pan: { min: -612000, max: 612000, res: 1, cur: 0 },
  tilt: { min: -108000, max: 324000, res: 1, cur: 0 },
  zoom: { min: 0, max: 3040, res: 1, cur: 0 },
};

const INSTANT = 1;

function firstPlan(targets = { pan: 0, tilt: 0, zoom: 0 }): PtzPlan {
  return planPtzSend(null, targets, CAPS, 100, INSTANT).plan;
}

describe('mapping into device ranges (units: normalized → device ints)', () => {
  it('a first plan jumps to the target and emits all three controls', () => {
    const { sends } = planPtzSend(null, { pan: 0, tilt: 0, zoom: 0 }, CAPS, 100, INSTANT);
    expect(sends.map((s) => s.control)).toEqual(['pan', 'tilt', 'zoom']);
  });

  it('bipolar 0 maps to the range midpoint, ±1 to the ends', () => {
    const { plan } = planPtzSend(null, { pan: 0, tilt: 0, zoom: 0 }, CAPS, 100, INSTANT);
    expect(plan.sent.pan).toBe(0);
    expect(plan.sent.tilt).toBe(108000);
    const ends = planPtzSend(null, { pan: -1, tilt: 1, zoom: 1 }, CAPS, 100, INSTANT).plan.sent;
    expect(ends.pan).toBe(-612000);
    expect(ends.tilt).toBe(324000);
    expect(ends.zoom).toBe(3040);
  });

  it('unipolar zoom 0 maps to min, not midpoint', () => {
    expect(firstPlan().sent.zoom).toBe(0);
  });

  it('out-of-range targets clamp to the device range', () => {
    const sent = planPtzSend(null, { pan: 5, tilt: -5, zoom: 9 }, CAPS, 100, INSTANT).plan.sent;
    expect(sent).toEqual({ pan: 612000, tilt: -108000, zoom: 3040 });
  });

  it('quantizes to the device res and clamps the rounding', () => {
    const coarse: PtzCaps = { ...CAPS, zoom: { min: 0, max: 3040, res: 100, cur: 0 } };
    const sent = planPtzSend(null, { pan: 0, tilt: 0, zoom: 0.5 }, coarse, 100, INSTANT).plan.sent;
    expect(sent.zoom % 100).toBe(0);
    expect(sent.zoom).toBe(1500);
  });

  it('non-finite targets fall to a safe resting value rather than NaN on the wire', () => {
    const sent = planPtzSend(null, { pan: NaN, tilt: Infinity, zoom: NaN }, CAPS, 100, INSTANT)
      .plan.sent;
    expect(Number.isFinite(sent.pan)).toBe(true);
    expect(Number.isFinite(sent.tilt)).toBe(true);
    expect(Number.isFinite(sent.zoom)).toBe(true);
    expect(sent.zoom).toBe(0);
  });
});

describe('coalescing (no-change suppression)', () => {
  it('an unchanged position emits nothing', () => {
    const prev = firstPlan();
    const { sends } = planPtzSend(prev, { pan: 0, tilt: 0, zoom: 0 }, CAPS, 100, INSTANT);
    expect(sends).toEqual([]);
  });

  it('a sub-step move emits nothing; crossing one step emits exactly that control', () => {
    const coarse: PtzCaps = { ...CAPS, zoom: { min: 0, max: 3040, res: 100, cur: 0 } };
    const prev = planPtzSend(null, { pan: 0, tilt: 0, zoom: 0.5 }, coarse, 100, INSTANT).plan;
    const tiny = planPtzSend(prev, { pan: 0, tilt: 0, zoom: 0.503 }, coarse, 100, INSTANT);
    expect(tiny.sends).toEqual([]);
    const step = planPtzSend(prev, { pan: 0, tilt: 0, zoom: 0.55 }, coarse, 100, INSTANT);
    expect(step.sends).toEqual([{ control: 'zoom', value: 1700 }]);
  });

  it('only the moved control is sent', () => {
    const prev = firstPlan();
    const { sends } = planPtzSend(prev, { pan: 0.5, tilt: 0, zoom: 0 }, CAPS, 100, INSTANT);
    expect(sends.map((s) => s.control)).toEqual(['pan']);
  });
});

describe('slew limiting (units: normalized units/sec)', () => {
  it('slew 1 is instant', () => {
    expect(ptzSlewRate(1)).toBe(Infinity);
    const prev = firstPlan();
    const { plan } = planPtzSend(prev, { pan: 1, tilt: 0, zoom: 0 }, CAPS, 100, 1);
    expect(plan.pos.pan).toBe(1);
  });

  it('below 1 a jump is limited to rate × dt and progresses monotonically', () => {
    const slew = 0.5;
    const rate = ptzSlewRate(slew);
    const dtMs = 100;
    const prev = firstPlan();
    const step1 = planPtzSend(prev, { pan: 1, tilt: 0, zoom: 0 }, CAPS, dtMs, slew);
    expect(step1.plan.pos.pan).toBeCloseTo(rate * (dtMs / 1000), 10);
    const step2 = planPtzSend(step1.plan, { pan: 1, tilt: 0, zoom: 0 }, CAPS, dtMs, slew);
    expect(step2.plan.pos.pan).toBeGreaterThan(step1.plan.pos.pan);
    expect(step2.plan.pos.pan).toBeLessThanOrEqual(1);
    expect(step1.sends.map((s) => s.control)).toEqual(['pan']);
  });

  it('slew 0 still moves (rate floor, never frozen)', () => {
    expect(ptzSlewRate(0)).toBeGreaterThan(0);
  });
});
