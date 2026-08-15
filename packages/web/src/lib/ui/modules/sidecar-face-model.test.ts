// packages/web/src/lib/ui/modules/sidecar-face-model.test.ts
//
// THE ORACLE + THE PERMANENT NEGATIVE CONTROLS for the SIDECAR faceplate.
//
// Two jobs, and the second is the one that makes this file worth having:
//
//   1. ORACLE — every closed form in `sidecar-face-model.ts` is re-derived from
//      the SHIPPING DSP (`packages/dsp/src/lib/compressor-dsp.ts`, imported
//      directly — the cube-face-model precedent) rather than from a comment. A
//      DSP change turns a stale faceplate claim RED instead of leaving the
//      panel insisting on a repaired defect.
//
//   2. NEGATIVE CONTROLS, PERMANENTLY — for each of the four readouts, the
//      input a KNOB READBACK would be blind to is perturbed and the printed
//      string is asserted to MOVE, and the input it must be invariant to is
//      perturbed and asserted NOT to move. Both directions, on every run. A
//      check you ran once at authoring time is a check nobody is watching.
//
// The four readouts are also each other's controls, which is the strongest
// form available here: `onset` moves with KNEE and `duck` structurally cannot
// (a detector at +6.02 dB is past the knee at every width), so a change that
// broke either into "the same number twice" reddens.

import { describe, it, expect } from 'vitest';

import {
  computeGainDb,
  envOut,
  makeSidecarState,
  sidecarStep,
  smootherCoef,
  hpfCoef,
  DB_PER_LOG2,
  ENV_SCALE_DB,
} from '../../../../../dsp/src/lib/compressor-dsp';

import { sidecarDef } from '$lib/audio/modules/sidecar';
import {
  SIDECAR_DB_PER_LOG2,
  SIDECAR_DEFAULTS,
  SIDECAR_ENV_SCALE_DB,
  SIDECAR_MONO_SUM_OFFSET_DB,
  SIDECAR_REFERENCE_DETECTOR_DB,
  sidecarDuckDb,
  sidecarDuckText,
  sidecarEnvAtRef,
  sidecarEnvText,
  sidecarFaceParams,
  sidecarGainDb,
  sidecarOnsetDbfs,
  sidecarOnsetText,
  sidecarScGainDb,
  sidecarScGainText,
  type SidecarFaceParams,
} from './sidecar-face-model';

const SR = 48000;

/** A reader over an explicit param map — the shape `FaceReadoutValue` gets. */
function reader(p: Partial<Record<string, number>>) {
  return (id: string) => p[id];
}

function withParams(over: Partial<SidecarFaceParams>): SidecarFaceParams {
  return { ...SIDECAR_DEFAULTS, ...over };
}

/** Render the SHIPPING per-sample pipeline and return the steady-state
 *  sidechain gain (the SC pair carries DC 1.0, so the output IS the gain). */
function renderScGain(over: Partial<SidecarFaceParams & { attack: number; release: number }>): number {
  const p = { ...SIDECAR_DEFAULTS, attack: 10, release: 100, ...over };
  const st = makeSidecarState(SR, p.threshold, p.envMag, p.inputLevel);
  const args = {
    threshold: p.threshold,
    ratio: p.ratio,
    knee: p.knee,
    envMag: p.envMag,
    inputLevel: p.inputLevel,
    makeup: p.makeup,
    aAtt: smootherCoef(p.attack, SR),
    aRel: smootherCoef(p.release, SR),
    hpfA: hpfCoef(20, SR),
  };
  let last = 0;
  for (let i = 0; i < SR * 0.2; i++) last = sidecarStep(0, 0, 1, 1, args, st).outL;
  return last;
}

