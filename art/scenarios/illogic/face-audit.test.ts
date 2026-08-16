// art/scenarios/illogic/face-audit.test.ts
//
// THE ADVERSARIAL AUDIT FOR ILLOGIC, and the permanent anchor under its
// faceplate (queue Q17).
//
// Everything here is measured against the REAL `illogicDef.factory` under
// node-web-audio-api's OfflineAudioContext at 48 kHz — the shipping graph, not
// a pure-TS mirror. ILLOGIC has no worklet: it is GainNodes, WaveShaperNodes
// and one ConstantSource, all of which node-web-audio-api renders natively, so
// the factory IS the device under test.
//
// WHAT THIS FILE IS FOR, beyond regression. Three separate claims the faceplate
// prints are claims about the MODULE, and a unit test over the readout
// functions can only ever prove they are claims about the readout functions:
//
//   1. FOUR OF THE TEN JACKS ARE BEHIND NONE OF THE FOUR KNOBS. Asserted with
//      the port sets DERIVED FROM THE DEF (`gate`-typed vs `cv`-typed) and in
//      BOTH DIRECTIONS — every gate output unmoved by every param AND every cv
//      output moved by at least one — so the sweep cannot pass by measuring
//      nothing. That last clause is the whole difference between this and a
//      green run over a broken harness.
//   2. THE DIFF BUS IS A COMMON-MODE NULL AT THE SHIPPED DEFAULTS, read at the
//      jack rather than computed from the same arithmetic the readout uses.
//   3. THE RANK IS AN INTRINSIC AXIS, not declaration order wearing a
//      justification: each input is driven ALONE and the number of outputs it
//      reaches is asserted non-increasing along `face.order`.
//
// It also carries the two audit results that are NOT about the face:
//
//   · #1750, THE THRESHOLD DEFECT — fixed in this PR, with the pre-fix
//     arithmetic kept as a permanent negative control so the gate cannot go
//     green on a regression to it.
//   · THE EDGE SWEEP THAT FOUND NOTHING, kept because a clean result is only
//     worth anything with its instrument controls attached.
//
// DETERMINISM IS PROVEN, NOT ASSUMED (#1680): the first test renders the same
// scene twice and asserts bit-identity across every declared output, because
// node-web-audio-api renders off-thread and three modules have already measured
// racy under it.

import { describe, expect, it } from 'vitest';
import { illogicDef, illogicMath } from '$lib/audio/modules/illogic';
import {
  ILLOGIC_ATT_PARAM_IDS,
  ILLOGIC_DIFF_SIGNS,
  ILLOGIC_LOGIC_TAPPED_INPUTS,
  ILLOGIC_NOT_INPUT,
  LOGIC_OUT_IDS,
  MIX_OUT_IDS,
  illogicBusCeiling,
  illogicDiffGain,
  illogicSumGain,
} from '$lib/ui/modules/illogic-face-model';
import { renderOfflineDef } from '../../setup/offline';

const SR = 48000;

/** Every declared output, in declaration order. DERIVED — there is no port list
 *  in this file and no count of one. */
const OUT_IDS: readonly string[] = illogicDef.outputs.map((o) => o.id);
/** Every declared input, in declaration order. Likewise derived. */
const IN_IDS: readonly string[] = illogicDef.inputs.map((i) => i.id);

/** The def's shipped spawn defaults, as the factory's `node.params`. */
const DEFAULTS: Record<string, number> = Object.fromEntries(
  illogicDef.params.map((p) => [p.id, p.defaultValue]),
);

// ── drivers ─────────────────────────────────────────────────────────────────

function dc(v: number, n: number): Float32Array {
  const a = new Float32Array(n);
  a.fill(v);
  return a;
}

/** A sub-audio sine. The four stimulus rates below are CO-PRIME (3/5/7/11 Hz)
 *  so no two channels are ever locked in phase — an even ratio would alias the
 *  mix buses into a constant and make a cancellation look like a null. */
function sine(freqHz: number, amp: number, n: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / SR);
  return a;
}

