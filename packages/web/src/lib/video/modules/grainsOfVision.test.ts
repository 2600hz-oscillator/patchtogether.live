// packages/web/src/lib/video/modules/grainsOfVision.test.ts
//
// GRAINS OF VISION — module-def shape + the pure grain/feedback/reverb/composite
// math (no GL). The exported helpers are the EXACT CPU MIRROR of the GLSL passes
// (the EDGES / CELLSHADE / BACKDRAFT source-of-truth pattern), so unit-testing
// them pins the semantics the shaders transliterate:
//   - hashes are deterministic + in [0,1);
//   - density→cells + rate→delayFrames clamp/round correctly;
//   - grain window: 1 at centre, 0 outside, monotone-decreasing, window knob
//     widens the soft shoulder;
//   - temporal frac gates on the past tap + scales with time_spray;
//   - feedbackUv identity at zoom1/rot0 + inverts zoom about centre;
//   - feedback composite is a true DRY passthrough at amount 0;
//   - reverb accumulate + blend + the two DRY-passthrough predicates;
//   - composite mode modulators are neutral off-mode + move the right axis.

import { describe, it, expect } from 'vitest';
import {
  grainsOfVisionDef,
  govMix,
  govLuma,
  govHash21,
  govHash22,
  govDensityToCells,
  govDelayFrames,
  govGrainWindow,
  govTemporalFrac,
  govFeedbackUv,
  govFeedbackComposite,
  govReverbAcc,
  govReverbBlend,
  govReverbIsDry,
  govFeedbackIsDry,
  govCompositeWeightMul,
  govCompositeSizeMul,
  govCompositeRateOffset,
  GRAINS_OF_VISION_DEFAULTS,
  GOV_HISTORY_FRAMES,
  GOV_COMPOSITE_MODES,
  GOV_COMPOSITE_MODE_COUNT,
} from './grainsOfVision';

describe('GRAINS OF VISION — def shape', () => {
  const def = grainsOfVisionDef;

  it('is a video processor with the canonical identity', () => {
    expect(def.type).toBe('grainsOfVision');
    expect(def.domain).toBe('video');
    expect(def.label).toBe('grains of vision'); // lowercase (repo standard)
    expect(def.palette).toEqual({ top: 'Video modules', sub: 'Processors' });
    // texture-only feedback processor (cf. BACKDRAFT/FEEDBACK) — NOT pullExempt.
    expect(def.pullExempt).toBeUndefined();
  });

  it('has TWO video inputs (A primary + B modulator) and TWO video outputs', () => {
    const vids = def.inputs.filter((p) => p.type === 'video').map((p) => p.id);
    expect(vids).toEqual(['in_a', 'in_b']);
    expect(def.outputs.map((p) => p.id)).toEqual(['out', 'grains']);
    expect(def.outputs.every((p) => p.type === 'video')).toBe(true);
  });

  it('every CV input targets a real param + has a cvScale (cv-scale-registry)', () => {
    const paramIds = new Set(def.params.map((p) => p.id));
    for (const port of def.inputs) {
      if (port.type !== 'cv') continue;
      expect(port.paramTarget, `${port.id} has a paramTarget`).toBeTruthy();
      expect(paramIds.has(port.paramTarget!), `${port.id} → real param`).toBe(true);
      expect(port.cvScale, `${port.id} declares a cvScale`).toBeTruthy();
    }
    // composite uses a DISCRETE cvScale so CV snaps to the 5 modes.
    const comp = def.inputs.find((p) => p.id === 'composite');
    expect(comp?.cvScale?.mode).toBe('discrete');
  });

  it('composite param spans the 5 modes as a discrete knob', () => {
    const comp = def.params.find((p) => p.id === 'composite')!;
    expect(comp.curve).toBe('discrete');
    expect(comp.min).toBe(0);
    expect(comp.max).toBe(GOV_COMPOSITE_MODE_COUNT - 1);
    expect(GOV_COMPOSITE_MODES).toEqual(['off', 'density', 'displace', 'size', 'rate']);
  });

  it('the two dry toggles + freeze exist and have no CV input (like BACKDRAFT)', () => {
    for (const id of ['fb_dry', 'rev_dry', 'freeze']) {
      expect(def.params.find((p) => p.id === id), `${id} param`).toBeTruthy();
      expect(def.inputs.find((p) => p.paramTarget === id), `${id} has NO cv input`).toBeUndefined();
    }
  });

  it('every param default is inside its declared range', () => {
    for (const p of def.params) {
      expect(p.defaultValue).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue).toBeLessThanOrEqual(p.max);
    }
  });

  it('ships co-located AUTHORED docs covering every port + param', () => {
    const docs = def.docs!;
    expect((docs.explanation ?? '').length).toBeGreaterThan(200);
    for (const port of def.inputs) expect(docs.inputs?.[port.id], `docs.inputs.${port.id}`).toBeTruthy();
    for (const port of def.outputs) expect(docs.outputs?.[port.id], `docs.outputs.${port.id}`).toBeTruthy();
    for (const p of def.params) expect(docs.controls?.[p.id], `docs.controls.${p.id}`).toBeTruthy();
  });

  it('defaults are musical/visible — not a degenerate black-frame recipe', () => {
    const d = GRAINS_OF_VISION_DEFAULTS;
    expect(d.density).toBeGreaterThan(2);       // a real grid
    expect(d.grain_size).toBeGreaterThanOrEqual(1); // overlapping grains (no gaps)
    expect(d.window).toBeGreaterThan(0);
    // feedback + reverb lightly on by default (lively), each still opt-out-able.
    expect(d.feedback).toBeGreaterThan(0);
    expect(d.rev_mix).toBeGreaterThan(0);
    expect(d.fb_dry).toBe(0);
    expect(d.rev_dry).toBe(0);
  });
});

