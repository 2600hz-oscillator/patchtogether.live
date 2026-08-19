// art/scenarios/moog911/face-audit.test.ts
//
// THE ADVERSARIAL AUDIT FOR MOOG911, and the permanent anchor under its
// faceplate (queue Q34, #1889).
//
// Everything here is measured against the REAL worklet — the shipping
// `Moog911Processor` class captured through the shared `registerProcessor` shim
// (`art/setup/worklet.ts`) and pumped through `process()` in 128-sample blocks
// at 48 kHz. That is the same path `profile.test.ts` renders the pinned `.f32`
// through, so these are the shipping DSP's own numbers and not a mirror's.
//
// WHAT THIS FILE IS FOR, beyond regression. `moog911-face-model.ts` is a stack
// of closed forms, and a unit test over closed forms can only ever prove they
// are self-consistent. Three of them are claims about a STAGE MACHINE:
//
//   1. EACH T KNOB IS A TIME CONSTANT, NOT A DURATION. `egCoeff` covers ~99.3 %
//      of a stage's span in `T` seconds, and each stage exits on its OWN
//      threshold, so a stage takes `T · ln(k)/5`. Asserted at the output, with
//      the delivered duration compared to the model's closed form to within a
//      SAMPLE, at the shipped defaults and across the dial.
//   2. THE SUSTAIN LEVEL KNOB SETS TWO OTHER KNOBS' DURATIONS. Swept on the
//      real worklet, with `rise` as the negative control — it must be BIT-EXACT
//      across the same sweep, because its gap ratio is a constant.
//   3. THE THREE STAGE-EXIT THRESHOLDS the model has to MIRROR (they are inline
//      literals in `Moog911Eg.step`, not exports) are RECOVERED from the
//      shipping worklet analytically and compared to the mirrored constants. So
//      a mirror that drifts from the core it describes goes RED here rather
//      than silently wrong on the faceplate.
//
// ⚠ THE INSTRUMENT WAS WRONG FIRST, and its failure mode is a PERMANENT LEG
// below rather than a note. Detecting the SUSTAIN stage by comparing a
// `Float32Array` sample to the float64 literal `0.6` reports ZERO sustain
// samples — which reads exactly like "this module never sustains". What catches
// it is the POSITIVE control: a HELD gate certainly sustains, so a probe
// reporting 0 there is broken rather than the module. Both readings are
// asserted, in both directions, so the fixed instrument cannot quietly regress
// into the broken one.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../setup/capture';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';
import {
  MOOG911_ATTACK_PEAK,
  MOOG911_DECAY_SETTLE_EPS,
  MOOG911_RELEASE_FLOOR,
  moog911AttackMs,
  moog911DecayMs,
  moog911ReleaseMs,
} from '$lib/ui/modules/moog911-face-model';
import { MIN_TIME_S, TAU_DECADES } from '../../../packages/dsp/src/lib/moog911-eg-dsp';
import { moog911Def } from '$lib/audio/modules/moog911';

const SR = SAMPLE_RATE;
/** The def's shipped spawn defaults. DERIVED — no param table here. */
const D: Record<string, number> = Object.fromEntries(
  moog911Def.params.map((p) => [p.id, p.defaultValue]),
);
/** Every declared output, in declaration order. DERIVED — no port list here. */
const OUT_IDS: readonly string[] = moog911Def.outputs.map((o) => o.id);

interface Patch {
  t1?: number;
  t2?: number;
  esus?: number;
  t3?: number;
}

/** Render the shipping worklet for `seconds` with a gate that is high while
 *  `gateHigh(sampleIndex)`. Returns every declared output, full length. */
async function render(
  seconds: number,
  patch: Patch,
  gateHigh: (i: number) => boolean,
): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'moog911',
    () => import('../../../packages/dsp/src/moog911'),
    SR,
  );
  const n = Math.round(seconds * SR);
  const gate = new Float32Array(n);
  for (let i = 0; i < n; i++) gate[i] = gateHigh(i) ? 1 : 0;
  return renderWorklet(new Proc(), {
    totalSamples: n,
    inputs: [gate],
    params: { t1: D.t1!, t2: D.t2!, esus: D.esus!, t3: D.t3!, ...patch },
    outputs: OUT_IDS,
  });
}

const HELD = () => true;
const UNPATCHED = () => false;
const ms = (samples: number) => (samples / SR) * 1000;
/** One sample, in ms — the resolution of every duration measured here. */
const SAMPLE_MS = 1000 / SR;

/** Stage boundaries off a HELD-gate render.
 *  ⚠ `Math.fround` is load-bearing: `env` is a Float32Array and `esus` is a
 *  float64 literal, so `=== esus` never matches and the probe reports a module
 *  that never sustains. */
