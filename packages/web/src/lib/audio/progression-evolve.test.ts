// packages/web/src/lib/audio/progression-evolve.test.ts
//
// Unit tests for the progression-evolve helpers. Everything is pure so we
// can drive it with a seeded RNG and assert exact outputs.

import { describe, it, expect } from 'vitest';
import {
  detectKey,
  degreeInKey,
  isDiatonic,
  isStillRelated,
  evolveProgression,
  EVOLVE_RULES,
  type EvolveStep,
} from './progression-evolve';
import { CHORD_QUALITY_NAMES } from './chord-tables';

// Helper — build an EvolveStep with sensible defaults.
function step(opts: Partial<EvolveStep> & { root: number | null }): EvolveStep {
  return {
    on: opts.on ?? true,
    root: opts.root,
    quality: opts.quality ?? 'maj',
    inversion: opts.inversion ?? 0,
    voicing: opts.voicing ?? 'closed',
  };
}

/** Deterministic RNG — Mulberry32. Drives every random choice in evolve. */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('progression-evolve: key detection', () => {
  it('detects C major from I-IV-V-I (C-F-G-C)', () => {
    // Roots: C=60, F=65, G=67, C=60.
    const steps = [
      step({ root: 60, quality: 'maj' }),
      step({ root: 65, quality: 'maj' }),
      step({ root: 67, quality: 'maj' }),
      step({ root: 60, quality: 'maj' }),
    ];
    const k = detectKey(steps);
    expect(k.tonic).toBe(0);
    expect(k.mode).toBe('major');
  });

  it('detects A minor from ii-V-i (Bm7b5-E7-Am — roughly Bdim, E maj, Am)', () => {
    // A natural minor scale: A B C D E F G → roots A=57, B=59, E=64.
    // Use a clearer i-iv-v-i: Am-Dm-Em-Am.
    const steps = [
      step({ root: 57, quality: 'min' }), // i = Am
      step({ root: 62, quality: 'min' }), // iv = Dm
      step({ root: 64, quality: 'min' }), // v = Em
      step({ root: 57, quality: 'min' }), // i = Am
    ];
    const k = detectKey(steps);
    expect(k.tonic).toBe(9); // A
    expect(k.mode).toBe('minor');
  });

  it('defaults to C major when no real steps', () => {
    const steps: EvolveStep[] = [];
    const k = detectKey(steps);
    expect(k.tonic).toBe(0);
    expect(k.mode).toBe('major');
  });

  it('ignores steps with on=false or null root', () => {
    const steps = [
      step({ root: null, quality: 'maj' }),
      step({ root: 60, quality: 'maj', on: false }),
      step({ root: 60, quality: 'maj' }),
      step({ root: 65, quality: 'maj' }),
    ];
    const k = detectKey(steps);
    // Only C and F are real → C major.
    expect(k.tonic).toBe(0);
    expect(k.mode).toBe('major');
  });
});

describe('progression-evolve: degreeInKey', () => {
  it('returns 1 for the tonic root', () => {
    expect(degreeInKey(60, { tonic: 0, mode: 'major' })).toBe(1);
  });
  it('returns 5 for G in C major', () => {
    expect(degreeInKey(67, { tonic: 0, mode: 'major' })).toBe(5);
  });
  it('returns 0 for a non-diatonic root', () => {
    // C# is not in C major.
    expect(degreeInKey(61, { tonic: 0, mode: 'major' })).toBe(0);
  });
  it('handles minor scale correctly', () => {
    expect(degreeInKey(57, { tonic: 9, mode: 'minor' })).toBe(1); // A
    expect(degreeInKey(60, { tonic: 9, mode: 'minor' })).toBe(3); // C
  });
});

describe('progression-evolve: isDiatonic', () => {
  it('is true for scale tones in C major', () => {
    for (const r of [60, 62, 64, 65, 67, 69, 71]) {
      expect(isDiatonic(r, { tonic: 0, mode: 'major' })).toBe(true);
    }
  });
  it('is false for chromatic tones', () => {
    expect(isDiatonic(61, { tonic: 0, mode: 'major' })).toBe(false);
    expect(isDiatonic(63, { tonic: 0, mode: 'major' })).toBe(false);
  });
});

describe('progression-evolve: isStillRelated', () => {
  const cMajor = { tonic: 0, mode: 'major' as const };

  it('returns true for fully diatonic progressions', () => {
    const steps = [
      step({ root: 60 }), step({ root: 65 }), step({ root: 67 }), step({ root: 60 }),
    ];
    expect(isStillRelated(steps, cMajor)).toBe(true);
  });

  it('returns true when shifted to relative minor (A minor — same notes)', () => {
    const steps = [
      step({ root: 57 }), step({ root: 62 }), step({ root: 64 }), step({ root: 57 }),
    ];
    expect(isStillRelated(steps, cMajor)).toBe(true);
  });

  it('returns false when chord roots all chromatically out-of-key', () => {
    const steps = [
      step({ root: 61 }), step({ root: 63 }), step({ root: 66 }), step({ root: 68 }),
    ];
    // None of these are in C maj, G maj, F maj, or A min.
    expect(isStillRelated(steps, cMajor)).toBe(false);
  });
});

