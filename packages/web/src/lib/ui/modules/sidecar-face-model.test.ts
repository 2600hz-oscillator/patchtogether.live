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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  SIDECAR_CURVE_DUCK_FLOOR_DB,
  SIDECAR_CURVE_MAIN_MAX_DBFS,
  SIDECAR_CURVE_MAIN_MIN_DBFS,
  SIDECAR_DB_PER_LOG2,
  SIDECAR_DEFAULTS,
  SIDECAR_ENV_SCALE_DB,
  SIDECAR_MONO_SUM_OFFSET_DB,
  SIDECAR_REFERENCE_DETECTOR_DB,
  SIDECAR_REFERENCE_MAIN_DBFS,
  sidecarClampMainDbfs,
  sidecarCurvePoints,
  sidecarCursorText,
  sidecarDetectorDb,
  sidecarDuckDb,
  sidecarDuckDbAt,
  sidecarDuckText,
  sidecarEnvAtRef,
  sidecarEnvText,
  sidecarFaceParams,
  sidecarOnsetDbfs,
  sidecarOnsetMarkDbfs,
  sidecarOnsetText,
  sidecarScGainDb,
  sidecarScGainText,
  sidecarScOutDbAt,
  sidecarThresholdMarkDbfs,
  type SidecarFaceParams,
} from './sidecar-face-model';

const SR = 48000;

// ── THE SOURCE GATE'S MACHINERY ─────────────────────────────────────────────
//
// ⚠ STATE THE GATE'S SCOPE INSIDE THE GATE. This is a TEXT match, not a parse,
// and it is deliberately conservative in the direction that costs an author a
// rewording rather than the one that lets a second copy of the law through: a
// COMMENT that spells either formula in code shape WILL fire. In these two
// files the law belongs in prose, so that is the right trade — and what it
// still cannot see is a copy written in a THIRD file that no one added here,
// which is why the list is named per file and anchored to the artifact.

/** The files that are allowed to talk about the gain computer — and therefore
 *  the files that must not contain one. Named individually, never a glob. */
const GAIN_LAW_CONSUMERS = ['sidecar-face-model.ts', 'SidecarTransferPanel.svelte'] as const;

function readSource(rel: string): string | null {
  try {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  } catch {
    return null;
  }
}

/** The two tells of a re-typed `computeGainDb`. Neither appears legitimately in
 *  a consumer: the slope is the DSP's own `1 - 1/max(1, ratio)`, and dividing
 *  by TWICE something is the GMR knee interpolation and nothing else here. */