function stages(env: Float32Array, esus: number) {
  const esusF = Math.fround(esus);
  let attackEnd = -1;
  let decayEnd = -1;
  let sustainSamples = 0;
  let sustainSamplesFloat64Compare = 0;
  for (let i = 0; i < env.length; i++) {
    if (attackEnd < 0 && env[i] === 1.0) attackEnd = i;
    if (attackEnd >= 0 && decayEnd < 0 && i > attackEnd && env[i] === esusF) decayEnd = i;
    if (env[i] === esusF) sustainSamples++;
    if (env[i] === esus) sustainSamplesFloat64Compare++;
  }
  return {
    /** Delivered ATTACK, ms (the stage ends ON the sample that snaps to 1.0). */
    attackMs: attackEnd < 0 ? Number.NaN : ms(attackEnd + 1),
    /** Delivered INITIAL DECAY, ms. */
    decayMs: decayEnd < 0 || attackEnd < 0 ? Number.NaN : ms(decayEnd - attackEnd),
    sustainSamples,
    sustainSamplesFloat64Compare,
  };
}

/** Delivered FINAL DECAY, ms, for a gate held `holdS` seconds then dropped. */
function releaseMsFrom(env: Float32Array, holdSamples: number): number {
  for (let i = holdSamples; i < env.length; i++) if (env[i] === 0) return ms(i - holdSamples);
  return Number.NaN;
}

const bytes = (a: Float32Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

/** ⚠ NOT `Math.max(...buf)`: these renders run to hundreds of thousands of
 *  samples and spreading one into a call throws RangeError long before the
 *  assertion is reached. */
function maxOf(a: Float32Array): number {
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i]! > m) m = a[i]!;
  return m;
}
function minOf(a: Float32Array): number {
  let m = Infinity;
  for (let i = 0; i < a.length; i++) if (a[i]! < m) m = a[i]!;
  return m;
}

describe('ART moog911 / face audit — THE INSTRUMENT, before any finding', () => {
  it('⚠ POSITIVE CONTROL: a HELD gate sustains, and a float64 compare says it never does', async () => {
    const { env } = await render(4, {}, HELD);
    const s = stages(env!, D.esus!);
    // The fixed instrument. If this is ever 0 the probe is broken, not the DSP.
    expect(s.sustainSamples).toBeGreaterThan(100_000);
    // The BROKEN instrument, pinned permanently in the other direction so the
    // fround cannot be quietly dropped: 0.6 is not representable in float32, so
    // comparing the stored sample to the float64 literal matches NOTHING.
    expect(s.sustainSamplesFloat64Compare).toBe(0);
    expect(Math.fround(D.esus!)).not.toBe(D.esus!);
  });

  it('the contour reaches full scale and holds the shelf the def declares', async () => {
    const { env, env_inv } = await render(4, {}, HELD);
    expect(maxOf(env!)).toBe(1);
    // env_inv is the exact mirror, per sample.
    for (let i = 0; i < env!.length; i += 977) {
      expect(env_inv![i]).toBeCloseTo(1 - env![i]!, 6);
    }
  });
});

describe('ART moog911 / face audit — THE THREE DELIVERED DURATIONS', () => {
  it('at the shipped defaults the module delivers 13.833 / 239.667 / 695.958 ms', async () => {
    const held = await render(4, {}, HELD);
    const s = stages(held.env!, D.esus!);
    expect(s.attackMs).toBeCloseTo(13.833, 3);
    expect(s.decayMs).toBeCloseTo(239.667, 3);

    const holdSamples = Math.round(3 * SR);
    const rel = await render(12, {}, (i) => i < holdSamples);
    expect(releaseMsFrom(rel.env!, holdSamples)).toBeCloseTo(695.958, 3);

    // …and the three DIALS say 10 / 200 / 400.
    expect(1000 * D.t1!).toBe(10);
    expect(1000 * D.t2!).toBe(200);
    expect(1000 * D.t3!).toBe(400);
    const contour = s.attackMs + s.decayMs + releaseMsFrom(rel.env!, holdSamples);
    expect(contour).toBeCloseTo(949.458, 3);
    expect(contour / 610).toBeCloseTo(1.5565, 4);
  });

  it('the FACE MODEL\'s closed forms match the shipping DSP to within a sample', async () => {
    // THE ANCHOR. Every readout on the faceplate is one of these three
    // functions; this is the leg that says they describe the real machine.
    const cases: readonly Patch[] = [
      {},
      { t1: 0.001, t2: 0.05, esus: 0.2, t3: 0.1 },
      { t1: 0.1, t2: 0.5, esus: 0.9, t3: 0.05 },
      { t1: 0.02, t2: 0.02, esus: 0.05, t3: 0.02 },
    ];
    for (const patch of cases) {
      const p = { t1: D.t1!, t2: D.t2!, esus: D.esus!, t3: D.t3!, ...patch };
      const held = await render(6, patch, HELD);
      const s = stages(held.env!, p.esus);
      expect(s.attackMs, `attack ${JSON.stringify(patch)} (ms)`).toBeCloseTo(
        moog911AttackMs(p),
        1,
      );
      expect(Math.abs(s.attackMs - moog911AttackMs(p))).toBeLessThanOrEqual(SAMPLE_MS * 2);
      expect(Math.abs(s.decayMs - moog911DecayMs(p))).toBeLessThanOrEqual(SAMPLE_MS * 2);

      const holdSamples = Math.round(2 * SR);
      const rel = await render(14, patch, (i) => i < holdSamples);
      const measured = releaseMsFrom(rel.env!, holdSamples);
      expect(Math.abs(measured - moog911ReleaseMs(p)), `release ${JSON.stringify(patch)} (ms)`)
        .toBeLessThanOrEqual(SAMPLE_MS * 2);
    }
  });
});

