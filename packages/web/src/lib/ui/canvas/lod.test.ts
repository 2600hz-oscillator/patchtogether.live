// Unit tests for the pure STRATA semantic-zoom tier function (lod.ts).
// Pure data, no DOM, no store — run via vitest in the web workspace.
//
// Covers: the nominal tier per zoom band + boundary inclusivity; hysteresis
// (a zoom dithering on a boundary keeps the sticky prevTier, no oscillation);
// monotonicity of a zoom sweep threading prevTier; multi-step jumps snapping to
// nominal; and non-finite / bad-prevTier guards.

import { describe, it, expect } from 'vitest';
import { lodTier, TIER_ORDER, TIER_LOWER, TIER_HYSTERESIS, type Tier } from './lod';

const idx = (t: Tier) => TIER_ORDER.indexOf(t);

describe('lodTier — nominal bands (no prevTier)', () => {
  it.each<[number, Tier]>([
    [0.05, 'mini'],
    [0.15, 'mini'],
    [0.28, 'mini'], // 1080p fit-all lands here
    [0.299, 'mini'],
    [0.3, 'compact'], // lower bound inclusive
    [0.376, 'compact'], // 1440p fit = the design point
    [0.5, 'compact'],
    [0.519, 'compact'],
    [0.52, 'full'], // lower bound inclusive
    [0.565, 'full'], // 2160p fit
    [0.8, 'full'],
    [0.949, 'full'],
    [0.95, 'dock'], // lower bound inclusive
    [1.0, 'dock'],
    [1.4, 'dock'],
  ])('zoom %f → %s', (zoom, tier) => {
    expect(lodTier(zoom)).toBe(tier);
  });

  it('matches the exported thresholds 0.30 / 0.52 / 0.95', () => {
    expect(TIER_LOWER.compact).toBe(0.3);
    expect(TIER_LOWER.full).toBe(0.52);
    expect(TIER_LOWER.dock).toBe(0.95);
    expect(TIER_ORDER).toEqual(['mini', 'compact', 'full', 'dock']);
  });
});

describe('lodTier — prevTier passthrough when in the same band', () => {
  it('returns the nominal tier unchanged when prevTier already equals it', () => {
    expect(lodTier(0.4, 'compact')).toBe('compact');
    expect(lodTier(0.7, 'full')).toBe('full');
    expect(lodTier(1.2, 'dock')).toBe('dock');
    expect(lodTier(0.1, 'mini')).toBe('mini');
  });
});

describe('lodTier — hysteresis around each boundary', () => {
  // compact ↔ full boundary is 0.52; deadband is [0.50, 0.54].
  it('stays compact just above the boundary (inside the up-deadband)', () => {
    expect(lodTier(0.52, 'compact')).toBe('compact');
    expect(lodTier(0.53, 'compact')).toBe('compact');
  });
  it('promotes to full only after clearing boundary + hysteresis', () => {
    expect(lodTier(0.55, 'compact')).toBe('full'); // clearly past 0.52 + 0.02
  });
  it('stays full just below the boundary (inside the down-deadband)', () => {
    expect(lodTier(0.52, 'full')).toBe('full');
    expect(lodTier(0.51, 'full')).toBe('full');
  });
  it('demotes to compact only after dropping below boundary - hysteresis', () => {
    expect(lodTier(0.48, 'full')).toBe('compact'); // clearly below 0.52 - 0.02
  });

  // mini ↔ compact boundary 0.30; deadband [0.28, 0.32].
  it('mini↔compact deadband is sticky both ways', () => {
    expect(lodTier(0.3, 'mini')).toBe('mini'); // inside up-deadband
    expect(lodTier(0.29, 'compact')).toBe('compact'); // inside down-deadband
    expect(lodTier(0.33, 'mini')).toBe('compact'); // cleared up
    expect(lodTier(0.27, 'compact')).toBe('mini'); // cleared down
  });

  // full ↔ dock boundary 0.95; deadband [0.93, 0.97].
  it('full↔dock deadband is sticky both ways', () => {
    expect(lodTier(0.95, 'full')).toBe('full'); // inside up-deadband
    expect(lodTier(0.94, 'dock')).toBe('dock'); // inside down-deadband
    expect(lodTier(0.98, 'full')).toBe('dock'); // cleared up
    expect(lodTier(0.92, 'dock')).toBe('full'); // cleared down
  });

  it('does not oscillate while dithering ON a boundary', () => {
    // Park a pinch exactly on 0.52 and jitter ±0.01 (well inside the ±0.02
    // deadband). Whichever tier we entered with, we must NOT flip.
    let tier: Tier = 'compact';
    for (const z of [0.52, 0.51, 0.53, 0.52, 0.515, 0.525, 0.52]) {
      tier = lodTier(z, tier);
      expect(tier).toBe('compact');
    }
    tier = 'full';
    for (const z of [0.52, 0.53, 0.51, 0.52, 0.525, 0.515, 0.52]) {
      tier = lodTier(z, tier);
      expect(tier).toBe('full');
    }
  });
});

