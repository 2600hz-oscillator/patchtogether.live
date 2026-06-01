// art/scenarios/marbles/gate-and-cv.test.ts
//
// Audio Regression Test scenarios for MARBLES. Longer-render checks of clock
// rate scaling, gate-stream density, and X-section CV numerical stability
// across the T-model × scale cube.

import { describe, expect, it } from 'vitest';
import {
  marblesMath,
  MARBLES_T_MODEL_NAMES,
  MARBLES_SCALE_NAMES,
  type MarblesParams,
} from '../../../packages/web/src/lib/audio/modules/marbles';

const SR = 48000;

function base(o: Partial<MarblesParams> = {}): MarblesParams {
  return {
    rate: 24,
    t_model: 0,
    t_bias: 0.5,
    t_jitter: 0,
    deja_vu: 0,
    length: 8,
    pw_mean: 0.5,
    spread: 0.5,
    x_bias: 0.5,
    steps: 1,
    x_deja_vu: 0,
    x_length: 8,
    scale: 0,
    ...o,
  };
}

// Count rising edges in a 0/1 gate stream.
function risingEdges(buf: Float32Array): number {
  let e = 0;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i - 1]! < 0.5 && buf[i]! >= 0.5) e++;
  }
  return e;
}

describe('ART marbles / master clock rate scales with RATE', () => {
  it('a higher RATE produces more clock cycles over the same window', () => {
    const n = SR; // 1 second
    const slow = marblesMath.render(n, SR, base({ rate: 0 }));
    const fast = marblesMath.render(n, SR, base({ rate: 24 })); // +2 octaves
    const slowEdges = risingEdges(slow.clk);
    const fastEdges = risingEdges(fast.clk);
    expect(fastEdges, `fast ${fastEdges} > slow ${slowEdges}`).toBeGreaterThan(slowEdges);
  });

  it('clock edge count tracks the semitone→ratio rate law (roughly ×4 per +24 st)', () => {
    const n = SR;
    const a = risingEdges(marblesMath.render(n, SR, base({ rate: 0 })).clk);
    const b = risingEdges(marblesMath.render(n, SR, base({ rate: 24 })).clk);
    // +24 semitones = ×4 frequency. Allow a wide band for boundary effects.
    expect(b / Math.max(1, a)).toBeGreaterThan(2.5);
    expect(b / Math.max(1, a)).toBeLessThan(6);
  });
});

describe('ART marbles / gate streams are bounded 0/1 and finite', () => {
  it.each(MARBLES_T_MODEL_NAMES.map((nm, i) => [nm, i] as const))(
    'T model %s emits clean 0/1 gates',
    (_nm, idx) => {
      const n = SR / 2;
      const r = marblesMath.render(n, SR, base({ t_model: idx, rate: 36 }));
      for (let i = 0; i < n; i++) {
        expect(r.t1[i] === 0 || r.t1[i] === 1, `t1[${i}]=${r.t1[i]}`).toBe(true);
        expect(r.t2[i] === 0 || r.t2[i] === 1, `t2[${i}]=${r.t2[i]}`).toBe(true);
      }
    },
  );
});

describe('ART marbles / X CV stays in ±1 across every scale', () => {
  it.each(MARBLES_SCALE_NAMES.map((nm, i) => [nm, i] as const))(
    'scale %s keeps x1/x2/x3 in [-1,1] and finite',
    (_nm, idx) => {
      const n = SR / 4;
      const r = marblesMath.render(n, SR, base({ scale: idx, rate: 30 }));
      for (const buf of [r.x1, r.x2, r.x3]) {
        for (let i = 0; i < n; i++) {
          const v = buf[i]!;
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(-1.0001);
          expect(v).toBeLessThanOrEqual(1.0001);
        }
      }
    },
  );
});

describe('ART marbles / STEPS = 1 quantizes X1 to discrete levels', () => {
  it('full-quantize X1 takes fewer distinct values than free (steps=0)', () => {
    const n = SR;
    const quant = marblesMath.render(n, SR, base({ steps: 1, rate: 36, spread: 0.8 }));
    const free = marblesMath.render(n, SR, base({ steps: 0, rate: 36, spread: 0.8 }));
    const dq = new Set(Array.from(quant.x1).map((v) => v.toFixed(4))).size;
    const df = new Set(Array.from(free.x1).map((v) => v.toFixed(4))).size;
    expect(dq, `quantized distinct ${dq} < free distinct ${df}`).toBeLessThan(df);
  });
});