describe('sidecar face model — ORACLE against the shipping DSP', () => {
  it('the mirrored constants ARE the DSP constants', () => {
    expect(SIDECAR_DB_PER_LOG2).toBe(DB_PER_LOG2);
    expect(SIDECAR_ENV_SCALE_DB).toBe(ENV_SCALE_DB);
    // The mono-sum offset is 20·log10(2) for a reason independent of the
    // log2→dB bridge, and it happens to equal it. Assert the VALUE, so a
    // refactor that changed one and not the other is caught.
    expect(SIDECAR_MONO_SUM_OFFSET_DB).toBeCloseTo(6.020599913, 9);
    expect(SIDECAR_REFERENCE_DETECTOR_DB).toBeCloseTo(6.020599913, 9);
  });

  it('the restated defaults ARE the def defaults', () => {
    // The model restates them so a fresh node (sparse `node.params`) prints the
    // shipped answer. A restated constant is a drift hazard, so anchor it.
    for (const [id, v] of Object.entries(SIDECAR_DEFAULTS)) {
      const declared = sidecarDef.params.find((p) => p.id === id);
      expect(declared, `${id} must be a declared sidecar param`).toBeTruthy();
      expect(declared?.defaultValue, `${id} default`).toBe(v);
    }
  });

  it('sidecarGainDb reproduces computeGainDb across the WHOLE control space', () => {
    const worst: string[] = [];
    for (const threshold of [-60, -40, -24, -18, -6, 0]) {
      for (const knee of [0, 3, 6, 12, 24]) {
        for (const ratio of [1, 1.5, 2, 4, 8, 20]) {
          for (const detDb of [-70, -40, -24, -21, -18, -15, -6, 0, 6.0206, 12]) {
            const mine = sidecarGainDb(detDb, withParams({ threshold, knee, ratio }));
            const theirs = computeGainDb(detDb / DB_PER_LOG2, threshold, knee, ratio);
            if (Math.abs(mine - theirs) > 1e-9) {
              worst.push(`thr=${threshold} knee=${knee} ratio=${ratio} det=${detDb}: ${mine} vs ${theirs}`);
            }
          }
        }
      }
    }
    expect(worst, 'model/DSP disagreements (dB)').toEqual([]);
  });

  it('NEGATIVE CONTROL on the ORACLE: a perturbed mirror DOES redden', () => {
    // If the comparison above could not fail, it would be decoration. Break the
    // knee term the way a careless edit would (half-width vs full width) and
    // confirm the SAME comparison separates them.
    const bad = (detDb: number, p: SidecarFaceParams): number => {
      const slope = 1 - 1 / Math.max(1, p.ratio);
      const halfKn = p.knee * 0.5;
      if (p.knee <= 0 || detDb <= p.threshold - halfKn) {
        return detDb <= p.threshold ? 0 : -slope * (detDb - p.threshold);
      }
      if (detDb >= p.threshold + halfKn) return -slope * (detDb - p.threshold);
      const t = detDb - p.threshold + halfKn;
      return (-slope * (t * t)) / (2 * halfKn); // ⚠ halfKn, not knee
    };
    const p = withParams({ threshold: -18, knee: 6, ratio: 4 });
    const det = -18;
    expect(Math.abs(sidecarGainDb(det, p) - computeGainDb(det / DB_PER_LOG2, -18, 6, 4))).toBeLessThan(1e-9);
    expect(Math.abs(bad(det, p) - computeGainDb(det / DB_PER_LOG2, -18, 6, 4))).toBeGreaterThan(0.1);
  });

  it('SC GAIN is what the SHIPPING pipeline actually renders', () => {
    // The claim: `20·log10(inputLevel) + makeup`, i.e. the two knobs are ONE
    // dimension. Driven through sidecarStep with a silent MAIN (duckLin = 1).
    for (const [inputLevel, makeup] of [
      [1, 0],
      [2, 0],
      [1, 6.020599913],
      [0.5, 6.020599913],
      [1, 12],
      [0.25, 12.041199827],
      [0, 24],
    ] as const) {
      const rendered = renderScGain({ inputLevel, makeup });
      const predictedDb = sidecarScGainDb(withParams({ inputLevel, makeup }));
      const renderedDb = rendered > 0 ? 20 * Math.log10(rendered) : Number.NEGATIVE_INFINITY;
      if (predictedDb === Number.NEGATIVE_INFINITY) {
        expect(rendered, 'inputLevel 0 must be bit-exactly silent').toBe(0);
      } else {
        expect(renderedDb, `inLvl=${inputLevel} makeup=${makeup} (dB)`).toBeCloseTo(predictedDb, 6);
      }
    }
  });

  it('ENV at the reference is what the SHIPPING envOut computes', () => {
    for (const envMag of [0, 0.5, 1, 2]) {
      for (const ratio of [1, 4, 20]) {
        const p = withParams({ envMag, ratio });
        expect(sidecarEnvAtRef(p), `envMag=${envMag} ratio=${ratio}`).toBeCloseTo(
          envOut(sidecarDuckDb(p), envMag),
          12,
        );
      }
    }
  });

  it('ONSET is the level at which the SHIPPING gain computer first reduces', () => {
    // Sweep the detector upward in 0.01 dB steps and find the first level with
    // any reduction, then compare with the closed form (converted back from
    // MAIN dBFS to detector dB). The sweep is the instrument; the closed form
    // is the claim.
    for (const threshold of [-60, -24, -18, -6]) {
      for (const knee of [0, 3, 6, 12, 24]) {
        let firstDet = Number.NaN;
        for (let det = threshold - knee - 5; det <= threshold + knee + 5; det += 0.01) {
          if (computeGainDb(det / DB_PER_LOG2, threshold, knee, 4) < -1e-9) {
            firstDet = det;
            break;
          }
        }
        const predictedDet = sidecarOnsetDbfs(withParams({ threshold, knee })) + SIDECAR_MONO_SUM_OFFSET_DB;
        expect(firstDet, `thr=${threshold} knee=${knee}: swept onset (detector dB)`).toBeCloseTo(
          predictedDet,
          1,
        );
      }
    }
  });
});