describe('GRAINS OF VISION — hashes', () => {
  it('hash21 is deterministic + in [0,1)', () => {
    for (let i = 0; i < 50; i++) {
      const a = govHash21(i * 1.3, i * 2.7);
      const b = govHash21(i * 1.3, i * 2.7);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });

  it('hash22 returns two in-range values, decorrelated across cells', () => {
    const seen = new Set<string>();
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        const [u, v] = govHash22(x, y);
        expect(u).toBeGreaterThanOrEqual(0); expect(u).toBeLessThan(1);
        expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1);
        seen.add(`${u.toFixed(4)},${v.toFixed(4)}`);
      }
    }
    // 64 cells should map to (near-)64 distinct pairs — no gross collisions.
    expect(seen.size).toBeGreaterThan(60);
  });
});

describe('GRAINS OF VISION — grid + history mapping', () => {
  it('density → cells clamps to [2,48] and rounds', () => {
    expect(govDensityToCells(14)).toBe(14);
    expect(govDensityToCells(1)).toBe(2);
    expect(govDensityToCells(999)).toBe(48);
    expect(govDensityToCells(14.6)).toBe(15);
    expect(govDensityToCells(NaN)).toBe(14);
  });

  it('rate → delayFrames: 0 = live (0), 1 = deepest (ring-1), monotone', () => {
    expect(govDelayFrames(0)).toBe(0);
    expect(govDelayFrames(1)).toBe(GOV_HISTORY_FRAMES - 1);
    let prev = -1;
    for (let r = 0; r <= 1.0001; r += 0.1) {
      const d = govDelayFrames(r);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });
});

describe('GRAINS OF VISION — grain window', () => {
  it('is 1 at the centre, 0 at/beyond the edge, monotone-decreasing', () => {
    expect(govGrainWindow(0, 0.6)).toBeCloseTo(1, 5);
    expect(govGrainWindow(1, 0.6)).toBe(0);
    expect(govGrainWindow(1.5, 0.6)).toBe(0);
    let prev = 2;
    for (let d = 0; d <= 1.0; d += 0.05) {
      const w = govGrainWindow(d, 0.6);
      expect(w).toBeLessThanOrEqual(prev + 1e-9);
      prev = w;
    }
  });

  it('WINDOW knob: a hard box holds full weight across the interior, a soft window tapers from the centre', () => {
    // window 0 = a hard box: weight ~1 across almost the whole interior with a
    // narrow shoulder at the edge. window 1 = a soft window: the falloff
    // shoulder spans the whole radius, so at a MID distance it has already
    // tapered below the box.
    const hard = govGrainWindow(0.5, 0.0);
    const soft = govGrainWindow(0.5, 1.0);
    expect(hard).toBeCloseTo(1, 5);      // flat top
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeLessThan(hard);     // soft has tapered by mid-distance
    // both are full weight at the very centre.
    expect(govGrainWindow(0, 0.0)).toBeCloseTo(1, 5);
    expect(govGrainWindow(0, 1.0)).toBeCloseTo(1, 5);
  });
});

describe('GRAINS OF VISION — temporal frac', () => {
  it('is 0 when the past tap is disabled (rate 0 / cold start)', () => {
    expect(govTemporalFrac(0.9, 0.8, false)).toBe(0);
  });
  it('is 0 at time_spray 0 (all grains live) and scales with time_spray', () => {
    expect(govTemporalFrac(0.9, 0, true)).toBe(0);
    expect(govTemporalFrac(1, 0.5, true)).toBeCloseTo(0.5, 6);
    expect(govTemporalFrac(1, 1, true)).toBeCloseTo(1, 6);
  });
});

describe('GRAINS OF VISION — feedback', () => {
  it('feedbackUv is identity at zoom 1 / rot 0', () => {
    const r = govFeedbackUv(0.3, 0.7, 1, 0);
    expect(r.u).toBeCloseTo(0.3, 6);
    expect(r.v).toBeCloseTo(0.7, 6);
  });
  it('zoom > 1 samples a SMALLER region about the centre (magnifies the echo)', () => {
    const r = govFeedbackUv(1.0, 0.5, 2, 0); // edge pixel
    // undo-zoom pulls the sample toward centre: |u-0.5| shrinks by /zoom.
    expect(Math.abs(r.u - 0.5)).toBeCloseTo(0.25, 6);
  });
  it('composite is a true DRY passthrough at amount 0', () => {
    expect(govFeedbackComposite(0.42, 0.9, 0, 0.9)).toBeCloseTo(0.42, 6);
  });
  it('composite adds decayed feedback + clamps to [0,1]', () => {
    expect(govFeedbackComposite(0.5, 0.5, 0.5, 1.0)).toBeCloseTo(0.75, 6);
    expect(govFeedbackComposite(0.9, 1.0, 0.98, 1.0)).toBe(1); // clamped
  });
  it('dry predicate: amount 0 OR dry toggle', () => {
    expect(govFeedbackIsDry(0, 0)).toBe(true);
    expect(govFeedbackIsDry(0.4, 1)).toBe(true);
    expect(govFeedbackIsDry(0.4, 0)).toBe(false);
  });
});

describe('GRAINS OF VISION — reverb', () => {
  it('accumulator injects input + decayed tail', () => {
    expect(govReverbAcc(0.5, 0.4, 0.5)).toBeCloseTo(0.7, 6);
    expect(govReverbAcc(0.5, 0.4, 0)).toBeCloseTo(0.5, 6); // decay 0 = no tail
  });
  it('blend is dry at mix 0, wet at mix 1', () => {
    expect(govReverbBlend(0.2, 0.9, 0)).toBeCloseTo(0.2, 6);
    expect(govReverbBlend(0.2, 0.9, 1)).toBeCloseTo(0.9, 6);
    expect(govReverbBlend(0.2, 0.8, 0.5)).toBeCloseTo(0.5, 6);
  });
  it('dry predicate: mix 0 OR dry toggle', () => {
    expect(govReverbIsDry(0, 0)).toBe(true);
    expect(govReverbIsDry(0.25, 1)).toBe(true);
    expect(govReverbIsDry(0.25, 0)).toBe(false);
  });
});

describe('GRAINS OF VISION — composite modes', () => {
  const dark = govLuma(0.05, 0.05, 0.05);
  const bright = govLuma(0.95, 0.95, 0.95);

  it('density-map (mode 1): dark B thins grains, bright B keeps/boosts them; neutral off-mode', () => {
    expect(govCompositeWeightMul(0, bright, 1)).toBe(1); // off
    expect(govCompositeWeightMul(3, bright, 1)).toBe(1); // size mode → neutral for weight
    expect(govCompositeWeightMul(1, dark, 1)).toBeLessThan(1);
    expect(govCompositeWeightMul(1, bright, 1)).toBeGreaterThan(1);
    expect(govCompositeWeightMul(1, dark, 0)).toBe(1); // amount 0 = inert
  });

  it('size-map (mode 3): bright B enlarges grains, dark B shrinks them; neutral off-mode', () => {
    expect(govCompositeSizeMul(1, bright, 1)).toBe(1); // wrong mode → neutral
    expect(govCompositeSizeMul(3, bright, 1)).toBeGreaterThan(1);
    expect(govCompositeSizeMul(3, dark, 1)).toBeLessThan(1);
    expect(govCompositeSizeMul(3, bright, 0)).toBe(1); // amount 0 = inert
  });

  it('rate-map (mode 4): B luma scrubs the temporal read (bipolar about 0.5); neutral off-mode', () => {
    expect(govCompositeRateOffset(1, bright, 1)).toBe(0); // wrong mode
    expect(govCompositeRateOffset(4, bright, 1)).toBeGreaterThan(0);
    expect(govCompositeRateOffset(4, dark, 1)).toBeLessThan(0);
    expect(govCompositeRateOffset(4, bright, 0)).toBe(0); // amount 0 = inert
  });
});

describe('GRAINS OF VISION — scalar helpers', () => {
  it('mix + luma', () => {
    expect(govMix(0, 10, 0.25)).toBe(2.5);
    expect(govLuma(1, 0, 0)).toBeCloseTo(0.299, 6);
    expect(govLuma(1, 1, 1)).toBeCloseTo(1, 6);
  });
});