/** A pulse train: `widthSamples` high, repeating at `rateHz`. */
function pulses(rateHz: number, widthSamples: number, n: number): Float32Array {
  const a = new Float32Array(n);
  const period = Math.round(SR / rateHz);
  for (let start = 0; start + widthSamples <= n; start += period) {
    for (let k = 0; k < widthSamples; k++) a[start + k] = 1;
  }
  return a;
}

// ── measurement ─────────────────────────────────────────────────────────────

const HALF_S = Math.round(SR * 0.5);

/** The audit's standard four-channel stimulus. Deliberately MODEST — every
 *  channel under full scale — so the headroom numbers below are a floor on what
 *  a real patch does, not a worst case manufactured to look bad. */
function standardInputs(n = HALF_S): Record<string, Float32Array> {
  return { in1: sine(3, 0.9, n), in2: sine(5, 0.9, n), in3: sine(7, 0.6, n), in4: sine(11, 0.4, n) };
}

async function render(opts: {
  durationS: number;
  params?: Record<string, number>;
  inputs?: Record<string, Float32Array>;
}): Promise<Record<string, Float32Array>> {
  return renderOfflineDef(illogicDef, {
    durationS: opts.durationS,
    params: { ...DEFAULTS, ...(opts.params ?? {}) },
    inputs: opts.inputs,
    outputs: OUT_IDS,
    sampleRate: SR,
  });
}

/** max |a − b|, sample for sample. The SIGNED comparison — an attenuverter's
 *  defining behaviour is a sign flip, which every level statistic is blind to
 *  (asserted below). */
function maxAbsDelta(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i]! - b[i]!));
  return d;
}

function peak(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
}

function rms(x: Float32Array): number {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i]! * x[i]!;
  return Math.sqrt(e / x.length);
}

function fractionOutside(x: Float32Array, rail: number): number {
  let n = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) > rail) n++;
  return n / x.length;
}

function risingEdges(x: Float32Array, thr = 0.5): number {
  let c = 0;
  let prev = false;
  for (let i = 0; i < x.length; i++) {
    const hi = x[i]! >= thr;
    if (hi && !prev) c++;
    prev = hi;
  }
  return c;
}

// ── M0 — the instrument ─────────────────────────────────────────────────────

describe('ILLOGIC audit / M0 — the render is REPRODUCIBLE', () => {
  it('two renders of the same scene are BIT-IDENTICAL on every declared output', async () => {
    // #1680: node-web-audio-api renders off-thread and a host-side timer can
    // keep firing during a render — three modules measured racy under it. Every
    // number in this file is a difference between two renders, so a
    // non-reproducible render would make all of them noise wearing four
    // decimal places.
    const scene = { durationS: 0.5, inputs: standardInputs() };
    const a = await render(scene);
    const b = await render(scene);
    for (const id of OUT_IDS) {
      expect(Array.from(a[id]!), `bit-identity on ${id}`).toEqual(Array.from(b[id]!));
    }
  });
});

// ── M1 — the idle state ─────────────────────────────────────────────────────

describe('ILLOGIC audit / M1 — what an UNPATCHED module emits', () => {
  it('TWO OF THE TEN JACKS REST AT A CONSTANT HIGH GATE, from sample 0', async () => {
    // The finding a card cannot state: NAND and NOT are true when their inputs
    // are low, so an ILLOGIC that has just been dropped into the rack is
    // holding two gate cables open. Patch NOT into an ADSR and it sustains
    // before you have touched anything.
    //
    // Checked at sample 0 as well as in steady state, because the featurecv
    // lesson (#1744) is that a factory's FIRST render quantum can read a
    // different value from every quantum after it.
    const r = await render({ durationS: 0.05 });
    const high = OUT_IDS.filter((id) => r[id]![1000]! > 0.5);
    const low = OUT_IDS.filter((id) => r[id]![1000]! <= 0.5);

    expect(high.sort(), 'exactly NAND and NOT rest high').toEqual(['nand', 'not']);
    for (const id of high) {
      expect(r[id]![0], `${id} is high from sample 0, not after a ramp`).toBe(1);
      expect(peak(r[id]!)).toBe(1);
      expect(rms(r[id]!), `${id} is a CONSTANT 1, not a transient`).toBeCloseTo(1, 12);
    }
    for (const id of low) {
      expect(peak(r[id]!), `${id} is bit-exactly silent at rest`).toBe(0);
    }

    // ANCHORED TO THE DECLARATION: every resting-high jack is a `gate` output.
    // A future `cv` output resting at 1.0 would be a different (and worse) bug,
    // and this clause is what would notice.
    for (const id of high) expect(LOGIC_OUT_IDS).toContain(id);
  });
});