describe('sidecar face model — the PERMANENT negative controls', () => {
  it('ONSET moves with KNEE, which the THRESHOLD readback is blind to', () => {
    const thr = -18;
    const seen = [0, 6, 24].map((knee) => sidecarOnsetText(withParams({ threshold: thr, knee })));
    expect(new Set(seen).size, `onset must differ per knee, saw ${JSON.stringify(seen)}`).toBe(3);
    // …and the knob readback it replaces genuinely cannot: `threshold` is the
    // same number in all three states, which is the whole reason for `valueId`.
    expect(new Set([0, 6, 24].map(() => thr)).size).toBe(1);
    // The shipped defaults: nine dB from what the dial says.
    expect(sidecarOnsetText(SIDECAR_DEFAULTS)).toBe('-27.0 dB');
  });

  it('ONSET moves with the MONO-SUM OFFSET the threshold knob cannot see', () => {
    // A hard knee removes the knee term entirely, so what remains between the
    // dial and the answer is the detector's `|aL|+|aR|` — 6.02 dB of it.
    const hard = withParams({ knee: 0 });
    expect(sidecarOnsetDbfs(hard)).toBeCloseTo(-18 - 6.020599913, 9);
    expect(sidecarOnsetDbfs(hard)).not.toBeCloseTo(-18, 3);
  });

  it('DUCK moves with THRESHOLD, which the RATIO readback is blind to', () => {
    const seen = [-40, -18, -6].map((threshold) => sidecarDuckText(withParams({ threshold })));
    expect(new Set(seen).size, `duck must differ per threshold, saw ${JSON.stringify(seen)}`).toBe(3);
    expect(sidecarDuckText(SIDECAR_DEFAULTS)).toBe('-18.0 dB');
  });

  it('DUCK is KNEE-INVARIANT at the reference — the two readouts are each other\'s control', () => {
    // If this ever starts moving, `onset` and `duck` have collapsed into the
    // same fact and one of them is redundant.
    const seen = [0, 6, 24].map((knee) => sidecarDuckDb(withParams({ knee })));
    expect(Math.max(...seen) - Math.min(...seen), 'knee span at the reference (dB)').toBeLessThan(1e-9);
    // And its own inverse leg: onset must NOT be threshold-invariant.
    expect(sidecarOnsetDbfs(withParams({ threshold: -40 }))).not.toBeCloseTo(
      sidecarOnsetDbfs(withParams({ threshold: -6 })),
      3,
    );
  });

  it('DUCK exposes the dial\'s non-linearity: ratio 8 → 20 buys under 2 dB', () => {
    const at = (ratio: number) => sidecarDuckDb(withParams({ ratio }));
    expect(at(1)).toBeCloseTo(0, 9);
    expect(at(2)).toBeCloseTo(-12.0103, 3);
    expect(at(4)).toBeCloseTo(-18.0155, 3);
    expect(at(8)).toBeCloseTo(-21.0181, 3);
    expect(at(20)).toBeCloseTo(-22.8196, 3);
    expect(at(20) - at(8), 'the top 60 % of the RATIO travel, in dB').toBeGreaterThan(-2);
  });

  it('SC GAIN moves with INPUT LVL, which the MAKEUP readback is blind to — and vice versa', () => {
    const byLevel = [0.5, 1, 2].map((inputLevel) => sidecarScGainText(withParams({ inputLevel })));
    expect(new Set(byLevel).size, `sc gain must differ per inputLevel, saw ${JSON.stringify(byLevel)}`).toBe(3);
    const byMakeup = [0, 6, 24].map((makeup) => sidecarScGainText(withParams({ makeup })));
    expect(new Set(byMakeup).size, `sc gain must differ per makeup, saw ${JSON.stringify(byMakeup)}`).toBe(3);
    // THE FINDING ITSELF: the two knobs are one dimension, so equivalent pairs
    // must print the SAME string. Neither knob's own readback can say this.
    expect(sidecarScGainText(withParams({ inputLevel: 2, makeup: 0 }))).toBe(
      sidecarScGainText(withParams({ inputLevel: 1, makeup: 6.020599913 })),
    );
    expect(sidecarScGainText(withParams({ inputLevel: 0.5, makeup: 6.020599913 }))).toBe(
      sidecarScGainText(withParams({ inputLevel: 1, makeup: 0 })),
    );
  });

  it('SC GAIN reports the ENABLER state: at INPUT LVL 0, MAKEUP has no authority', () => {
    for (const makeup of [0, 12, 24]) {
      expect(sidecarScGainText(withParams({ inputLevel: 0, makeup }))).toBe('silent');
    }
    // …and the render agrees, bit-exactly.
    expect(renderScGain({ inputLevel: 0, makeup: 24 })).toBe(0);
  });

  it('ENV moves with the DETECTION chain, which the ENV MAG readback is blind to', () => {
    const seen = [1, 4, 20].map((ratio) => sidecarEnvText(withParams({ ratio })));
    expect(new Set(seen).size, `env must differ per ratio, saw ${JSON.stringify(seen)}`).toBe(3);
    const byThreshold = [-40, -18].map((threshold) => sidecarEnvText(withParams({ threshold })));
    expect(new Set(byThreshold).size).toBe(2);
  });

  it('ENV prints OVER above 1.0 — at the DEFAULT envMag, which is the doc defect', () => {
    // The def said overshoot happens "above 1" envMag. It happens whenever the
    // reduction passes 24 dB, at any envMag > 0.
    const deep = withParams({ threshold: -50, ratio: 20, envMag: 1 });
    expect(-sidecarDuckDb(deep)).toBeGreaterThan(SIDECAR_ENV_SCALE_DB);
    expect(sidecarEnvText(deep)).toMatch(/ over$/);
    // …and the ordinary case does not cry wolf.
    expect(sidecarEnvText(SIDECAR_DEFAULTS)).toBe('0.75');
  });

  it('ENV reports OFF at envMag 0, where both CV outputs are constants', () => {
    expect(sidecarEnvText(withParams({ envMag: 0, ratio: 20, threshold: -50 }))).toBe('off');
  });

  it('ENV MAG is AUDIO-INVARIANT — measured on the shipping pipeline', () => {
    // The reason envMag is the lowest-ranked control in the module. Same SC
    // render at four envMag values must be bit-identical.
    const outs = [0, 0.5, 1, 2].map((envMag) => renderScGain({ envMag }));
    expect(new Set(outs).size, `sc output must not move with envMag, saw ${JSON.stringify(outs)}`).toBe(1);
  });
});

