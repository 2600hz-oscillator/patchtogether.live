import { describe, it, expect } from 'vitest';
import { fieldResidual, nextSensorSeed, sensorProfile, sensorSeed, SENSOR_SEED_MAX } from './crutchfield';
import { backdraftDef, backdraftNextTvMode, BACKDRAFT_TV_MODE_LABELS } from '../modules/backdraft';

describe('Crutchfield physical coefficients and saved camera identity', () => {
  it('appends the mode without repatching saved mode values', () => {
    expect(BACKDRAFT_TV_MODE_LABELS).toEqual(['OFF', 'VIRTUAL CAMERA', 'CRITICAL', 'CRUTCHFIELD']);
    expect([0,1,2,3].map(backdraftNextTvMode)).toEqual([1,2,3,0]);
    expect(backdraftDef.params.find(p => p.id === 'tvMode')?.defaultValue).toBe(0);
  });

  it('retains the physical lifetime over 60 field steps, independently per channel', () => {
    expect(fieldResidual(0)).toBe(0);
    expect(fieldResidual(1) ** 60).toBeCloseTo(Math.exp(-1), 12);
    expect(fieldResidual(0.333)).toBeGreaterThan(fieldResidual(0.025));
    expect(fieldResidual(0.333, 1.05)).toBeGreaterThan(fieldResidual(0.333, 0.9));
  });

  it('reproduces the same camera, and rerolls through the entire seed space without repeats', () => {
    expect(sensorProfile(167)).toEqual(sensorProfile(167));
    expect(sensorProfile(167)).not.toEqual(sensorProfile(nextSensorSeed(167)));
    expect([...sensorProfile(167)].every(v => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(true);
    const seen = new Set<number>();
    let seed = 167;
    for (let i = 0; i <= SENSOR_SEED_MAX; i++) {
      expect(seen.has(seed)).toBe(false);
      seen.add(seed);
      seed = nextSensorSeed(seed);
    }
    expect(seed).toBe(167);
    expect(sensorSeed(Infinity)).toBe(167);
    expect(sensorSeed(-10)).toBe(0);
  });
});