function retypedGainLaw(text: string): string[] {
  const hits: string[] = [];
  if (/1\s*-\s*1\s*\/\s*Math\.max\s*\(\s*1\s*,/.test(text)) hits.push('slope 1-1/ratio');
  if (/\/\s*\(\s*2\s*\*\s*[A-Za-z_$][\w.$]*\s*\)/.test(text)) hits.push('knee quadratic');
  return hits;
}

/**
 * The SHIPPING per-sample pipeline's steady-state gain reduction for a MONO
 * main at `mainDbfs`, driven by a NYQUIST-RATE square (see the oracle's note:
 * the alternating input is what makes the detector CONSTANT behind the
 * detector HPF, so the residual is a known 0.0114 dB rather than a wobble the
 * smoother averages).
 */
function renderGainDb(mainDbfs: number, p: SidecarFaceParams): number {
  const st = makeSidecarState(SR, p.threshold, p.envMag, p.inputLevel);
  const args = {
    threshold: p.threshold,
    ratio: p.ratio,
    knee: p.knee,
    envMag: p.envMag,
    inputLevel: p.inputLevel,
    makeup: p.makeup,
    // Fast on both edges: the target is constant, so this only buys settling.
    aAtt: smootherCoef(0.1, SR),
    aRel: smootherCoef(1, SR),
    hpfA: hpfCoef(20, SR),
  };
  const amp = Math.pow(10, mainDbfs / 20);
  let gainDb = 0;
  for (let i = 0; i < SETTLE_SAMPLES; i++) {
    const a = i % 2 === 0 ? amp : -amp;
    gainDb = sidecarStep(a, a, 0, 0, args, st).gainDb;
  }
  return gainDb;
}

/**
 * How long to run the pipeline before reading the steady state.
 *
 * ⚠ SET BY THE SLOWEST TIME CONSTANT IN THE CHAIN, not by a round number of
 * milliseconds. The detector HPF is the slow one: τ = 1/(2π·20 Hz) ≈ 8 ms ≈ 382
 * samples at 48 kHz, so its start transient decays as `exp(-n/382)`. At 4000
 * samples that residual is ~3e-5, i.e. 0.0003 dB — two orders below the 0.02 dB
 * bound the oracle asserts, so the check is measuring the gain law and not the
 * filter warming up. (The smoother is far faster: τ = 0.1 ms ≈ 5 samples.)
 */
const SETTLE_SAMPLES = 4000;

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

  // ⚠ THE OLD ORACLE WAS DELETED, NOT WEAKENED — AND WHY MATTERS.
  //
  // Until the transfer-curve panel landed, `sidecarGainDb` carried its own
  // three-region copy of `computeGainDb` and this file swept the whole control
  // space asserting the copy agreed. `sidecarGainDb` is now a two-line
  // delegation to the shipping function, so that sweep became
  // `computeGainDb(x) === computeGainDb(x)`: it would have gone on passing
  // forever while proving nothing, which is exactly the shape of green gate
  // this repo's blind-gates rule is about. Two REAL checks replace it, asking
  // the two questions the sweep was standing in for:
  //
  //   1. Is the closed form the FACE prints what the SHIPPING PIPELINE actually
  //      does — including the detector sum, the log2 bridge and the smoother?
  //      (The sweep never covered those; it compared one function to a copy.)
  //   2. Is there still exactly ONE copy of the law? No runtime gate can see a
  //      second copy that happens to agree today, so that one is read off the
  //      SOURCE.

  it('the FACE\'S closed form is what the SHIPPING PIPELINE renders, end to end', () => {
    // The instrument: a NYQUIST-RATE square on the MAIN pair, both channels.
    //
    // ⚠ THE WAVEFORM IS THE MEASUREMENT DESIGN, not a convenience. The detector
    // sits behind a one-pole HPF, so a low-frequency probe DROOPS between
    // transitions and presents a WOBBLING level the asymmetric smoother then
    // averages — a systematic error that looks exactly like a model bug. An
    // alternating ±A input drives the HPF to a steady |y| = 2a/(1+a)·A, i.e. a
    // CONSTANT detector 0.0114 dB below the ideal 2A, so the smoother converges
    // to one value and the residual is a known, bounded, reportable number
    // rather than a mystery.
    const worst: string[] = [];
    let maxDev = 0;
    for (const over of [
      {},
      { ratio: 1 },
      { ratio: 2 },
      { ratio: 20 },
      { knee: 0 },
      { knee: 24 },
      { threshold: -50 },
      { threshold: 0 },
    ] as Partial<SidecarFaceParams>[]) {
      // Five levels, each a different REGION of the computer rather than a
      // pretty spread: below the onset, inside the knee, at the knee's top
      // edge, on the straight slope, and at the reference the readouts use.
      for (const mainDbfs of [-40, -24, -21, -12, 0]) {
        const p = withParams(over);
        const rendered = renderGainDb(mainDbfs, p);
        const claimed = sidecarDuckDbAt(p, mainDbfs);
        const dev = Math.abs(rendered - claimed);
        maxDev = Math.max(maxDev, dev);
        if (dev > 0.05) {
          worst.push(
            `${JSON.stringify(over)} main=${mainDbfs} dBFS: pipeline ${rendered.toFixed(4)} dB ` +
              `vs face ${claimed.toFixed(4)} dB (Δ ${dev.toFixed(4)} dB)`,
          );
        }
      }
    }
    expect(worst.join('\n'), 'face-vs-pipeline disagreements, in dB').toBe('');
    // And the residual is the HPF's known droop, not slack the check is hiding
    // behind: state it, in its units, so a real drift cannot park under it.
    expect(maxDev, 'worst face-vs-pipeline deviation (dB) — the HPF droop only').toBeLessThan(0.02);
  });

  it('NEGATIVE CONTROL on the PIPELINE oracle: a perturbed law DOES redden', () => {
    // If the comparison above could not fail it would be decoration. Break the
    // knee term the way a careless re-typing would (half-width vs full width)
    // and confirm the SAME comparison, against the SAME rendered pipeline,
    // separates them.
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
    // A main level INSIDE the knee, which is the only region the two differ in.
    const mainDbfs = -24;
    const rendered = renderGainDb(mainDbfs, p);
    expect(
      Math.abs(sidecarDuckDbAt(p, mainDbfs) - rendered),
      'the shipped face tracks the pipeline (dB)',
    ).toBeLessThan(0.05);
    expect(
      Math.abs(bad(mainDbfs + SIDECAR_MONO_SUM_OFFSET_DB, p) - rendered),
      'a re-typed law does NOT (dB)',
    ).toBeGreaterThan(0.1);
  });

  it('there is exactly ONE copy of the gain law — read off the SOURCE', () => {
    // ⚠ NO RUNTIME GATE CAN SEE THIS. A second copy that agrees today passes
    // every value assertion in this file and diverges the first time the DSP
    // moves — and a PICTURE drawn from a stale copy is wrong at every x, not at
    // one point, while looking exactly as authoritative. CLAUDE.md's rule for
    // ranges ("one place, guarded at the SOURCE level") applied to a curve.
    //
    // DENY BY DEFAULT over a NAMED list, anchored to the artifact: a file that
    // no longer exists is RED, so the gate cannot quietly stop covering
    // anything.
    const problems: string[] = [];
    for (const rel of GAIN_LAW_CONSUMERS) {
      const text = readSource(rel);
      expect(text, `${rel} must exist — a gate naming a missing file is dead`).toBeTruthy();
      const tells = retypedGainLaw(text!);
      if (tells.length) problems.push(`${rel}: re-typed gain law (${tells.join(', ')})`);
    }
    expect(problems.join('\n'), 'the knee/slope arithmetic must live only in the DSP').toBe('');

    // THE LOAD-BEARING HALF: the model must actually IMPORT the shipping
    // computer. Without this, deleting the delegation and hard-coding a
    // constant would pass the clause above.
    expect(
      readSource('sidecar-face-model.ts'),
      'the model imports the SHIPPING gain computer',
    ).toMatch(/import\s*\{[^}]*computeGainDb[^}]*\}\s*from\s*'[^']*compressor-dsp'/s);
  });

  it('NEGATIVE CONTROL: the source predicate FIRES on a re-typed law', () => {
    // The predicate above returns [] on a clean tree on every run, so on its own
    // it is indistinguishable from a predicate that matches nothing. Run the
    // SAME function over the copy the tree used to carry.
    const retyped = `
      const slope = 1 - 1 / Math.max(1, p.ratio);
      const halfKn = p.knee * 0.5;
      const t = detectorDb - p.threshold + halfKn;
      return (-slope * (t * t)) / (2 * p.knee);
    `;
    expect(retypedGainLaw(retyped).sort(), 'both tells must fire').toEqual([
      'knee quadratic',
      'slope 1-1/ratio',
    ]);
    // BOTH DIRECTIONS, and each tell INDEPENDENTLY — a predicate that only ever
    // fires on the pair would miss half a re-typing.
    expect(retypedGainLaw('const slope = 1 - 1 / Math.max(1, ratio);')).toEqual([
      'slope 1-1/ratio',
    ]);
    expect(retypedGainLaw('return -s * (t * t) / (2 * knDb);')).toEqual(['knee quadratic']);
    // …and it is not simply matching everything: PROSE about the law must pass,
    // which is what lets these two files explain themselves at length.
    expect(
      retypedGainLaw(
        '// the slope is one minus the reciprocal of the ratio, and the knee\n' +
          '// interpolates quadratically between the two straight regions.',
      ),
      'prose describing the law must NOT fire',
    ).toEqual([]);
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

// ─────────────────────────────────────────────────────────────────────────────
// THE TRANSFER-CURVE PANEL (queue Q1b).
//
// The readouts above each answer ONE question at ONE operating point, because
// `FaceReadoutValue` is `(read) => string`. The panel exists for the three
// findings that are SHAPE rather than value, and every leg below is the
// permanent control on one of them.
// ─────────────────────────────────────────────────────────────────────────────

describe('sidecar transfer curve — the PANEL is the SAME answer as the readouts', () => {
  it('the panel\'s reference and the readouts\' reference are ONE point', () => {
    // The readouts are stated at a DETECTOR level; the panel plots MAIN dBFS.
    // Nothing but this forces the two statements of "@ FS" to be the same
    // place, and if they drift the faceplate carries two calibrations at once.
    expect(sidecarDetectorDb(SIDECAR_REFERENCE_MAIN_DBFS)).toBe(SIDECAR_REFERENCE_DETECTOR_DB);
    expect(SIDECAR_CURVE_MAIN_MAX_DBFS).toBe(SIDECAR_REFERENCE_MAIN_DBFS);
  });

  it('the RESTING cursor reprints the readout row character for character', () => {
    // A panel that quietly used a different reference than the row above it
    // would put two answers to one question on one faceplate, with nothing on
    // screen to say which is meant.
    for (const over of [
      {},
      { ratio: 1 },
      { ratio: 20 },
      { knee: 0 },
      { knee: 24 },
      { threshold: -50 },
      { envMag: 0 },
      { envMag: 2 },
      { inputLevel: 0 },
      { makeup: 12 },
    ] as Partial<SidecarFaceParams>[]) {
      const p = withParams(over);
      const cursor = sidecarCursorText(p, SIDECAR_REFERENCE_MAIN_DBFS);
      expect(cursor, `duck @ FS must appear verbatim (${JSON.stringify(over)})`).toContain(
        `duck ${sidecarDuckText(p)}`,
      );
      expect(cursor, `env @ FS must appear verbatim (${JSON.stringify(over)})`).toContain(
        `env ${sidecarEnvText(p)}`,
      );
    }
  });

  it('…and MOVES off it — the cursor is a question, not a decoration', () => {
    // Also the panel's DECLARED OPERABILITY PROBE, asserted in the pure lane:
    // faces-parity clicks the plot's centre, which is 30 dB from the resting
    // cursor, and requires the caption's text to change.
    const centre = (SIDECAR_CURVE_MAIN_MIN_DBFS + SIDECAR_CURVE_MAIN_MAX_DBFS) / 2;
    expect(sidecarCursorText(SIDECAR_DEFAULTS, centre)).not.toBe(
      sidecarCursorText(SIDECAR_DEFAULTS, SIDECAR_REFERENCE_MAIN_DBFS),
    );
    // At the defaults the centre is BELOW the onset, so the change is not a
    // rounding: it is `-18.0 dB` of ducking against none at all.
    expect(sidecarCursorText(SIDECAR_DEFAULTS, centre)).toContain('duck none');
    expect(sidecarCursorText(SIDECAR_DEFAULTS, SIDECAR_REFERENCE_MAIN_DBFS)).toContain(
      'duck -18.0 dB',
    );
  });

  it('SC OUT carries the one-dimension finding as a BEHAVIOUR, at every level', () => {
    // `duck` is what the MAIN takes off; `sc out` is what the sidechain is
    // actually worth. MAKEUP and INPUT LVL are one dimension, so either one
    // slides `sc out` by the same dB at EVERY x while leaving `duck` alone —
    // which no single readout can show, because each knob's readback is
    // invariant to the other and neither moves the curve at all.
    const base = SIDECAR_DEFAULTS;
    const louder = withParams({ makeup: 6.020599913 });
    const twiceIn = withParams({ inputLevel: 2 });
    for (const m of [-60, -40, -27, -24, -12, 0]) {
      expect(sidecarDuckDbAt(louder, m), `duck must be MAKEUP-invariant at ${m} dBFS`).toBeCloseTo(
        sidecarDuckDbAt(base, m),
        12,
      );
      expect(sidecarScOutDbAt(louder, m) - sidecarScOutDbAt(base, m), `sc out shift at ${m} dBFS`)
        .toBeCloseTo(6.020599913, 9);
      // …and the two knobs land in the SAME place, which is the finding.
      expect(sidecarScOutDbAt(twiceIn, m), `the twin knob agrees at ${m} dBFS`).toBeCloseTo(
        sidecarScOutDbAt(louder, m),
        9,
      );
    }
  });
});

describe('sidecar transfer curve — the TWO TICKS split a number the readout can only sum', () => {
  it('the DIAL\'s mark and the ONSET are two independent terms apart', () => {
    // `onset` prints their SUM (-27.0 dB at the defaults, nine from the dial).
    // Only two marks on one axis say WHICH term moved, and the split is exactly
    // the detector sum + half the knee.
    for (const knee of [0, 3, 6, 12, 24]) {
      const p = withParams({ knee });
      const thr = sidecarThresholdMarkDbfs(p)!;
      const onset = sidecarOnsetMarkDbfs(p)!;
      expect(thr, `thr mark in window (knee=${knee})`).not.toBeNull();
      expect(onset, `onset mark in window (knee=${knee})`).not.toBeNull();
      expect(thr - onset, `thr → onset gap must be knee/2 (knee=${knee}), in dB`).toBeCloseTo(
        knee / 2,
        9,
      );
      expect(
        p.threshold - thr,
        `dial → thr mark must be the |L|+|R| sum (knee=${knee}), in dB`,
      ).toBeCloseTo(SIDECAR_MONO_SUM_OFFSET_DB, 9);
    }
    // The KNEE moves one tick and not the other — so the picture separates the
    // terms even at a glance, which is the whole reason both are drawn.
    expect(sidecarThresholdMarkDbfs(withParams({ knee: 0 }))).toBe(
      sidecarThresholdMarkDbfs(withParams({ knee: 24 })),
    );
    expect(sidecarOnsetMarkDbfs(withParams({ knee: 0 }))).not.toBe(
      sidecarOnsetMarkDbfs(withParams({ knee: 24 })),
    );
  });

  it('the ONSET tick IS the ONSET readout — one function, so they cannot disagree', () => {
    for (const threshold of [-50, -30, -18, -6]) {
      for (const knee of [0, 6, 24]) {
        const p = withParams({ threshold, knee });
        const mark = sidecarOnsetMarkDbfs(p);
        if (mark !== null) expect(mark).toBe(sidecarOnsetDbfs(p));
      }
    }
    // At ratio 1 the readout says `never`; the tick must be ABSENT rather than
    // drawn somewhere meaningless.
    expect(sidecarOnsetText(withParams({ ratio: 1 }))).toBe('never');
    expect(sidecarOnsetMarkDbfs(withParams({ ratio: 1 }))).toBeNull();
    expect(sidecarOnsetMarkDbfs(SIDECAR_DEFAULTS)).not.toBeNull();
  });

  it('FINDING: the THRESHOLD dial CANNOT be set high enough to spare a hot mono main', () => {
    // Drawing the curve made this one visible and no readout states it. The
    // dial's top is 0 dB, but the detector sits 6.02 dB above a mono main's own
    // peak and the knee opens another knee/2 below that — so the onset can
    // never be closer to full scale than -6.02 dBFS, at ANY setting. A player
    // who winds THRESHOLD to the top expecting "only duck on absolute peaks"
    // still ducks everything above -6 dBFS.
    let closest = Number.NEGATIVE_INFINITY;
    for (const threshold of [-60, -40, -18, -6, -1, 0]) {
      for (const knee of [0, 6, 24]) {
        closest = Math.max(closest, sidecarOnsetDbfs(withParams({ threshold, knee })));
      }
    }
    expect(closest, 'the closest ducking onset the module can reach, in MAIN dBFS').toBeCloseTo(
      -SIDECAR_MONO_SUM_OFFSET_DB,
      9,
    );
    expect(closest, 'and it is strictly below full scale').toBeLessThan(0);
    // …so the tick is never at the right-hand edge, which is what the picture
    // shows and the number does not.
    expect(sidecarOnsetMarkDbfs(withParams({ threshold: 0, knee: 0 }))).toBeLessThan(
      SIDECAR_CURVE_MAIN_MAX_DBFS,
    );
  });

  it('a mark OUTSIDE the window is ABSENT, never clamped to the edge', () => {
    // A tick pinned to the frame claims a position it does not have — the same
    // lie as a bar chart with a truncated axis and no note.
    const deep = withParams({ threshold: -60, knee: 24 });
    expect(sidecarOnsetDbfs(deep), 'this onset is off the left edge').toBeLessThan(
      SIDECAR_CURVE_MAIN_MIN_DBFS,
    );
    expect(sidecarOnsetMarkDbfs(deep)).toBeNull();
    expect(sidecarThresholdMarkDbfs(deep)).toBeNull();
  });
});

describe('sidecar transfer curve — the PLOT is TOTAL and the y window is honest', () => {
  it('every sample is finite and inside the drawn window, over hostile params', () => {
    // The curve is rebuilt on every render of every frame; one NaN in a
    // polyline takes the faceplate down mid-drag.
    const HOSTILE_P: Array<Partial<SidecarFaceParams>> = [
      {},
      { ratio: Number.NaN },
      { ratio: Number.POSITIVE_INFINITY },
      { knee: Number.NaN },
      { knee: -5 },
      { threshold: Number.NaN },
      { threshold: Number.NEGATIVE_INFINITY },
      { threshold: 1e9 },
      { inputLevel: Number.NaN },
      { makeup: Number.POSITIVE_INFINITY },
      { envMag: Number.NaN },
    ];
    for (const over of HOSTILE_P) {
      const curve = sidecarCurvePoints(withParams(over), 32);
      expect(curve.points.length, `${JSON.stringify(over)}: columns+1 samples`).toBe(33);
      for (const pt of curve.points) {
        expect(Number.isFinite(pt.plotDb), `${JSON.stringify(over)} @ ${pt.mainDbfs}`).toBe(true);
        expect(pt.plotDb).toBeLessThanOrEqual(0);
        expect(pt.plotDb).toBeGreaterThanOrEqual(SIDECAR_CURVE_DUCK_FLOOR_DB);
      }
      expect(curve.points[0]!.mainDbfs).toBe(SIDECAR_CURVE_MAIN_MIN_DBFS);
      expect(curve.points.at(-1)!.mainDbfs).toBe(SIDECAR_CURVE_MAIN_MAX_DBFS);
    }
    // `columns` is a resolution, not a population — a degenerate request still
    // returns a drawable pair rather than an empty polyline.
    expect(sidecarCurvePoints(SIDECAR_DEFAULTS, 0).points.length).toBe(2);
  });

  it('the curve is MONOTONIC — more main can never mean less ducking', () => {
    for (const over of [{}, { knee: 24 }, { ratio: 20 }, { threshold: -50 }, { ratio: 1 }]) {
      const pts = sidecarCurvePoints(withParams(over), 240).points;
      for (let i = 1; i < pts.length; i++) {
        expect(
          pts[i]!.duckDb,
          `${JSON.stringify(over)}: ducking must not decrease from ${pts[i - 1]!.mainDbfs} to ${pts[i]!.mainDbfs} dBFS`,
        ).toBeLessThanOrEqual(pts[i - 1]!.duckDb + 1e-12);
      }
    }
  });

  it('the curve\'s right-hand end IS the `duck @ FS` readout', () => {
    for (const over of [{}, { ratio: 2 }, { ratio: 20 }, { threshold: -40 }]) {
      const p = withParams(over);
      expect(sidecarCurvePoints(p, 60).points.at(-1)!.duckDb).toBe(sidecarDuckDb(p));
    }
  });

  it('CLIPPED is reported, not hidden — the fixed y window has a cost and says so', () => {
    // The window is fixed so a RATIO change reads as a slope change instead of
    // sliding under an auto-scaled axis. The price is that the deepest settings
    // run past the floor, and a flat bottom drawn silently would read as a
    // limit the module actually has.
    expect(sidecarCurvePoints(SIDECAR_DEFAULTS, 120).clipped, 'defaults fit the window').toBe(
      false,
    );
    const deep = withParams({ threshold: -50, ratio: 20 });
    expect(sidecarDuckDb(deep), 'this setting really is past the floor (dB)').toBeLessThan(
      SIDECAR_CURVE_DUCK_FLOOR_DB,
    );
    expect(sidecarCurvePoints(deep, 120).clipped, 'and the panel says so').toBe(true);
  });

  it('the cursor CLAMPS into the window, over hostile input', () => {
    expect(sidecarClampMainDbfs(10)).toBe(SIDECAR_CURVE_MAIN_MAX_DBFS);
    expect(sidecarClampMainDbfs(-999)).toBe(SIDECAR_CURVE_MAIN_MIN_DBFS);
    expect(sidecarClampMainDbfs(Number.NaN)).toBe(SIDECAR_CURVE_MAIN_MAX_DBFS);
    expect(sidecarClampMainDbfs(-30)).toBe(-30);
    for (const m of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e9, -1e9]) {
      const s = sidecarCursorText(withParams({ ratio: Number.NaN }), m);
      expect(s, `cursor(${String(m)}) must not leak a raw non-number`).not.toMatch(
        /NaN|Infinity|undefined/,
      );
    }
  });
});