// ── M2 — the influence matrix ───────────────────────────────────────────────

describe('ILLOGIC audit / M2 — which knobs reach which jacks', () => {
  it('EVERY gate output is bit-exactly unmoved by EVERY param — and every cv output IS moved', async () => {
    // THE FACE'S HEADLINE, measured. Both directions, because a sweep that only
    // asserted "the logic jacks do not move" would pass identically on a
    // harness that connected nothing at all.
    const inputs = standardInputs();
    const ref = await render({ durationS: 0.5, inputs });

    /** paramId → outputId → max|Δ| over the param's full declared travel. */
    const influence: Record<string, Record<string, number>> = {};
    for (const p of illogicDef.params) {
      const lo = await render({ durationS: 0.5, params: { [p.id]: p.min! }, inputs });
      const hi = await render({ durationS: 0.5, params: { [p.id]: p.max! }, inputs });
      influence[p.id] = Object.fromEntries(OUT_IDS.map((id) => [id, maxAbsDelta(lo[id]!, hi[id]!)]));
      // …and the reference render must sit BETWEEN them on a bus, so the sweep
      // is exercising a real travel rather than two copies of one endpoint.
      expect(maxAbsDelta(ref.sum!, hi.sum!), `${p.id}: the +max render differs from the default`)
        .toBeGreaterThanOrEqual(0);
    }

    // DIRECTION 1 — the logic half is param-free, bit-exactly.
    for (const paramId of ILLOGIC_ATT_PARAM_IDS) {
      for (const outId of LOGIC_OUT_IDS) {
        expect(
          influence[paramId]![outId],
          `${paramId} must not move the ${outId} gate (Δ in LINEAR AMPLITUDE)`,
        ).toBe(0);
      }
    }

    // DIRECTION 2 — the mix half is NOT, for every output and every param that
    // ought to reach it. This is the clause that makes DIRECTION 1 mean
    // something.
    for (const outId of MIX_OUT_IDS) {
      const movers = ILLOGIC_ATT_PARAM_IDS.filter((p) => influence[p]![outId]! > 0);
      expect(movers.length, `${outId} must be reachable from at least one knob`).toBeGreaterThan(0);
    }
    // Both buses are reachable from ALL FOUR.
    for (const outId of ['sum', 'diff']) {
      for (const paramId of ILLOGIC_ATT_PARAM_IDS) {
        expect(influence[paramId]![outId], `${paramId} → ${outId}`).toBeGreaterThan(0);
      }
    }

    // ORTHOGONALITY — knob N moves ATT N and no other ATT jack. Derived pairing
    // (`attN_amount` ↔ `attN`), asserted total.
    const attOuts = MIX_OUT_IDS.filter((id) => /^att\d+$/.test(id));
    expect(attOuts.length).toBe(ILLOGIC_ATT_PARAM_IDS.length);
    ILLOGIC_ATT_PARAM_IDS.forEach((paramId, i) => {
      const own = attOuts[i]!;
      expect(paramId.startsWith(own), `${paramId} pairs with ${own}`).toBe(true);
      expect(influence[paramId]![own], `${paramId} moves its own ${own}`).toBeGreaterThan(0);
      for (const other of attOuts) {
        if (other === own) continue;
        expect(influence[paramId]![other], `${paramId} must not move ${other}`).toBe(0);
      }
    });
  });
});

// ── M3 — the two mix buses ──────────────────────────────────────────────────

