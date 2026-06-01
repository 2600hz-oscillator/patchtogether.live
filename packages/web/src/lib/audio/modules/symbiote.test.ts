// packages/web/src/lib/audio/modules/symbiote.test.ts
//
// Unit tests for SYMBIOTE: Grids pattern lookup (drum-map + Euclidean) and
// the TB-3PO acid sequencer (determinism, step length, transpose, in-scale).

import { describe, it, expect } from 'vitest';
import { symbioteDef, symbioteMath, type SymbioteParams } from './symbiote';
import { PRESET_SCALES } from './marbles-engine';
import {
  GridsRandom,
  PatternGenerator,
  TB3PoSequencer,
  OUTPUT_MODE_DRUMS,
  OUTPUT_MODE_EUCLIDEAN,
} from './symbiote-engine';
import { GRIDS_NODES, GRIDS_EUCLIDEAN } from './grids-resources';

const SR = 32000;

function baseParams(o: Partial<SymbioteParams> = {}): SymbioteParams {
  return {
    rate: 36,
    sub_mode: 0,
    map_x: 0.5,
    map_y: 0.5,
    bd_density: 0.8,
    sd_density: 0.6,
    hh_density: 0.7,
    chaos: 0,
    euclid_length: 16,
    acid_density: 0.6,
    transpose: 0,
    acid_length: 16,
    scale: 0,
    seed_lock: 1,
    ...o,
  };
}

describe('symbioteDef registry shape', () => {
  it('exposes BD/SD/HH gate outs + acid clock/pitch/gate/accent', () => {
    const ids = symbioteDef.outputs.map((o) => o.id);
    expect(ids).toEqual(['t1', 't2', 't3', 'x1', 'x2', 'x3', 'y']);
    expect(symbioteDef.ossAttribution?.author).toBe('Émilie Gillet');
  });
  it('always-on Symbiote: exposes sub_mode + TB-3PO controls as params', () => {
    const ids = symbioteDef.params.map((p) => p.id);
    expect(ids).toContain('sub_mode');
    expect(ids).toContain('acid_density');
    expect(ids).toContain('transpose');
    expect(ids).toContain('acid_length');
  });
  it('every CV input carries a cvScale hint', () => {
    for (const i of symbioteDef.inputs) expect(i.cvScale, `${i.id}`).toBeTruthy();
  });
});

describe('grids resources', () => {
  it('has 25 drum-map nodes of 96 bytes each', () => {
    expect(GRIDS_NODES.length).toBe(25);
    for (const n of GRIDS_NODES) expect(n.length).toBe(96);
  });
  it('has a 1024-entry euclidean LUT', () => {
    expect(GRIDS_EUCLIDEAN.length).toBe(1024);
  });
});

describe('Grids PatternGenerator — drum-map lookup', () => {
  it('high density fires BD/SD/HH within a 32-step pattern', () => {
    const rng = new GridsRandom();
    const pg = new PatternGenerator(rng);
    pg.setOutputMode(OUTPUT_MODE_DRUMS);
    pg.settings.density = [255, 255, 255]; // max density → threshold 0
    let bd = false;
    let sd = false;
    let hh = false;
    for (let step = 0; step < 32; step++) {
      pg.tickClock(3); // one full step (kPulsesPerStep = 3)
      const s = pg.getState();
      bd ||= (s & 1) !== 0;
      sd ||= (s & 2) !== 0;
      hh ||= (s & 4) !== 0;
    }
    expect(bd).toBe(true);
    expect(sd).toBe(true);
    expect(hh).toBe(true);
  });

  it('zero density silences all voices (threshold 255 → level never exceeds)', () => {
    const rng = new GridsRandom();
    const pg = new PatternGenerator(rng);
    pg.setOutputMode(OUTPUT_MODE_DRUMS);
    pg.settings.density = [0, 0, 0];
    pg.settings.drums.randomness = 0;
    let anyHit = false;
    for (let step = 0; step < 32; step++) {
      pg.tickClock(3);
      if (pg.getState() & 0x07) anyHit = true;
    }
    // With randomness 0 and threshold 255, hits require level > 255 (impossible).
    expect(anyHit).toBe(false);
  });

  it('Euclidean mode at length 16 / mid density yields a sparse pattern', () => {
    const rng = new GridsRandom();
    const pg = new PatternGenerator(rng);
    pg.setOutputMode(OUTPUT_MODE_EUCLIDEAN);
    pg.settings.euclideanLength = [120, 120, 120]; // (120>>3)+1 = 16
    pg.settings.density = [128, 128, 128];
    let bdHits = 0;
    for (let step = 0; step < 32; step++) {
      pg.tickClock(3);
      if (pg.getState() & 1) bdHits++;
    }
    expect(bdHits).toBeGreaterThan(0);
    expect(bdHits).toBeLessThan(32);
  });
});

