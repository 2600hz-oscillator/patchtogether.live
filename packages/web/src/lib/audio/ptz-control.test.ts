import { describe, expect, it } from 'vitest';
import {
  planPtzSend,
  ptzSlewRate,
  velFromNorm,
  PTZ_VEL_DEADZONE,
  type PtzPlan,
} from './ptz-control';
import type { PtzCaps } from './ptz-sysex';

// The two measured cameras (hardware probes 2026-08-29). NEXIGO is deliberately
// tilt-asymmetric (midpoint ≠ 0); LOGI's velocity range is the degenerate
// fixed-speed 1..1 the PTZ Pro 2 really reports.
const NEXIGO: PtzCaps = {
  pan: { mode: 'abs', min: -612000, max: 612000, res: 1, cur: 0 },
  tilt: { mode: 'abs', min: -108000, max: 324000, res: 1, cur: 0 },
  zoom: { mode: 'abs', min: 0, max: 3040, res: 1, cur: 0 },
};
const LOGI: PtzCaps = {
  pan: { mode: 'vel', speedMin: 1, speedMax: 1, speedRes: 1 },
  tilt: { mode: 'vel', speedMin: 1, speedMax: 1, speedRes: 1 },
  zoom: { mode: 'abs', min: 100, max: 1000, res: 1, cur: 100 },
};

const INSTANT = 1;
const REST = { pan: 0, tilt: 0, zoom: 0 };

function firstPlan(caps: PtzCaps, targets = REST): PtzPlan {
  return planPtzSend(null, targets, caps, 100, INSTANT).plan;
}

describe('absolute axes (units: normalized → device ints)', () => {
  it('a first plan jumps to the target and emits all absolute controls', () => {
    const { sends } = planPtzSend(null, REST, NEXIGO, 100, INSTANT);
    expect(sends.map((s) => [s.control, s.kind])).toEqual([
      ['pan', 'abs'],
      ['tilt', 'abs'],
      ['zoom', 'abs'],
    ]);
  });

  it('bipolar 0 maps to the range midpoint, ±1 to the ends', () => {
    const { plan } = planPtzSend(null, REST, NEXIGO, 100, INSTANT);
    expect(plan.sent.pan).toBe(0);
    expect(plan.sent.tilt).toBe(108000);
    const ends = planPtzSend(null, { pan: -1, tilt: 1, zoom: 1 }, NEXIGO, 100, INSTANT).plan.sent;
    expect(ends.pan).toBe(-612000);
    expect(ends.tilt).toBe(324000);
    expect(ends.zoom).toBe(3040);
  });

  it('unipolar zoom 0 maps to min, not midpoint', () => {
    expect(firstPlan(NEXIGO).sent.zoom).toBe(0);
    expect(firstPlan(LOGI).sent.zoom).toBe(100);
  });

  it('out-of-range targets clamp to the device range', () => {
    const sent = planPtzSend(null, { pan: 5, tilt: -5, zoom: 9 }, NEXIGO, 100, INSTANT).plan.sent;
    expect(sent).toEqual({ pan: 612000, tilt: -108000, zoom: 3040 });
  });

  it('quantizes to the device res and clamps the rounding', () => {
    const coarse: PtzCaps = { ...NEXIGO, zoom: { mode: 'abs', min: 0, max: 3040, res: 100, cur: 0 } };
    const sent = planPtzSend(null, { pan: 0, tilt: 0, zoom: 0.5 }, coarse, 100, INSTANT).plan.sent;
    expect(sent.zoom % 100).toBe(0);
    expect(sent.zoom).toBe(1500);
  });

  it('non-finite targets fall to a safe resting value rather than NaN on the wire', () => {
    const sent = planPtzSend(null, { pan: NaN, tilt: Infinity, zoom: NaN }, NEXIGO, 100, INSTANT)
      .plan.sent;
    expect(Number.isFinite(sent.pan)).toBe(true);
    expect(Number.isFinite(sent.tilt)).toBe(true);
    expect(sent.zoom).toBe(0);
  });

  it('an unchanged position emits nothing; only the moved control is sent', () => {
    const prev = firstPlan(NEXIGO);
    expect(planPtzSend(prev, REST, NEXIGO, 100, INSTANT).sends).toEqual([]);
    const { sends } = planPtzSend(prev, { pan: 0.5, tilt: 0, zoom: 0 }, NEXIGO, 100, INSTANT);
    expect(sends.map((s) => s.control)).toEqual(['pan']);
  });
});