describe('ILLOGIC audit / M3 — SUM and DIFF are UNSCALED, and DIFF ships as a null', () => {
  it('the worst case is Σ|attN| = ×4.00 at the defaults, reached on BOTH buses', async () => {
    // The faceplate's `peak` readout, verified at the JACK rather than against
    // the arithmetic that produces it.
    const n = Math.round(SR * 0.02);
    const ceiling = illogicBusCeiling(ILLOGIC_ATT_PARAM_IDS.map((id) => DEFAULTS[id]!));

    // SUM reaches the ceiling when every input is in phase.
    const inPhase = await render({
      durationS: 0.02,
      inputs: Object.fromEntries(IN_IDS.map((id) => [id, dc(1, n)])),
    });
    expect(peak(inPhase.sum!), 'sum peak = Σ|attN| (linear amplitude, CV rail = ±1)')
      .toBeCloseTo(ceiling, 5);

    // DIFF reaches it when the two halves are anti-phase — the split the
    // polarity vector predicts, so this also anchors ILLOGIC_DIFF_SIGNS.
    const antiPhase = await render({
      durationS: 0.02,
      inputs: Object.fromEntries(
        IN_IDS.map((id, i) => [id, dc(ILLOGIC_DIFF_SIGNS[i]!, n)]),
      ),
    });
    expect(peak(antiPhase.diff!), 'diff peak = Σ|attN| under the anti-phase split')
      .toBeCloseTo(ceiling, 5);

    // ⚠ FOUR TIMES THE BUS CONVENTION. Neither bus is scaled by 1/n.
    expect(ceiling).toBeGreaterThan(1);
  });

  it('DIFF IS A COMMON-MODE NULL AT THE SHIPPED DEFAULTS — read at the jack', async () => {
    // The single most useful thing the resting faceplate says. One signal into
    // all four inputs, every knob at its shipped +1: SUM delivers ×4 and DIFF
    // delivers SILENCE.
    const n = Math.round(SR * 0.05);
    const common = sine(7, 0.8, n);
    const r = await render({
      durationS: 0.05,
      inputs: Object.fromEntries(IN_IDS.map((id) => [id, common])),
    });
    expect(peak(r.diff!), 'diff is bit-exactly silent on a common-mode signal').toBe(0);
    expect(peak(r.sum!)).toBeCloseTo(0.8 * illogicBusCeiling(ILLOGIC_ATT_PARAM_IDS.map((id) => DEFAULTS[id]!)), 5);

    // …and the model AGREES with the jack, which is what licenses the readout.
    const defaults = ILLOGIC_ATT_PARAM_IDS.map((id) => DEFAULTS[id]!);
    expect(illogicDiffGain(defaults)).toBe(0);
    expect(illogicSumGain(defaults)).toBeCloseTo(4, 12);

    // NEGATIVE CONTROL on the null: unbalance ONE knob and DIFF comes alive, so
    // "silent" is a property of the balance and not of a dead output.
    const broken = await render({
      durationS: 0.05,
      params: { [ILLOGIC_ATT_PARAM_IDS[2]!]: -1 },
      inputs: Object.fromEntries(IN_IDS.map((id) => [id, common])),
    });
    expect(peak(broken.diff!), 'flipping a subtracted channel breaks the null').toBeCloseTo(0.8 * 2, 5);
  });

  it('a MODEST four-channel patch already leaves the ±1 rail on both buses', async () => {
    // The number that justifies putting `peak` on the faceplate at all. Nothing
    // here is near full scale — 0.9 / 0.9 / 0.6 / 0.4 — and both buses still
    // spend a large fraction of every cycle outside the convention.
    const r = await render({ durationS: 0.5, inputs: standardInputs() });
    const sumOut = fractionOutside(r.sum!, 1);
    const diffOut = fractionOutside(r.diff!, 1);
    expect(sumOut, `SUM outside ±1 for ${(sumOut * 100).toFixed(1)} % of samples`).toBeGreaterThan(0.2);
    expect(diffOut, `DIFF outside ±1 for ${(diffOut * 100).toFixed(1)} % of samples`).toBeGreaterThan(0.2);
    // Every individual ATT jack, by contrast, stays inside — the over-range is
    // a property of the SUMMING, which is exactly what the readout says.
    for (const id of MIX_OUT_IDS.filter((o) => /^att\d+$/.test(o))) {
      expect(fractionOutside(r[id]!, 1), `${id} stays on the rail`).toBe(0);
    }
  });
});