describe('lodTier — monotonic sweep threading prevTier', () => {
  it('never decreases tier while zooming IN', () => {
    let prev: Tier | undefined;
    let lastIdx = -1;
    for (let z = 0.05; z <= 1.5 + 1e-9; z += 0.005) {
      prev = lodTier(z, prev);
      expect(idx(prev)).toBeGreaterThanOrEqual(lastIdx);
      lastIdx = idx(prev);
    }
    expect(prev).toBe('dock');
  });

  it('never increases tier while zooming OUT', () => {
    let prev: Tier | undefined = 'dock';
    let lastIdx = idx('dock');
    for (let z = 1.5; z >= 0.05 - 1e-9; z -= 0.005) {
      prev = lodTier(z, prev);
      expect(idx(prev)).toBeLessThanOrEqual(lastIdx);
      lastIdx = idx(prev);
    }
    expect(prev).toBe('mini');
  });

  it('a full round-trip returns to the starting tier', () => {
    let prev: Tier | undefined = 'mini';
    for (let z = 0.05; z <= 1.5; z += 0.01) prev = lodTier(z, prev);
    expect(prev).toBe('dock');
    for (let z = 1.5; z >= 0.05; z -= 0.01) prev = lodTier(z, prev);
    expect(prev).toBe('mini');
  });
});

describe('lodTier — multi-step jumps snap to nominal', () => {
  it('jumps straight past intermediate tiers when the zoom leaps', () => {
    expect(lodTier(1.3, 'mini')).toBe('dock'); // mini → dock in one step
    expect(lodTier(0.1, 'dock')).toBe('mini'); // dock → mini in one step
    expect(lodTier(0.8, 'mini')).toBe('full'); // mini → full (skips compact)
    expect(lodTier(0.35, 'dock')).toBe('compact'); // dock → compact (skips full)
  });
});

describe('lodTier — guards', () => {
  it('non-finite zoom collapses to the richest tier (dock)', () => {
    expect(lodTier(NaN)).toBe('dock');
    expect(lodTier(Infinity)).toBe('dock');
    expect(lodTier(-Infinity)).toBe('dock');
    expect(lodTier(NaN, 'mini')).toBe('dock');
  });

  it('an unknown prevTier is ignored (falls back to nominal)', () => {
    expect(lodTier(0.4, 'native' as unknown as Tier)).toBe('compact');
  });

  it('very small / zero / negative zoom is mini', () => {
    expect(lodTier(0)).toBe('mini');
    expect(lodTier(-1)).toBe('mini');
    expect(lodTier(0.001)).toBe('mini');
  });

  it('hysteresis constant is the documented ±0.02', () => {
    expect(TIER_HYSTERESIS).toBe(0.02);
  });
});