describe('ART moog911 / face audit — ESUS RE-TIMES TWO OTHER KNOBS', () => {
  it('the delivered SETTLE spans 276.313 → 0.021 ms while the T2 dial never moves', async () => {
    const expected: readonly (readonly [number, number])[] = [
      [0, 276.313],
      [0.3, 262.063],
      [0.6, 239.667],
      [0.9, 184.208],
      [0.99, 92.104],
      [0.999, 0.021],
    ];
    for (const [esus, want] of expected) {
      const { env } = await render(4, { esus }, HELD);
      expect(stages(env!, esus).decayMs, `settle at esus=${esus}`).toBeCloseTo(want, 3);
    }
    // The dial the reader would have looked at is the SAME number every row.
    expect(moog911Def.params.find((p) => p.id === 't2')!.defaultValue).toBe(0.2);
  });

  it('the delivered FALL moves the OTHER WAY across the same sweep', async () => {
    const holdSamples = Math.round(3 * SR);
    const expected: readonly (readonly [number, number])[] = [
      [0, 0],
      [0.3, 640.5],
      [0.6, 695.958],
      [1, 736.813],
    ];
    for (const [esus, want] of expected) {
      const { env } = await render(12, { esus }, (i) => i < holdSamples);
      expect(releaseMsFrom(env!, holdSamples), `fall at esus=${esus}`).toBeCloseTo(want, 3);
    }
  });

  it('⚠ NEGATIVE CONTROL: the delivered RISE is BIT-EXACTLY invariant to ESUS', async () => {
    // The attack's gap ratio is the constant 1/(1 − 0.999), so this is not
    // "close" — the attack segment of the render is byte-identical.
    const ref = await render(1, { esus: 0 }, HELD);
    const refHead = bytes(ref.env!.subarray(0, Math.round(0.012 * SR)));
    for (const esus of [0.3, 0.6, 0.9, 1]) {
      const r = await render(1, { esus }, HELD);
      expect(bytes(r.env!.subarray(0, Math.round(0.012 * SR))), `rise at esus=${esus}`).toBe(
        refHead,
      );
    }
    // …and the same sweep DOES move the rest of the contour, so the invariance
    // above is a property of the attack rather than of the probe.
    const a = await render(1, { esus: 0.3 }, HELD);
    const b = await render(1, { esus: 0.9 }, HELD);
    expect(bytes(a.env!)).not.toBe(bytes(b.env!));
  });
});

describe('ART moog911 / face audit — THE MIRRORED THRESHOLDS, recovered from the DSP', () => {
  // Each stage's exit threshold is an inline literal in `Moog911Eg.step` and
  // cannot be imported, so `moog911-face-model.ts` mirrors it. These legs
  // RECOVER each one from the shipping worklet's own delivered duration —
  // `gap_exit = gap_start · exp(−TAU · t / T)` — at a long `T`, where sample
  // quantisation is ~0.005 % of the exponent. A mirror that drifts is RED.
  it('ATTACK exits at level >= MOOG911_ATTACK_PEAK', async () => {
    const T1 = 2;
    const { env } = await render(4, { t1: T1 }, HELD);
    const tS = stages(env!, D.esus!).attackMs / 1000;
    const recoveredPeak = 1 - Math.exp((-TAU_DECADES * tS) / T1);
    expect(recoveredPeak).toBeCloseTo(MOOG911_ATTACK_PEAK, 5);
  });

  it('DECAY exits at |level − esus| <= MOOG911_DECAY_SETTLE_EPS', async () => {
    const T2 = 2;
    const esus = 0.5;
    const { env } = await render(8, { t1: 0.001, t2: T2, esus }, HELD);
    const tS = stages(env!, esus).decayMs / 1000;
    const recoveredEps = (1 - esus) * Math.exp((-TAU_DECADES * tS) / T2);
    expect(recoveredEps).toBeCloseTo(MOOG911_DECAY_SETTLE_EPS, 6);
  });

  it('RELEASE exits at level <= MOOG911_RELEASE_FLOOR', async () => {
    const T3 = 2;
    const esus = 0.5;
    const holdSamples = Math.round(2 * SR);
    const { env } = await render(14, { t1: 0.001, t2: 0.01, esus, t3: T3 }, (i) => i < holdSamples);
    const tS = releaseMsFrom(env!, holdSamples) / 1000;
    const recoveredFloor = esus * Math.exp((-TAU_DECADES * tS) / T3);
    expect(recoveredFloor).toBeCloseTo(MOOG911_RELEASE_FLOOR, 7);
  });
});