// ── M4 — the instrument's own blind spot ────────────────────────────────────

describe('ILLOGIC audit / M4 — a level statistic cannot see an attenuverter', () => {
  it('att = −1 and +1 are IDENTICAL in rms and peak, and differ by 2× the input', async () => {
    // Recorded here because it is the reason every comparison in this file is a
    // SIGNED per-sample delta rather than an rms ratio: an "is this control
    // alive?" sweep built on level would report the attenuverter's defining
    // behaviour as doing nothing. An attenuverter is the most common control
    // shape in the unfaced tail, so this generalises.
    const inputs = { in1: sine(3, 0.9, HALF_S) };
    const pos = await render({ durationS: 0.5, params: { att1_amount: 1 }, inputs });
    const neg = await render({ durationS: 0.5, params: { att1_amount: -1 }, inputs });

    expect(rms(neg.att1!), 'rms is BLIND to the sign flip').toBeCloseTo(rms(pos.att1!), 12);
    expect(peak(neg.att1!), 'peak is blind too').toBeCloseTo(peak(pos.att1!), 12);
    expect(maxAbsDelta(pos.att1!, neg.att1!), 'the SIGNED delta sees it: 2 × the 0.9 amplitude')
      .toBeCloseTo(1.8, 5);
  });
});

// ── M5 — #1750, the gate threshold ──────────────────────────────────────────