describe('TB-3PO acid sequencer', () => {
  it('is deterministic for a fixed seed', () => {
    function run(): number[] {
      const rng = new GridsRandom();
      const seq = new TB3PoSequencer(rng);
      seq.setScale(PRESET_SCALES[0]!);
      seq.setDensity(8, 0);
      seq.setLength(16);
      seq.setSeed(0x1234);
      const out: number[] = [];
      for (let i = 0; i < 16; i++) {
        seq.tick(i === 0);
        out.push(seq.getPitchVolts());
      }
      return out;
    }
    expect(run()).toEqual(run());
  });

  it('respects step length (wraps to 0 after num_steps)', () => {
    const rng = new GridsRandom();
    const seq = new TB3PoSequencer(rng);
    seq.setScale(PRESET_SCALES[0]!);
    seq.setLength(4);
    seq.setSeed(0xbeef);
    const steps: number[] = [];
    seq.tick(true); // step 0
    steps.push(seq.getStep());
    for (let i = 0; i < 5; i++) {
      seq.tick(false);
      steps.push(seq.getStep());
    }
    // 0,1,2,3,0,1
    expect(steps).toEqual([0, 1, 2, 3, 0, 1]);
  });

  it('transpose shifts pitch upward by whole scale degrees', () => {
    function firstGatedPitch(transpose: number): number {
      const rng = new GridsRandom();
      const seq = new TB3PoSequencer(rng);
      seq.setScale(PRESET_SCALES[0]!);
      seq.setDensity(14, 0); // dense → most steps gated
      seq.setLength(16);
      seq.setTranspose(transpose);
      seq.setSeed(0x2222);
      let p = 0;
      for (let i = 0; i < 16; i++) {
        seq.tick(i === 0);
        p = seq.getPitchVolts();
      }
      return p;
    }
    const low = firstGatedPitch(0);
    const high = firstGatedPitch(7); // +7 active degrees ≈ +1 octave on C major
    expect(high).toBeGreaterThanOrEqual(low);
  });

  it('produces in-scale pitches only (snaps to C-major degree voltages)', () => {
    const rng = new GridsRandom();
    const seq = new TB3PoSequencer(rng);
    seq.setScale(PRESET_SCALES[0]!); // C major
    seq.setDensity(10, 0);
    seq.setLength(16);
    seq.setSeed(0x9999);
    // In-scale C-major degree fractions (diatonic; the weighted passing tones
    // are filtered out by BuildActiveDegrees).
    const diatonic = [0.0, 0.1667, 0.3333, 0.4167, 0.5833, 0.75, 0.9167];
    for (let i = 0; i < 32; i++) {
      seq.tick(i === 0);
      if (!seq.gate()) continue;
      const v = seq.getPitchVolts();
      const frac = v - Math.floor(v);
      const inScale = diatonic.some((d) => Math.abs(frac - d) < 1e-3 || Math.abs(frac - d) > 0.999);
      expect(inScale, `pitch ${v} (frac ${frac}) should be in C major`).toBe(true);
    }
  });
});

describe('symbioteMath integration', () => {
  it('is deterministic and finite', () => {
    const a = symbioteMath.render(4000, SR, baseParams());
    const b = symbioteMath.render(4000, SR, baseParams());
    expect(Array.from(a.t1)).toEqual(Array.from(b.t1));
    expect(a.x2.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('emits drum gates on t1/t2/t3 over a long window', () => {
    const r = symbioteMath.render(16000, SR, baseParams({ rate: 48 }));
    expect(r.t1.some((v) => v > 0.5)).toBe(true);
    expect(r.t3.some((v) => v > 0.5)).toBe(true);
  });

  it('drives the acid gate (x3) and clock (x1)', () => {
    const r = symbioteMath.render(16000, SR, baseParams({ rate: 48, acid_density: 0.9 }));
    expect(r.x1.some((v) => v > 0.5)).toBe(true);
    expect(r.x1.some((v) => v < 0.5)).toBe(true);
    expect(r.x3.some((v) => v > 0.5)).toBe(true);
  });
});