describe('slew limiting (absolute axes only)', () => {
  it('slew 1 is instant; below 1 a jump is limited to rate × dt', () => {
    expect(ptzSlewRate(1)).toBe(Infinity);
    expect(ptzSlewRate(0)).toBeGreaterThan(0);
    const slew = 0.5;
    const prev = firstPlan(NEXIGO);
    const step1 = planPtzSend(prev, { pan: 1, tilt: 0, zoom: 0 }, NEXIGO, 100, slew);
    expect(step1.plan.pos.pan).toBeCloseTo(ptzSlewRate(slew) * 0.1, 10);
    const step2 = planPtzSend(step1.plan, { pan: 1, tilt: 0, zoom: 0 }, NEXIGO, 100, slew);
    expect(step2.plan.pos.pan).toBeGreaterThan(step1.plan.pos.pan);
  });

  it('a velocity axis is NEVER slewed — a commanded stop lands the same tick', () => {
    const prev = planPtzSend(null, { pan: 1, tilt: 0, zoom: 0 }, LOGI, 100, 0.01).plan;
    expect(prev.sentVel.pan).toBe(1);
    const { plan, sends } = planPtzSend(prev, REST, LOGI, 100, 0.01);
    expect(plan.sentVel.pan).toBe(0);
    expect(sends.find((s) => s.control === 'pan')).toEqual({ control: 'pan', kind: 'vel', value: 0 });
  });
});

describe('velocity axes', () => {
  it('velFromNorm: deadzone stops, sign is direction, the degenerate 1..1 range collapses to ±1', () => {
    const caps = { speedMin: 1, speedMax: 1, speedRes: 1 };
    expect(velFromNorm(0, caps)).toBe(0);
    expect(velFromNorm(PTZ_VEL_DEADZONE, caps)).toBe(0);
    expect(velFromNorm(-PTZ_VEL_DEADZONE, caps)).toBe(0);
    expect(velFromNorm(PTZ_VEL_DEADZONE + 0.01, caps)).toBe(1);
    expect(velFromNorm(1, caps)).toBe(1);
    expect(velFromNorm(-0.5, caps)).toBe(-1);
    expect(velFromNorm(NaN, caps)).toBe(0);
  });

  it('velFromNorm: a real speed range scales past the deadzone and quantizes to res', () => {
    const caps = { speedMin: 1, speedMax: 9, speedRes: 2 };
    expect(velFromNorm(1, caps)).toBe(9);
    expect(velFromNorm(-1, caps)).toBe(-9);
    const mid = velFromNorm(0.5, caps);
    expect((mid - 1) % 2).toBe(0);
    expect(mid).toBeGreaterThanOrEqual(1);
    expect(mid).toBeLessThanOrEqual(9);
  });

  it('a NONZERO velocity is re-sent even when unchanged — the watchdog keepalive', () => {
    const prev = planPtzSend(null, { pan: 1, tilt: 0, zoom: 0 }, LOGI, 100, INSTANT).plan;
    const again = planPtzSend(prev, { pan: 1, tilt: 0, zoom: 0 }, LOGI, 100, INSTANT);
    expect(again.sends.filter((s) => s.control === 'pan')).toEqual([
      { control: 'pan', kind: 'vel', value: 1 },
    ]);
  });

  it('the transition to zero is an explicit stop, sent once, then suppressed at rest', () => {
    const moving = planPtzSend(null, { pan: 1, tilt: 0, zoom: 0 }, LOGI, 100, INSTANT).plan;
    const stop = planPtzSend(moving, REST, LOGI, 100, INSTANT);
    expect(stop.sends.filter((s) => s.control === 'pan')).toEqual([
      { control: 'pan', kind: 'vel', value: 0 },
    ]);
    const atRest = planPtzSend(stop.plan, REST, LOGI, 100, INSTANT);
    expect(atRest.sends.filter((s) => s.control === 'pan')).toEqual([]);
  });

  it('a first plan asserts every velocity axis (an explicit stop at rest)', () => {
    const { sends } = planPtzSend(null, REST, LOGI, 100, INSTANT);
    expect(sends).toEqual([
      { control: 'pan', kind: 'vel', value: 0 },
      { control: 'tilt', kind: 'vel', value: 0 },
      { control: 'zoom', kind: 'abs', value: 100 },
    ]);
  });

  it('mixed-mode caps (the Logitech shape) plan each axis by its own mode', () => {
    const prev = firstPlan(LOGI);
    const { sends } = planPtzSend(prev, { pan: 0.8, tilt: 0, zoom: 0.5 }, LOGI, 100, INSTANT);
    expect(sends).toEqual([
      { control: 'pan', kind: 'vel', value: 1 },
      { control: 'zoom', kind: 'abs', value: 550 },
    ]);
  });
});