describe('ART moog911 / face audit — WHAT THE FACE SAYS ABOUT SPAWN AND TRIGGERS', () => {
  it('⚠ ALL FOUR PARAMS ARE BIT-EXACTLY INERT AT SPAWN, on BOTH taps', async () => {
    // This is why inertness cannot discriminate the ranking on this module, and
    // why the VRT scenes cannot move unless the FACE moves.
    const ref = await render(1, {}, UNPATCHED);
    const refBytes = OUT_IDS.map((id) => bytes(ref[id]!));
    const sweeps: readonly Patch[] = [
      { t1: 0.0001 }, { t1: 10 }, { t2: 0.0001 }, { t2: 10 },
      { esus: 0 }, { esus: 1 }, { t3: 0.0001 }, { t3: 10 },
    ];
    for (const patch of sweeps) {
      const r = await render(1, patch, UNPATCHED);
      OUT_IDS.forEach((id, k) => {
        expect(bytes(r[id]!), `${id} with ${JSON.stringify(patch)}`).toBe(refBytes[k]);
      });
    }
    // POSITIVE CONTROL: with the gate HELD, three of the four move the output
    // and T3 correctly does not — it needs a falling edge.
    const held = bytes((await render(1, {}, HELD)).env!);
    expect(bytes((await render(1, { t1: 1 }, HELD)).env!)).not.toBe(held);
    expect(bytes((await render(1, { t2: 2 }, HELD)).env!)).not.toBe(held);
    expect(bytes((await render(1, { esus: 0.2 }, HELD)).env!)).not.toBe(held);
    expect(bytes((await render(1, { t3: 5 }, HELD)).env!)).toBe(held);
  });

  it('`env_inv` idles at EXACTLY full scale with nothing patched (the docs claim)', async () => {
    const { env, env_inv } = await render(1, {}, UNPATCHED);
    expect(minOf(env_inv!)).toBe(1);
    expect(maxOf(env_inv!)).toBe(1);
    expect(maxOf(env!)).toBe(0);
  });

  it('a 1 ms TRIGGER opens the contour to 39 % at the default T1 (the docs claim)', async () => {
    // CLAUDE.md's triggers-vs-gates seam with a number on it: `moog911a` — this
    // module's own bank-mate — emits a 1 ms pulse, and the 911's `gate` input is
    // LEVEL-sensitive, so the contour only gets as far as T1 lets it in 1 ms.
    const pulse = Math.round(0.001 * SR);
    const peakFor = async (t1: number) => {
      const { env } = await render(2, { t1 }, (i) => i >= 100 && i < 100 + pulse);
      return maxOf(env!);
    };
    expect(await peakFor(D.t1!)).toBeCloseTo(0.3935, 4);
    expect(await peakFor(0.001)).toBeCloseTo(0.9933, 4);
    // Full opening needs T1 at or below ~0.72 ms; 0.0007238 s still reaches it.
    expect(await peakFor(0.0007238)).toBe(1);
    // POSITIVE CONTROL: the same patch under a HELD gate reaches full scale, so
    // the 0.3935 is the pulse WIDTH and not a module that cannot open.
    expect(maxOf((await render(2, {}, HELD)).env!)).toBe(1);
  });

  it('the ATTACK snaps in ONE sample at the declared minimum and SEVEN just above it', async () => {
    // `MIN_TIME_S` equals the def's own `min` and `egCoeff`'s guard is `<=`, so
    // the dial's last reachable value is 7x faster than the value adjacent to
    // it. Filed as #1885; the face prints it rather than smoothing it over.
    const min = moog911Def.params.find((p) => p.id === 't1')!.min;
    expect(min).toBe(MIN_TIME_S);
    const samplesTo1 = async (t1: number) => {
      const { env } = await render(0.05, { t1 }, HELD);
      for (let i = 0; i < env!.length; i++) if (env![i] === 1) return i + 1;
      return -1;
    };
    expect(await samplesTo1(min)).toBe(1);
    expect(await samplesTo1(min * 1.00001)).toBe(7);
  });
});