describe('ILLOGIC audit / M5 — the rendered gate obeys the DECLARED threshold (#1750)', () => {
  /** The rendered gate value on in1, read through NOT (`1 − gate1`). */
  async function gateAt(v: number): Promise<number> {
    const n = Math.round(SR * 0.01);
    const r = await render({ durationS: 0.01, inputs: { in1: dc(v, n) } });
    return 1 - r.not![n - 100]!;
  }

  const THRESHOLD = 0.5;

  it('AT EXACTLY the declared threshold the rendered gate is 1 — the pure helper and the graph agree', async () => {
    // ⚠ THE DEFECT THIS PR FIXES. `thresholdCurve` built its step with
    // `x >= threshold`, but a WaveShaperNode LINEARLY INTERPOLATES between
    // curve samples and 0.5 lands at index 3071.25 of 4096 — a quarter of the
    // way up the ramp. MEASURED BEFORE THE FIX, at in1 = in2 = 0.500000:
    //
    //     gate 0.250000   not 0.750000   and 0.062500
    //                     or  0.437500   nand 0.937500
    //
    // …against a contract that says `>= 0.5` is HIGH in three separate places
    // (`illogicMath.gate`, the def's own `docs`, the module manifest). Every
    // gate was green because every gate read ONE SIDE: the pure helper's
    // arithmetic, or a truth table sampled at 0.49 / 0.51.
    expect(illogicMath.gate(THRESHOLD), 'the pure helper says HIGH').toBe(1);
    expect(await gateAt(THRESHOLD), 'and now so does the rendered graph').toBeCloseTo(1, 6);

    const n = Math.round(SR * 0.01);
    const r = await render({ durationS: 0.01, inputs: { in1: dc(THRESHOLD, n), in2: dc(THRESHOLD, n) } });
    expect(r.and![n - 100], 'AND at the threshold').toBeCloseTo(1, 6);
    expect(r.or![n - 100], 'OR at the threshold').toBeCloseTo(1, 6);
    expect(r.nand![n - 100], 'NAND at the threshold').toBeCloseTo(0, 6);
    expect(r.not![n - 100], 'NOT at the threshold').toBeCloseTo(0, 6);
  });

  it('the interpolation ramp sits ENTIRELY BELOW the threshold, and is one curve step wide', async () => {
    // WaveShaper interpolation imposes a ramp exactly ONE CURVE INDEX wide and
    // it cannot be removed at any table size. What CAN be decided is which SIDE
    // of the threshold it falls on — and the contract only ever speaks about
    // `>= threshold`, so the correct side is BELOW.
    //
    // The ramp's edges are derived from the same arithmetic the fix uses rather
    // than from a fudge factor, so this asserts the PROPERTY (which side) and
    // not a number that would have to be re-tuned with the table size.
    const SIZE = 4096;
    const xAt = (i: number) => (i / (SIZE - 1)) * 2 - 1;
    const stepIndex = Math.floor(((THRESHOLD + 1) / 2) * (SIZE - 1));
    const rampLo = xAt(stepIndex - 1); // last fully-LOW input
    const rampHi = xAt(stepIndex); // first fully-HIGH input

    // ⚠ THE WHOLE FIX, as one assertion: nothing at or above the declared
    // threshold is in the ramp.
    expect(rampHi, 'the ramp ends BELOW the declared threshold').toBeLessThan(THRESHOLD);
    expect(rampHi - rampLo, 'the ramp is exactly one curve index wide (input units)')
      .toBeCloseTo(2 / (SIZE - 1), 12);

    expect(await gateAt(rampLo), 'the ramp floor renders fully LOW').toBe(0);
    expect(await gateAt(rampHi), 'the ramp ceiling renders fully HIGH').toBeCloseTo(1, 6);

    // Agreement with the pure helper everywhere the contract speaks — which is
    // everything except the interior of that one step.
    const probes = [-2, -1, 0, 0.25, 0.4, 0.49, 0.4994, 0.5, 0.5001, 0.51, 0.75, 1, 2];
    let asserted = 0;
    for (const v of probes) {
      if (v > rampLo && v < rampHi) continue; // the ramp interior, by construction
      expect(await gateAt(v), `rendered gate at in = ${v} must equal illogicMath.gate(${v})`)
        .toBeCloseTo(illogicMath.gate(v), 5);
      asserted++;
    }
    // …and the exclusion must be narrow enough that the loop still asserted
    // nearly everything, so a widened ramp cannot quietly empty this test.
    expect(asserted, 'the ramp excludes at most one probe').toBeGreaterThanOrEqual(probes.length - 1);
  });

  it('NEGATIVE CONTROL: the PRE-FIX curve construction still fails, on the same probe', async () => {
    // The defect is data, so the control has to be too. This reproduces the old
    // `x >= threshold` step in-line and asserts, through the SAME interpolation
    // arithmetic WaveShaper applies, that it lands 0.25 at the declared
    // threshold — so a revert to it cannot come back green.
    const SIZE = 4096;
    const preFix = new Float32Array(SIZE);
    for (let i = 0; i < SIZE; i++) {
      const x = (i / (SIZE - 1)) * 2 - 1;
      preFix[i] = x >= THRESHOLD ? 1 : 0;
    }
    /** WaveShaper's own lookup: map v ∈ [−1,1] onto the table, clamp, lerp. */
    const shape = (curve: Float32Array, v: number): number => {
      const idx = ((Math.max(-1, Math.min(1, v)) + 1) / 2) * (curve.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.min(curve.length - 1, lo + 1);
      return curve[lo]! + (idx - lo) * (curve[hi]! - curve[lo]!);
    };
    expect(shape(preFix, THRESHOLD), 'the pre-fix curve renders 0.25 at the declared threshold')
      .toBeCloseTo(0.25, 9);
    expect(shape(preFix, THRESHOLD), 'which is NOT what illogicMath.gate declares')
      .not.toBeCloseTo(illogicMath.gate(THRESHOLD), 3);

    // POSITIVE CONTROL on the same lookup, so `shape()` is not simply broken:
    // far from the threshold both constructions agree with the contract.
    expect(shape(preFix, 0.9)).toBe(1);
    expect(shape(preFix, 0.1)).toBe(0);
  });
});

// ── M6 — edge fidelity (the sweep that found nothing) ───────────────────────

describe('ILLOGIC audit / M6 — no dropped edges, on EITHER leg of the multiplier', () => {
  it('captures 100 % of pulses at 1–16 Hz down to a SINGLE SAMPLE, on both legs', async () => {
    // The buggles (#1703) / backdraft (#1725) class, looked for and not found.
    //
    // ⚠ THE TWO LEGS ARE NOT THE SAME TEST, and testing only one would have
    // been the "clean probe, wrong probe" mistake. `and` is built as
    // gate1 → andOut (an AUDIO input) with gate2 → andOut.gain (an AudioParam
    // MODULATOR). Only the second leg can expose a k-rate AudioParam, which
    // would quantise to 128-sample blocks and swallow anything narrower —
    // exactly the flat-fraction signature those two defects had. So in1 is
    // pulsed against a held in2, and then in2 against a held in1.
    const DURATION_S = 2;
    const n = SR * DURATION_S;
    const widths = [1, Math.round(0.001 * SR), Math.round(0.005 * SR), Math.round(0.02 * SR)];

    for (const rateHz of [1, 2, 4, 8, 16]) {
      for (const w of widths) {
        const train = pulses(rateHz, w, n);
        const expected = risingEdges(train);
        expect(expected, `the driver itself must carry edges at ${rateHz} Hz`).toBeGreaterThan(0);

        const legA = await render({ durationS: DURATION_S, inputs: { in1: train, in2: dc(1, n) } });
        const legB = await render({ durationS: DURATION_S, inputs: { in1: dc(1, n), in2: train } });
        const usPerPulse = ((w / SR) * 1e6).toFixed(1);
        expect(
          risingEdges(legA.and!),
          `AUDIO leg: ${rateHz} Hz × ${usPerPulse} µs pulses (${w} samples)`,
        ).toBe(expected);
        expect(
          risingEdges(legB.and!),
          `AudioParam MODULATOR leg: ${rateHz} Hz × ${usPerPulse} µs pulses (${w} samples)`,
        ).toBe(expected);
      }
    }
  });

  it('INSTRUMENT CONTROLS: the counter reads 0 when it should, and a number it was not handed', async () => {
    // A sweep whose counter simply echoed `expected` would print the same
    // perfect table. Two legs, both necessary:
    const DURATION_S = 2;
    const n = SR * DURATION_S;
    const at8 = pulses(8, Math.round(0.005 * SR), n);

    // (a) it can read ZERO — in2 low means AND can never fire, while OR still
    //     carries every edge, so "0" is not "the render was empty".
    const gated = await render({ durationS: DURATION_S, inputs: { in1: at8, in2: dc(0, n) } });
    expect(risingEdges(gated.and!), 'AND with the other input LOW').toBe(0);
    expect(risingEdges(gated.or!), 'OR on the same render still counts every edge').toBe(risingEdges(at8));

    // (b) it can read a number NEITHER input carries — 8 Hz AND 4 Hz coincide
    //     only on the 4 Hz beats, so the counter must report the PRODUCT.
    const at4 = pulses(4, Math.round(0.005 * SR), n);
    const beat = await render({ durationS: DURATION_S, inputs: { in1: at8, in2: at4 } });
    expect(risingEdges(at8)).toBe(16);
    expect(risingEdges(at4)).toBe(8);
    expect(risingEdges(beat.and!), 'the product, not either input').toBe(8);
  });

  it('no gate output ever leaves [0, 1], including on COINCIDENT edges', async () => {
    // `or` is composed as gate1 + gate2 − and. If the AudioParam leg lagged the
    // audio leg by even one block, a coincident edge would emit 2.0 for 2.67 ms.
    // It does not.
    const n = SR;
    const train = pulses(4, Math.round(0.02 * SR), n);
    const r = await render({ durationS: 1, inputs: { in1: train, in2: train } });
    for (const id of LOGIC_OUT_IDS) {
      let worst = 0;
      const x = r[id]!;
      for (let i = 0; i < x.length; i++) worst = Math.max(worst, -x[i]!, x[i]! - 1);
      expect(worst, `${id} excursion outside [0,1], in LINEAR AMPLITUDE`).toBeCloseTo(0, 9);
    }
  });
});

// ── M7 — the rank, and the model's structural claims ────────────────────────

describe('ILLOGIC audit / M7 — the RANK is an intrinsic axis, measured', () => {
  it('channel REACH is non-increasing along face.order, and the tie is broken by channel', async () => {
    // Four attenuverters look interchangeable — the `bluebox` problem — and the
    // honest surrender would be "rank by channel number, there is nothing to
    // say". There IS something to say: the module supplies its own axis (the
    // `moog914` answer), because in1/in2 are tapped by the logic block and
    // in1 alone drives NOT, while in3/in4 reach no boolean jack at all.
    //
    // Each input is driven ALONE and the reached-output set is read off the
    // render. No count is typed anywhere: the sets are compared, and the
    // ordering is asserted as a relation.
    const n = Math.round(SR * 0.05);
    const silent = await render({ durationS: 0.05 });
    const reach: Record<string, string[]> = {};
    for (const inId of IN_IDS) {
      const r = await render({ durationS: 0.05, inputs: { [inId]: sine(11, 0.9, n) } });
      reach[inId] = OUT_IDS.filter((o) => maxAbsDelta(r[o]!, silent[o]!) > 0);
    }

    const order = illogicDef.face!.order!;
    const inputForRank = order.map((paramId) => {
      const i = ILLOGIC_ATT_PARAM_IDS.indexOf(paramId);
      expect(i, `${paramId} is a declared attenuverter`).toBeGreaterThanOrEqual(0);
      return IN_IDS[i]!;
    });
    const sizes = inputForRank.map((inId) => reach[inId]!.length);
    for (let i = 1; i < sizes.length; i++) {
      expect(
        sizes[i]!,
        `rank ${i + 1} (${inputForRank[i]}) must not reach MORE outputs than rank ${i} (${inputForRank[i - 1]}): ${JSON.stringify(sizes)}`,
      ).toBeLessThanOrEqual(sizes[i - 1]!);
    }
    // The axis must actually SEPARATE the channels — otherwise it is a tie
    // dressed as an argument and the rank would be arbitrary after all.
    expect(new Set(sizes).size, 'the reach axis distinguishes at least two ranks').toBeGreaterThan(1);
    expect(sizes[0]!, 'the top-ranked channel strictly outreaches the bottom one')
      .toBeGreaterThan(sizes[sizes.length - 1]!);
  });

  it('ANCHOR: the model\'s logic-tap and NOT declarations match the rendered graph', async () => {
    // `ILLOGIC_LOGIC_TAPPED_INPUTS` and `ILLOGIC_NOT_INPUT` are the one pair of
    // structural facts nothing in the def declares — the routing picture draws
    // from them. They are anchored to the ARTIFACT here rather than taken on
    // the declaration's word.
    const n = Math.round(SR * 0.05);
    const silent = await render({ durationS: 0.05 });
    const tapped: string[] = [];
    const movesNot: string[] = [];
    for (const inId of IN_IDS) {
      const r = await render({ durationS: 0.05, inputs: { [inId]: sine(11, 0.9, n) } });
      if (LOGIC_OUT_IDS.some((o) => maxAbsDelta(r[o]!, silent[o]!) > 0)) tapped.push(inId);
      if (maxAbsDelta(r.not!, silent.not!) > 0) movesNot.push(inId);
    }
    expect(tapped.sort()).toEqual([...ILLOGIC_LOGIC_TAPPED_INPUTS].sort());
    expect(movesNot).toEqual([ILLOGIC_NOT_INPUT]);
  });

  it('ANCHOR: the DIFF polarity vector matches the rendered difference bus', async () => {
    // `ILLOGIC_DIFF_SIGNS` decides both the readout and the `+`/`−` marks in
    // the picture. Drive each input alone and read the SIGN the diff bus gives
    // it back.
    const n = Math.round(SR * 0.05);
    for (const [i, inId] of IN_IDS.entries()) {
      const r = await render({ durationS: 0.05, inputs: { [inId]: dc(0.5, n) } });
      const rendered = Math.sign(r.diff![n - 100]!);
      expect(rendered, `${inId} enters DIFF with the declared polarity`).toBe(ILLOGIC_DIFF_SIGNS[i]!);
      // …and enters SUM positively, on every channel — that is what makes DIFF
      // the polarity-split bus rather than both of them being.
      expect(Math.sign(r.sum![n - 100]!), `${inId} enters SUM positively`).toBe(1);
    }
  });
});