describe('progression-evolve: mutation rules produce valid output', () => {
  it('every rule entry has a known name and 0<weight<=1', () => {
    let sum = 0;
    for (const r of EVOLVE_RULES) {
      expect(typeof r.name).toBe('string');
      expect(r.weight).toBeGreaterThan(0);
      expect(r.weight).toBeLessThanOrEqual(1);
      sum += r.weight;
    }
    expect(sum).toBeCloseTo(1.0, 6);
  });

  it('evolveProgression returns valid roots (0..127) and known qualities', () => {
    const start = [
      step({ root: 60, quality: 'maj' }),
      step({ root: 65, quality: 'maj' }),
      step({ root: 67, quality: 'maj' }),
      step({ root: 60, quality: 'maj' }),
    ];
    // Try 50 different seeds.
    for (let seed = 1; seed <= 50; seed++) {
      const out = evolveProgression(start, { rng: seededRng(seed) });
      for (const s of out.steps) {
        if (s.root !== null) {
          expect(s.root).toBeGreaterThanOrEqual(0);
          expect(s.root).toBeLessThanOrEqual(127);
        }
        expect((CHORD_QUALITY_NAMES as readonly string[]).includes(s.quality)).toBe(true);
        expect([0, 1, 2]).toContain(s.inversion);
        expect(['closed', 'open', 'spread']).toContain(s.voicing);
      }
    }
  });
});

describe('progression-evolve: 100 random evolutions stay related to original key', () => {
  it('starting from C major I-IV-V-I, >=80% of resulting chords stay in related keys', () => {
    const start = [
      step({ root: 60, quality: 'maj' }),
      step({ root: 65, quality: 'maj' }),
      step({ root: 67, quality: 'maj' }),
      step({ root: 60, quality: 'maj' }),
    ];
    const origKey = { tonic: 0, mode: 'major' as const };

    let totalChords = 0;
    let relatedChords = 0;
    const relatedTonics = [
      { tonic: 0, mode: 'major' as const },
      { tonic: 7, mode: 'major' as const }, // G
      { tonic: 5, mode: 'major' as const }, // F
      { tonic: 9, mode: 'minor' as const }, // A min
    ];

    for (let seed = 1; seed <= 100; seed++) {
      const out = evolveProgression(start, { rng: seededRng(seed) });
      for (const s of out.steps) {
        if (s.root === null || !s.on) continue;
        totalChords += 1;
        const inAnyKey = relatedTonics.some((k) => isDiatonic(s.root as number, k));
        if (inAnyKey) relatedChords += 1;
      }
      // Sanity: result is still related per the isStillRelated heuristic.
      expect(isStillRelated(out.steps, origKey)).toBe(true);
    }
    const ratio = relatedChords / totalChords;
    expect(ratio).toBeGreaterThanOrEqual(0.8);
  });
});

describe('progression-evolve: blockedIndices respected', () => {
  it('never mutates a step in the recentlyMutated set when alternatives exist', () => {
    // Make 4 distinct chords; block index 0 — mutations should never land on 0.
    const start = [
      step({ root: 60, quality: 'maj' }),  // I
      step({ root: 62, quality: 'min' }),  // ii
      step({ root: 65, quality: 'maj' }),  // IV
      step({ root: 67, quality: 'maj' }),  // V
    ];
    for (let seed = 1; seed <= 30; seed++) {
      const out = evolveProgression(start, {
        rng: seededRng(seed),
        recentlyMutated: [0],
      });
      if (out.changedIndex !== null) {
        expect(out.changedIndex).not.toBe(0);
      }
    }
  });
});

describe('progression-evolve: noop fallback', () => {
  it('empty progression returns noop', () => {
    const out = evolveProgression([], { rng: seededRng(1) });
    expect(out.rule).toBe('noop');
    expect(out.changedIndex).toBeNull();
  });

  it('progression with no real steps returns noop', () => {
    const steps = [
      step({ root: null }),
      step({ root: null, on: false }),
    ];
    const out = evolveProgression(steps, { rng: seededRng(1) });
    expect(out.rule).toBe('noop');
  });
});

describe('progression-evolve: secondary dominant on V', () => {
  it('a V chord in C major can drift to V7 (dom7 quality)', () => {
    // Force the secondary-dominant path: rng=0.5 picks rule 2 (cumulative
    // weight crosses 0.55 at rule 2 since 0.40+0.15=0.55).
    // We use a many-attempt loop with different seeds to confirm at least
    // one outcome lands on V→V7.
    const start = [
      step({ root: 60, quality: 'maj' }),
      step({ root: 67, quality: 'maj' }), // V — eligible for V→V7
    ];
    let foundV7 = false;
    for (let seed = 1; seed <= 200; seed++) {
      const out = evolveProgression(start, { rng: seededRng(seed) });
      const v = out.steps[1];
      if (v && v.quality === 'dom7') { foundV7 = true; break; }
    }
    expect(foundV7).toBe(true);
  });
});

describe('progression-evolve: returns deep clone (does not mutate input)', () => {
  it('input array stays unchanged', () => {
    const start = [
      step({ root: 60, quality: 'maj' }),
      step({ root: 65, quality: 'maj' }),
      step({ root: 67, quality: 'maj' }),
      step({ root: 60, quality: 'maj' }),
    ];
    const snapshot = JSON.stringify(start);
    evolveProgression(start, { rng: seededRng(1) });
    expect(JSON.stringify(start)).toBe(snapshot);
  });
});