describe('sidecar face model — TOTALITY (it runs on every render of every frame)', () => {
  const HOSTILE: Array<number | undefined> = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1e9,
    1e9,
    0,
  ];

  it('a fresh node (NOTHING touched) prints the shipped answers', () => {
    const read = reader({});
    const p = sidecarFaceParams(read);
    expect(p).toEqual(SIDECAR_DEFAULTS);
    expect(sidecarOnsetText(p)).toBe('-27.0 dB');
    expect(sidecarDuckText(p)).toBe('-18.0 dB');
    expect(sidecarScGainText(p)).toBe('0.0 dB');
    expect(sidecarEnvText(p)).toBe('0.75');
  });

  it('a PARTIALLY touched node defaults each param independently', () => {
    const p = sidecarFaceParams(reader({ threshold: -30 }));
    expect(p.threshold).toBe(-30);
    expect(p.ratio).toBe(SIDECAR_DEFAULTS.ratio);
    expect(p.knee).toBe(SIDECAR_DEFAULTS.knee);
  });

  it('every readout is TOTAL over hostile inputs — never throws, never prints a raw NaN', () => {
    const ids = ['threshold', 'ratio', 'knee', 'inputLevel', 'makeup', 'envMag'] as const;
    const printers = [sidecarOnsetText, sidecarDuckText, sidecarScGainText, sidecarEnvText];
    for (const id of ids) {
      for (const v of HOSTILE) {
        const p = sidecarFaceParams(reader({ [id]: v }));
        for (const f of printers) {
          const s = f(p);
          expect(typeof s, `${f.name}(${id}=${String(v)})`).toBe('string');
          expect(s.length, `${f.name}(${id}=${String(v)}) must not be empty`).toBeGreaterThan(0);
          expect(s, `${f.name}(${id}=${String(v)}) must not leak a raw non-number`).not.toMatch(
            /NaN|Infinity|undefined/,
          );
        }
      }
    }
  });

  it('NEGATIVE CONTROL on the totality leg: the hostile set REACHES the printers', () => {
    // Without this, a `finite()` that silently swallowed everything would make
    // the sweep above pass over six copies of the default state.
    expect(sidecarFaceParams(reader({ threshold: Number.NaN })).threshold).toBe(
      SIDECAR_DEFAULTS.threshold,
    );
    expect(sidecarFaceParams(reader({ threshold: -30 })).threshold).toBe(-30);
    expect(sidecarOnsetText(withParams({ threshold: -30 }))).not.toBe(
      sidecarOnsetText(SIDECAR_DEFAULTS),
    );
  });
});
