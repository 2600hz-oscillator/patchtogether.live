// art/scenarios/analog-logic-maths/face-audit.test.ts
//
// THE ADVERSARIAL AUDIT FOR ANALOGLOGICMATHS, and the permanent anchor under
// its faceplate (queue Q19).
//
// Everything here is measured against the REAL `analogLogicMathsDef.factory`
// under node-web-audio-api's OfflineAudioContext at 48 kHz — the SHIPPING
// worklet, loaded through the def's own `audioWorklet.addModule`, not a pure-TS
// mirror. (⚠ `algebra.test.ts` in this directory says node-web-audio-api cannot
// host AudioWorkletNodes and drives the processor class directly. That was true
// of the version it was written against and is not true of the pinned one —
// `art/setup/node-audio-globals.ts` records the correction. Its core-direct
// approach is still a perfectly good unit; this file is the INTEGRATION half.)
//
// WHAT THIS FILE IS FOR, beyond regression. Five separate claims the faceplate
// prints are claims about the MODULE, and a unit test over the readout
// functions can only ever prove they are claims about the readout functions:
//
//   1. SUM IS A SATURATOR. The −6.34 dB / −12.05 dB compression figures that
//      §11.1 DERIVED from the declared law, re-measured at the jack, with the
//      dB REFERENCE named in the assertion message (the queue's own §15.13
//      lesson: a dB figure with an unstated denominator is not a measurement).
//   2. THE SOFT-CLIP IS ON THE WRONG PAIR OF JACKS. DIFF is the only output
//      that leaves the ±1 rail for in-range inputs, and it is the only one with
//      no clip. Asserted in BOTH directions — nothing else reaches the ceiling,
//      and DIFF attains it — so the sweep cannot pass by measuring nothing.
//   3. THE RANK AXIS ILLOGIC USED IS REFUSED HERE, ON A MEASUREMENT. Ranking by
//      REACH gives a different answer when the two input amplitudes are swapped,
//      because MIN/MAX are selectors. Both readings are asserted.
//   4. THE CV AUDIT the #1661 / #1662 / #1664 class owes — including the fold
//      point this module has and #1750 says to sample AT: `attA`/`attB` ship at
//      +1, which IS the top of the declared −1..+1 range, so a POSITIVE CV is
//      bit-exactly inert.
//   5. WITH ONE INPUT UNPATCHED the module is a rectifier pair and PRODUCT is
//      silent — the behaviour a player meets first and the docs never stated.
//
// DETERMINISM IS PROVEN, NOT ASSUMED (#1680): M0 renders the same scene twice
// and asserts bit-identity across every declared output, because
// node-web-audio-api renders off-thread and three modules have already measured
// racy under it.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { analogLogicMathsDef, analogLogicMath } from '$lib/audio/modules/analog-logic-maths';
import {
  ALM_ATT_PARAM_IDS,
  ALM_CLIPPED_OUT_IDS,
  ALM_LINEAR_OUT_IDS,
  ALM_OUT_IDS,
  ALM_PROBE,
  almDiffGain,
  almPeak,
  almRingGain,
  almSumGain,
} from '$lib/ui/modules/analog-logic-maths-face-model';

const SR = 48000;
const DUR_S = 0.05;
const N = Math.round(SR * DUR_S);
/** Past the worklet's first render quanta. M9 asserts there is no transient to
 *  skip, so this is a belt on a brace rather than a fudge. */
const SETTLE = Math.round(0.01 * SR);

/** Every declared output / input, in declaration order. DERIVED — there is no
 *  port list in this file and no count of one. */
const OUT_IDS: readonly string[] = analogLogicMathsDef.outputs.map((o) => o.id);
/** The SIGNAL inputs: a declared input with no `paramTarget`. */
const SIGNAL_INS: readonly string[] = analogLogicMathsDef.inputs
  .filter((p) => !p.paramTarget)
  .map((p) => p.id);
/** The CV-on-knob inputs, and what each one targets. */
const PARAM_INPUT_IDS: readonly string[] = analogLogicMathsDef.inputs
  .filter((p) => p.paramTarget)
  .map((p) => p.id);
const PARAM_TARGET_OF = new Map(
  analogLogicMathsDef.inputs.filter((p) => p.paramTarget).map((p) => [p.id, p.paramTarget!]),
);

/** The def's shipped spawn defaults. */
const DEFAULTS: Record<string, number> = Object.fromEntries(
  analogLogicMathsDef.params.map((p) => [p.id, p.defaultValue]),
);

const fmt = (v: number) => (v === 0 ? '0.0000e+0' : v.toExponential(4));

type Leg =
  | { kind: 'none' }
  /** The terminal `AudioEngine.addEdge` connects: `inputs.get(id).param` when
   *  the handle publishes one, else `inputs.get(id).node` at `.input`. */
  | { kind: 'cv'; id: string; offset: number }
  | { kind: 'knob'; id: string; value: number }
  /** EXACTLY the branch `AudioEngine.scheduleParam` / `holdParam` take. */
  | { kind: 'automation'; id: string; value: number }
  /** ⚠ THE WRONG TERMINAL, ON PURPOSE — see M6's shared-slot leg. */
  | { kind: 'cv-to-node-input'; id: string; offset: number };

interface Render {
  /** settled sample per DECLARED output id. */
  out: Record<string, number>;
  /** THE RAW HEAD — from sample 0, spanning the first two 128-frame render
   *  quanta and a little beyond. `buf` starts at `SETTLE`, so without this the
   *  first-quantum leg (#1744) would have been reading a sample 480 frames in
   *  and calling it "sample 0". Kept as its own field rather than by moving
   *  `buf`'s origin, because the bit-identity and fraction-outside legs WANT to
   *  skip any settling. */
  head: Record<string, Float32Array>;
  /** the settled window per output, for the bit-identity leg. */
  buf: Record<string, Float32Array>;
  /** DERIVED off the LIVE handle — never typed. */
  paramTerminals: string[];
  portTerminals: string[];
  /** paramTarget inputs whose published AudioParam belongs to a node that is
   *  NOT the DSP worklet — the shape of the #1661 / #1662 defect. */
  offWorkletHosts: string[];
}

/**
 * Drive the shipping factory. `drive` is a per-signal-port DC level (a number
 * applies to every signal port); `wave` overrides a port with a full buffer.
 *
 * DC IS THE RIGHT INSTRUMENT for almost everything here: every law on this
 * module is memoryless and sample-wise, so the settled sample IS the whole
 * story — no phase to align, no window to choose. The two legs that need a
 * waveform (the rectifier leg and the fraction-outside-the-rail leg) pass one.
 */
async function render(opts: {
  params?: Record<string, number>;
  drive?: number | Record<string, number>;
  wave?: Record<string, Float32Array>;
  leg?: Leg;
}): Promise<Render> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: OUT_IDS.length,
    length: N,
    sampleRate: SR,
  });
  const handle = await analogLogicMathsDef.factory(ctx as unknown as AudioContext, {
    id: 'face-audit',
    type: analogLogicMathsDef.type,
    position: { x: 0, y: 0 },
    params: { ...DEFAULTS, ...(opts.params ?? {}) },
  } as never);

  for (const id of SIGNAL_INS) {
    const ref = handle.inputs.get(id)!;
    const wave = opts.wave?.[id];
    if (wave) {
      const buf = ctx.createBuffer(1, wave.length, SR);
      const copy = new Float32Array(wave.length);
      copy.set(wave);
      buf.copyToChannel(copy, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ref.node, 0, ref.input);
      src.start(0);
      continue;
    }
    const dc = typeof opts.drive === 'number' ? opts.drive : opts.drive?.[id];
    if (typeof dc !== 'number') continue;
    const cs = ctx.createConstantSource();
    cs.offset.value = dc;
    cs.connect(ref.node, 0, ref.input);
    cs.start(0);
  }

  // Duck-typed on `.parameters` (the AudioParamMap every AudioWorkletNode has
  // and a GainNode does not), so it does not depend on which realm installed the
  // AudioWorkletNode global.
  const paramTerminals: string[] = [];
  const portTerminals: string[] = [];
  const offWorkletHosts: string[] = [];
  for (const id of PARAM_INPUT_IDS) {
    const ref = handle.inputs.get(id);
    if (ref?.param) {
      paramTerminals.push(id);
      if (!('parameters' in ref.node)) offWorkletHosts.push(id);
    } else if (ref) {
      portTerminals.push(id);
    }
  }

  const leg = opts.leg ?? { kind: 'none' };
  if (leg.kind === 'cv' || leg.kind === 'cv-to-node-input') {
    const ref = handle.inputs.get(leg.id);
    if (!ref) throw new Error(`face-audit: no input port '${leg.id}'`);
    const cs = ctx.createConstantSource();
    cs.offset.value = leg.offset;
    // The terminal is DERIVED for the `cv` leg and FORCED for the other.
    if (leg.kind === 'cv' && ref.param) cs.connect(ref.param);
    else cs.connect(ref.node, 0, ref.input);
    cs.start(0);
  } else if (leg.kind === 'knob') {
    handle.setParam(leg.id, leg.value);
  } else if (leg.kind === 'automation') {
    const param = handle.inputs.get(leg.id)?.param;
    if (param) param.setValueAtTime(leg.value, 0);
    else handle.setParam(leg.id, leg.value);
  }

  const merger = ctx.createChannelMerger(OUT_IDS.length);
  OUT_IDS.forEach((id, i) => {
    const o = handle.outputs.get(id)!;
    o.node.connect(merger, o.output, i);
  });
  merger.connect(ctx.destination);
  const rendered = await ctx.startRendering();

  const out: Record<string, number> = {};
  const buf: Record<string, Float32Array> = {};
  const head: Record<string, Float32Array> = {};
  OUT_IDS.forEach((id, i) => {
    const chan = rendered.getChannelData(i);
    buf[id] = chan.slice(SETTLE);
    head[id] = chan.slice(0, 320);
    out[id] = chan[N - 1]!;
  });
  return { out, buf, head, paramTerminals, portTerminals, offWorkletHosts };
}

/** The largest |Δ| across every declared output, in LINEAR amplitude. */
function peakDelta(a: Render, b: Render): number {
  let peak = 0;
  for (const id of OUT_IDS) peak = Math.max(peak, Math.abs(a.out[id]! - b.out[id]!));
  return peak;
}

function peakOf(x: Float32Array): number {
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

/** C4. ⚠ NOT 1000 Hz — the `destroy` trap (#1766): 1000 Hz is exactly 48
 *  samples/period at 48 kHz and visits only 25 distinct magnitudes. 183.47
 *  samples/period is co-prime enough with every block boundary here that the
 *  rectifier leg below sees the whole waveform. */
const C4_HZ = 261.6256;

function sine(freqHz: number, amp: number, n: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / SR);
  return a;
}

/** Each leg instantiates the REAL worklet in a fresh OfflineAudioContext. This
 *  bounds the failure; it is never the gate. */
const TIMEOUT_MS = 300_000;

// ── M0 — the instrument ─────────────────────────────────────────────────────

describe('ALM audit / M0 — the render is REPRODUCIBLE', () => {
  it('two renders of the same scene are BIT-IDENTICAL on every declared output', async () => {
    // #1680: node-web-audio-api renders off-thread and a host-side pump can keep
    // firing during a render — three modules measured racy under it. Every
    // number in this file is a difference between two renders, so a
    // non-reproducible render would make all of them noise wearing four decimal
    // places. This module has no pump (it is a stateless per-sample function)
    // and that is ASSERTED rather than assumed, so a future one cannot land
    // quietly.
    const scene = { drive: { a: 0.7, b: -0.3 }, params: { attA: 0.8, attB: -0.6 } };
    const x = await render(scene);
    const y = await render(scene);
    for (const id of OUT_IDS) {
      expect(Array.from(x.buf[id]!), `bit-identity on '${id}'`).toEqual(Array.from(y.buf[id]!));
    }
  }, TIMEOUT_MS);
});

// ── M1 — the idle state, and the first quantum ──────────────────────────────

describe('ALM audit / M1 — what an UNPATCHED module emits', () => {
  it('every jack rests at BIT-EXACT ZERO, from sample 0', async () => {
    // Worth stating because its sibling does the opposite: ILLOGIC's NAND and
    // NOT sit at a constant +1 from spawn and hold two gate cables open. ALM has
    // no ConstantSource anywhere in its factory, so an unpatched module is
    // silent on all five jacks — and it is silent from the FIRST sample, not
    // after a ramp (the featurecv lesson, #1744: a factory's first render
    // quantum can read differently from every quantum after it).
    //
    // ⚠ BOTH WINDOWS, and that is the point: `buf` starts at `SETTLE`, so on its
    // own it would prove nothing about the head — which is exactly the claim in
    // this test's own name. `head` starts at sample 0.
    const r = await render({});
    for (const id of OUT_IDS) {
      expect(peakOf(r.head[id]!), `'${id}' is bit-exactly silent from SAMPLE 0`).toBe(0);
      expect(peakOf(r.buf[id]!), `'${id}' is bit-exactly silent in steady state`).toBe(0);
    }
  }, TIMEOUT_MS);

  it('NO first-quantum transient on a DRIVEN render either — read from SAMPLE 0', async () => {
    // ⚠ THE FIRST DRAFT OF THIS LEG COULD NOT SEE WHAT IT CLAIMED TO. It read
    // `buf[id][0]`, and `buf` starts at `SETTLE` (480 frames in) — so a genuine
    // one-quantum transient would have been skipped by the very slice meant to
    // avoid it, and the test would have gone green calling frame 480 "sample 0".
    // `head` exists for this leg alone and starts at 0.
    //
    // EVERY sample of the first two 128-frame render quanta is compared against
    // steady state, so a block-quantised parameter, a one-quantum init or a
    // ramped param would all show (the featurecv class, #1744).
    const r = await render({ drive: { a: 0.5, b: -0.25 } });
    for (const id of OUT_IDS) {
      const settled = r.out[id]!;
      const h = r.head[id]!;
      const offenders = [];
      for (let i = 0; i < h.length; i++) {
        if (h[i] !== settled) offenders.push(`${id}[${i}]=${h[i]} != ${settled}`);
        if (offenders.length >= 3) break;
      }
      expect(
        offenders,
        `'${id}': the first ${h.length} samples (quanta 0-2) must all equal steady state`,
      ).toEqual([]);
    }
    // NEGATIVE CONTROL on the instrument — `head` really does start at sample 0
    // and really is shorter than `buf`'s origin, so the loop above cannot be
    // silently reading the settled region the way the first draft did.
    expect(r.head[OUT_IDS[0]!]!.length).toBeLessThan(SETTLE);
    expect(r.head[OUT_IDS[0]!]![0], 'head[0] IS the render\'s first sample')
      .toBe(analogLogicMath.min(0.5, -0.25));
  }, TIMEOUT_MS);
});

// ── M2 — the five laws, at the jack ─────────────────────────────────────────

describe('ALM audit / M2 — the pure helpers AGREE with the shipping worklet', () => {
  it('every declared jack matches `analogLogicMath` over a table of DC pairs', async () => {
    // `analogLogicMath` is exported from the def and is what every unit test in
    // packages/web exercises; the worklet is what a player hears. Nothing else
    // in the repo compares the two — the module unit test drives the helper
    // alone and `algebra.test.ts` drives the processor class alone — so this is
    // where a divergence between the float64 model and the float32 worklet would
    // surface.
    //
    // ⚠ RELATIVE error, not absolute, and the unit is the point (§13's budget
    // lesson): these results span 0 to 2, so an absolute budget would be a
    // different assertion at every probe magnitude.
    //
    // ⚠ …EXCEPT AT A NULL, WHERE RELATIVE IS THE WRONG INSTRUMENT AND SAYS SO
    // LOUDLY. This module cancels: at `a=−0.6 b=0.2 att=0.25/0.75` the summed
    // pair is −0.15 + 0.15, which float64 evaluates to 2.8e-17 and the float32
    // worklet to −3.7e-9. Both are zero to any honest reading; their RATIO is
    // 1.3e8, and the first draft of this leg went red on it. So the metric
    // SWITCHES on the expected magnitude, with the switch and its budget stated
    // in the message rather than buried: below `NULL_FLOOR` the claim is that
    // the jack is silent (absolute), above it that the two agree (relative).
    // The floor is a float32-noise budget on quantities of order 1, four orders
    // above the 3.7e-9 seen and four below the smallest non-null result here.
    const NULL_FLOOR = 1e-6;
    const rows: string[] = [];
    let worst = 0;
    for (const [a, b, attA, attB] of [
      [0.5, 0.3, 1, 1],
      [1, -1, 1, 1],
      [0.7, 0.4, -1, 1],
      [0.9, 0.9, 0.5, -0.5],
      [-0.6, 0.2, 0.25, 0.75],
      [1, 1, 0, 1],
    ] as const) {
      const r = await render({ params: { attA, attB }, drive: { a, b } });
      const ap = analogLogicMath.atten(a, attA);
      const bp = analogLogicMath.atten(b, attB);
      const want: Record<string, number> = {
        min: analogLogicMath.min(ap, bp),
        max: analogLogicMath.max(ap, bp),
        diff: analogLogicMath.diff(ap, bp),
        sum: analogLogicMath.sum(ap, bp),
        product: analogLogicMath.product(ap, bp),
      };
      for (const id of OUT_IDS) {
        const got = r.out[id]!;
        const w = want[id]!;
        const isNull = Math.abs(w) < NULL_FLOOR;
        const err = isNull ? Math.abs(got) : Math.abs(got - w) / Math.abs(w);
        worst = Math.max(worst, err);
        rows.push(
          `${id} a=${a} b=${b} att=${attA}/${attB} worklet=${got.toPrecision(8)} ` +
            `model=${w.toPrecision(8)} ${isNull ? 'abs' : 'rel'}=${fmt(err)}`,
        );
      }
    }
    // float32 render vs float64 `Math.tanh`. `Math.fround`'s eps is 1.19e-7 and
    // a tanh rounds a couple of times, so a few ULP is the floor any correct
    // implementation sits at. The budget is 1e-6 — an order of magnitude of
    // slack, and still four orders tighter than any real disagreement in a law
    // could be (a wrong sign moves these by 2× or more).
    expect(
      worst,
      `model vs worklet — RELATIVE error where |model| ≥ ${NULL_FLOOR}, ABSOLUTE below it ` +
        `(both dimensionless / linear amplitude; budget 1e-6): ${rows.join(' | ')}`,
    ).toBeLessThan(1e-6);
  }, TIMEOUT_MS);
});

// ── M3 — the tanh, and the knee ─────────────────────────────────────────────

describe('ALM audit / M3 — SUM IS A SATURATOR, and its knee is reachable', () => {
  it('the compression table REPRODUCES §11.1, against the UN-CLIPPED sum', async () => {
    // ⚠ THE REFERENCE IS THE UN-CLIPPED SUM AND IT IS NAMED IN EVERY MESSAGE.
    // §11.1's first draft quoted −0.318 dB and −6.02 dB — the first against
    // unity, the second against nothing consistent — and the two read as one
    // trend. Its CORRECTED figures were derived from the declared law and
    // flagged as unrendered. They are rendered here.
    const rows: string[] = [];
    const dbAt = async (amp: number): Promise<number> => {
      const r = await render({ drive: { a: amp, b: amp } });
      const lin = 2 * amp;
      const db = 20 * Math.log10(Math.abs(r.out['sum']!) / lin);
      rows.push(`drive=±${amp} unclipped=${lin.toFixed(3)} sum=${r.out['sum']!.toPrecision(8)} ${db.toFixed(4)} dB`);
      return db;
    };
    const atRail = await dbAt(ALM_PROBE);
    const atDouble = await dbAt(2 * ALM_PROBE);
    expect(atRail, `SUM at ±${ALM_PROBE}, dB RE THE UN-CLIPPED SUM: ${rows.join(' | ')}`)
      .toBeCloseTo(-6.34, 2);
    expect(atDouble, `SUM at ±${2 * ALM_PROBE}, dB RE THE UN-CLIPPED SUM: ${rows.join(' | ')}`)
      .toBeCloseTo(-12.05, 2);
    // …and the model the faceplate prints agrees with the jack it was measured
    // at, which is what licenses the `sum` readout.
    const r = await render({ drive: { a: ALM_PROBE, b: ALM_PROBE } });
    expect(r.out['sum']!, 'the `sum` readout law, at the jack')
      .toBeCloseTo(almSumGain([DEFAULTS['attA']!, DEFAULTS['attB']!]) * ALM_PROBE, 6);
  }, TIMEOUT_MS);

  it('THE KNEE IS WELL INSIDE THE RAIL — this is not a corner case', async () => {
    // The STOP-1 question the queue entry asked out loud: *"if the tanh turns
    // out unreachable in practice — every realistic CV source well under ±1, so
    // the clip never engages — that is a NO."*
    //
    // ⚠ MEASURED, AND THE FIRST DRAFT OF THIS LEG ROUNDED THE WRONG WAY. It
    // asserted the 1 dB crossing at ≤ ±0.3 "about a third of the rail", off a
    // table reading −0.9627 dB at ±0.3 — which has NOT passed 1 dB. The crossing
    // is between ±0.3 and ±0.4. Both the assertion and every piece of prose in
    // this PR now say ±0.4, which is still less than half the rail and still an
    // amplitude any LFO or envelope reaches.
    const rows: string[] = [];
    let firstOverADb: number | null = null;
    for (const amp of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5]) {
      const r = await render({ drive: { a: amp, b: amp } });
      const db = 20 * Math.log10(Math.abs(r.out['sum']!) / (2 * amp));
      rows.push(`±${amp} → ${db.toFixed(4)} dB`);
      if (firstOverADb === null && db <= -1) firstOverADb = amp;
    }
    expect(
      firstOverADb,
      `drive at which SUM's compression passes 1 dB RE THE UN-CLIPPED SUM: ${rows.join(' | ')}`,
    ).not.toBeNull();
    expect(firstOverADb!, `…and it must be well inside the rail: ${rows.join(' | ')}`)
      .toBeLessThanOrEqual(0.4 * ALM_PROBE);
  }, TIMEOUT_MS);

  it('THE JOIN: closing ATT B nearly triples the transparency', async () => {
    // The merit claim in one assertion. Neither dial can print a compression
    // that only exists when both are open — with ATT B shut the same full-scale
    // input compresses by −2.37 dB instead of −6.34 dB.
    const both = await render({ drive: { a: ALM_PROBE, b: ALM_PROBE } });
    const one = await render({ params: { attB: 0 }, drive: { a: ALM_PROBE, b: ALM_PROBE } });
    const dbBoth = 20 * Math.log10(Math.abs(both.out['sum']!) / 2);
    const dbOne = 20 * Math.log10(Math.abs(one.out['sum']!) / 1);
    expect(dbOne, 'ATT B at 0, dB re the un-clipped sum (=1)').toBeCloseTo(-2.37, 2);
    expect(dbBoth, 'both dials open, dB re the un-clipped sum (=2)').toBeCloseTo(-6.34, 2);
    expect(dbBoth, `opening the second dial must move the compression by > 3 dB: ${dbOne.toFixed(3)} → ${dbBoth.toFixed(3)} dB`)
      .toBeLessThan(dbOne - 3);
  }, TIMEOUT_MS);

  it('NEGATIVE CONTROL: the LINEAR jacks do NOT compress at the same drive', async () => {
    // The instrument's own control. If the harness were measuring some global
    // level effect rather than the tanh, DIFF would move with it. DIFF is
    // exactly proportional to its drive over the whole range where SUM loses
    // 6.3 dB.
    const rows: string[] = [];
    const lo = await render({ params: { attB: -1 }, drive: { a: 0.1, b: 0.1 } });
    const hi = await render({ params: { attB: -1 }, drive: { a: 1, b: 1 } });
    for (const id of ALM_LINEAR_OUT_IDS) {
      const ratio = hi.out[id]! / lo.out[id]!;
      rows.push(`${id} ×${ratio.toFixed(6)}`);
      expect(ratio, `'${id}' is LINEAR in the drive (×10 in ⇒ ×10 out): ${rows.join(' | ')}`)
        .toBeCloseTo(10, 3);
    }
    // …and SUM, on the same two renders, is NOT. (attB = −1 makes DIFF the live
    // bus; SUM is measured on its own in-phase pair below.)
    const sLo = await render({ drive: { a: 0.1, b: 0.1 } });
    const sHi = await render({ drive: { a: 1, b: 1 } });
    const sRatio = sHi.out['sum']! / sLo.out['sum']!;
    expect(sRatio, `SUM is NOT linear in the drive: ×${sRatio.toFixed(4)} for a ×10 input`)
      .toBeLessThan(5);
  }, TIMEOUT_MS);
});

// ── M4 — the soft-clip is on the wrong pair of jacks ────────────────────────

describe('ALM audit / M4 — DIFF is the ONLY jack that leaves the ±1 rail', () => {
  it('DIFF attains Σ|attN| and NOTHING ELSE reaches it — both directions', async () => {
    // The faceplate's `peak` readout, verified at the JACK rather than against
    // the arithmetic that produces it, and asserted in both directions so the
    // sweep cannot pass on a harness that connected nothing.
    const ceiling = almPeak(ALM_ATT_PARAM_IDS.map((id) => DEFAULTS[id]!));
    // Anti-phase full scale is the worst case the ceiling predicts.
    const r = await render({ drive: { a: ALM_PROBE, b: -ALM_PROBE } });
    expect(r.out['diff']!, `DIFF peak = Σ|attN| (linear amplitude, CV rail = ±${ALM_PROBE})`)
      .toBeCloseTo(ceiling * ALM_PROBE, 5);
    expect(ceiling, 'the ceiling exceeds the rail the buses are measured against')
      .toBeGreaterThan(ALM_PROBE);
    // DIRECTION 2 — every OTHER jack stays inside the rail on that same render.
    const over = OUT_IDS.filter((id) => Math.abs(r.out[id]!) > ALM_PROBE + 1e-6);
    expect(over, 'exactly one jack leaves the ±1 rail on an in-range anti-phase pair')
      .toEqual(['diff']);
  }, TIMEOUT_MS);

  it('the CLIPPED / LINEAR partition the face model declares is the REAL one', async () => {
    // ANCHORED TO THE ARTIFACT. `ALM_CLIPPED_OUT_IDS` decides which curve the
    // sidebar draws bent; it is measured here rather than taken on the
    // declaration's word. A clipped jack must be BOUNDED under a wildly
    // over-range drive; a linear one must scale with it.
    //
    // ⚠ THE STIMULUS MUST BE ASYMMETRIC (0.4 / 0.2, not 0.4 / −0.4): an
    // anti-phase pair puts SUM on its own null, and a ratio taken against zero
    // is a NaN dressed as a measurement.
    // ⚠ AND THE BOUND IS `≤ 1`, NOT `< 1`: `tanh(200)` is exactly 1 in float32,
    // so a strict inequality fails on a correctly-saturating jack. What
    // separates the two halves is not a strict interior but PROPORTIONALITY —
    // the linear jacks track the ×50 and the clipped ones come nowhere near it.
    const SCALE = 50;
    const modest = await render({ drive: { a: 0.4, b: 0.2 } });
    const wild = await render({ drive: { a: 0.4 * SCALE, b: 0.2 * SCALE } });
    for (const id of ALM_CLIPPED_OUT_IDS) {
      const ratio = Math.abs(wild.out[id]! / modest.out[id]!);
      expect(
        Math.abs(wild.out[id]!),
        `'${id}' is declared CLIPPED and must stay on the ±1 rail at a ×${SCALE} drive: ${wild.out[id]}`,
      ).toBeLessThanOrEqual(1 + 1e-6);
      expect(
        ratio,
        `'${id}' is declared CLIPPED and must come nowhere near ×${SCALE}: got ×${ratio.toFixed(4)}`,
      ).toBeLessThan(SCALE / 2);
    }
    for (const id of ALM_LINEAR_OUT_IDS) {
      const ratio = wild.out[id]! / modest.out[id]!;
      expect(
        Math.abs(ratio),
        `'${id}' is declared LINEAR and must scale ×${SCALE} with its drive: got ×${ratio.toFixed(4)}`,
      ).toBeCloseTo(SCALE, 2);
    }
  }, TIMEOUT_MS);

  it('⚠ PRODUCT’s soft-clip CANNOT protect anything for in-range material', async () => {
    // The DSP comment this PR corrects, as a measurement. For |a|,|b| ≤ 1 and
    // |att| ≤ 1 the pre-clip product is already inside ±1, so the tanh is a
    // fixed −2.37 dB of distortion at the corner rather than a limiter — while
    // DIFF, which genuinely can reach ±2, gets no clip at all.
    const rows: string[] = [];
    let worstPreClip = 0;
    for (const [a, b, attA, attB] of [
      [1, 1, 1, 1],
      [1, -1, 1, 1],
      [1, 1, 1, -1],
      [0.9, 0.9, 1, 1],
    ] as const) {
      const pre = a * attA * b * attB;
      worstPreClip = Math.max(worstPreClip, Math.abs(pre));
      const r = await render({ params: { attA, attB }, drive: { a, b } });
      const db = 20 * Math.log10(Math.abs(r.out['product']!) / Math.abs(pre));
      rows.push(`a=${a} b=${b} att=${attA}/${attB} pre=${pre.toFixed(3)} out=${r.out['product']!.toPrecision(6)} ${db.toFixed(4)} dB`);
      expect(db, `PRODUCT, dB RE THE UN-CLIPPED PRODUCT: ${rows.join(' | ')}`).toBeGreaterThan(-2.4);
    }
    expect(worstPreClip, 'the un-clipped product never leaves ±1 for in-range inputs')
      .toBeLessThanOrEqual(1 + 1e-9);
  }, TIMEOUT_MS);

  it('a MODEST anti-phase patch already leaves the rail on DIFF, and only DIFF', async () => {
    // The number that justifies putting `peak` on the faceplate at all. Nothing
    // here is near full scale — 0.9 / −0.9 — and DIFF still spends most of every
    // cycle outside the convention while nothing else ever does.
    const a = sine(C4_HZ, 0.9, N);
    const b = new Float32Array(N);
    for (let i = 0; i < N; i++) b[i] = -a[i]!;
    const r = await render({ wave: { a, b } });
    const outside = fractionOutside(r.buf['diff']!, ALM_PROBE);
    expect(outside, `DIFF outside ±1 for ${(outside * 100).toFixed(1)} % of samples`)
      .toBeGreaterThan(0.4);
    for (const id of OUT_IDS.filter((o) => o !== 'diff')) {
      expect(fractionOutside(r.buf[id]!, ALM_PROBE), `'${id}' stays on the rail`).toBe(0);
    }
  }, TIMEOUT_MS);

  it('DIFF IS A COMMON-MODE NULL AT THE SHIPPED DEFAULTS — read at the jack', async () => {
    // The single most useful sentence the resting faceplate says. One signal
    // into both inputs, both dials at their shipped +1: SUM delivers ×0.96 and
    // DIFF delivers SILENCE.
    const common = sine(C4_HZ, 0.8, N);
    const r = await render({ wave: { a: common, b: common } });
    expect(peakOf(r.buf['diff']!), 'DIFF is bit-exactly silent on a common-mode signal').toBe(0);
    expect(rms(r.buf['sum']!), 'SUM on that same render is very much alive').toBeGreaterThan(0.3);
    // …and the model AGREES with the jack, which licenses the `diff` readout.
    const defaults = ALM_ATT_PARAM_IDS.map((id) => DEFAULTS[id]!);
    expect(almDiffGain(defaults)).toBe(0);
    // NEGATIVE CONTROL on the null: invert ONE dial and DIFF comes alive, so
    // "silent" is a property of the BALANCE and not of a dead output.
    const broken = await render({ params: { attB: -1 }, wave: { a: common, b: common } });
    expect(peakOf(broken.buf['diff']!), 'inverting ATT B breaks the null').toBeCloseTo(1.6, 4);
    expect(peakOf(broken.buf['sum']!), '…and collapses SUM to silence, the exact swap')
      .toBeCloseTo(0, 6);
  }, TIMEOUT_MS);
});

// ── M5 — one input patched ──────────────────────────────────────────────────

describe('ALM audit / M5 — with ONE input unpatched the module is a rectifier pair', () => {
  it('MIN keeps the negative half, MAX the positive half, PRODUCT is bit-exactly silent', async () => {
    // The behaviour a player meets FIRST (you patch one thing before you patch
    // two) and the docs never stated. The unpatched input reads 0, so
    // min(a′, 0) and max(a′, 0) are the two halves of a full-wave pair.
    const a = sine(C4_HZ, 0.8, N);
    const r = await render({ wave: { a } });
    const span = (x: Float32Array) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < x.length; i++) {
        lo = Math.min(lo, x[i]!);
        hi = Math.max(hi, x[i]!);
      }
      return [lo, hi] as const;
    };
    const [minLo, minHi] = span(r.buf['min']!);
    const [maxLo, maxHi] = span(r.buf['max']!);
    expect(minHi, 'MIN never goes positive with B unpatched (linear amplitude)').toBe(0);
    expect(minLo, 'MIN keeps the full negative excursion').toBeCloseTo(-0.8, 3);
    expect(maxLo, 'MAX never goes negative').toBe(0);
    expect(maxHi, 'MAX keeps the full positive excursion').toBeCloseTo(0.8, 3);
    expect(peakOf(r.buf['product']!), 'PRODUCT is bit-exactly silent with either input unpatched')
      .toBe(0);
    // POSITIVE CONTROL — the same stimulus into BOTH inputs makes PRODUCT loud,
    // so "silent" is a property of the missing cable and not of the harness.
    const both = await render({ wave: { a, b: a } });
    expect(rms(both.buf['product']!), 'PRODUCT with both inputs driven').toBeGreaterThan(0.2);
  }, TIMEOUT_MS);
});

// ── M6 — the CV path (the shape defective three times running) ──────────────

describe('ALM audit / M6 — a cable on a paramTarget input must change the audio', () => {
  it('MECH control — ConstantSource(1) → GainNode.gain modulates in THIS harness', async () => {
    const run = async (withCv: boolean) => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
      const src = ctx.createConstantSource();
      src.offset.value = 0.25;
      const g = ctx.createGain();
      g.gain.value = 1;
      src.connect(g);
      g.connect(ctx.destination);
      src.start(0);
      if (withCv) {
        const cs = ctx.createConstantSource();
        cs.offset.value = 1;
        cs.connect(g.gain);
        cs.start(0);
      }
      return Math.abs((await ctx.startRendering()).getChannelData(0)[N - 1]!);
    };
    const off = await run(false);
    const on = await run(true);
    // Without this leg, "the cable never connected" and "the cable connected to
    // nothing" are indistinguishable from a bit-exact zero below.
    expect(on, `CS(1)→gain must modulate: ${off.toFixed(9)} → ${on.toFixed(9)} (linear)`)
      .toBeGreaterThan(off * 1.5);
  }, TIMEOUT_MS);

  it('MECH-WORKLET control — CS → an a-rate AudioWorkletNode param modulates in THIS harness', async () => {
    // GainNode.gain is a NATIVE param and a different code path in
    // node-web-audio-api. Without this leg a bit-exact zero below could be the
    // HOST not honouring worklet-param connections rather than the module not
    // wiring them. Reached off the worklet's OWN parameter map, i.e. through no
    // handle entry under test, so it cannot be greened by the wiring it controls.
    const ctrl = await render({ drive: { a: 1, b: 1 } });
    const ctx = new OfflineAudioContext({ numberOfChannels: OUT_IDS.length, length: N, sampleRate: SR });
    const handle = await analogLogicMathsDef.factory(ctx as unknown as AudioContext, {
      id: 'mech',
      type: analogLogicMathsDef.type,
      position: { x: 0, y: 0 },
      params: DEFAULTS,
    } as never);
    for (const id of SIGNAL_INS) {
      const ref = handle.inputs.get(id)!;
      const cs = ctx.createConstantSource();
      cs.offset.value = 1;
      cs.connect(ref.node, 0, ref.input);
      cs.start(0);
    }
    const params = (handle.outputs.get(OUT_IDS[0]!)!.node as unknown as {
      parameters: Map<string, AudioParam>;
    }).parameters;
    const cs = ctx.createConstantSource();
    cs.offset.value = -2; // +1 → −1 on the attenuverter
    cs.connect(params.get(ALM_ATT_PARAM_IDS[0]!)!);
    cs.start(0);
    const merger = ctx.createChannelMerger(OUT_IDS.length);
    OUT_IDS.forEach((id, i) => {
      const o = handle.outputs.get(id)!;
      o.node.connect(merger, o.output, i);
    });
    merger.connect(ctx.destination);
    const rendered = await ctx.startRendering();
    const d = Math.abs(rendered.getChannelData(0)[N - 1]! - ctrl.out[OUT_IDS[0]!]!);
    expect(d, `CS(−2)→worklet a-rate '${ALM_ATT_PARAM_IDS[0]}' must modulate: |Δ| linear = ${fmt(d)}`)
      .toBeGreaterThan(0);
  }, TIMEOUT_MS);

  it('the module PASSES SIGNAL at the base patch — the control on the base patch itself', async () => {
    const live = await render({ drive: { a: 1, b: 1 } });
    // ⚠ NOT every jack: DIFF is a common-mode null at the defaults BY DESIGN, so
    // requiring all five would be requiring the module to be broken. The clause
    // is that the base patch is not globally silent, plus the named exception.
    const alive = OUT_IDS.filter((id) => Math.abs(live.out[id]!) > 0.1);
    const silent = OUT_IDS.filter((id) => !alive.includes(id));
    expect(silent, 'exactly DIFF is silent on a common-mode base patch').toEqual(['diff']);
  }, TIMEOUT_MS);

  it('every paramTarget input moves the audio through the KNOB path', async () => {
    const ctrl = await render({ drive: { a: 1, b: 1 } });
    const dead: string[] = [];
    const table: string[] = [];
    for (const id of PARAM_INPUT_IDS) {
      const target = PARAM_TARGET_OF.get(id)!;
      const d = peakDelta(await render({ params: { [target]: -1 }, drive: { a: 1, b: 1 } }), ctrl);
      table.push(`${id}→${target} ${DEFAULTS[target]}→-1 ${fmt(d)}`);
      if (d === 0) dead.push(`${id} (${target})`);
    }
    // BOTH a real assertion and the per-input positive control for the CV sweep
    // below: a row reading zero on both legs is the metric being blind.
    expect(dead, `controls inert from their own knob — peak |Δ| linear = 0. Table: ${table.join(' | ')}`)
      .toEqual([]);
  }, TIMEOUT_MS);

  it('every paramTarget input moves the audio through the CV path, and AGREES with its knob', async () => {
    const ctrl = await render({ drive: { a: 1, b: 1 } });
    const dead: string[] = [];
    const disagree: string[] = [];
    const table: string[] = [];
    for (const id of PARAM_INPUT_IDS) {
      const target = PARAM_TARGET_OF.get(id)!;
      const to = -1;
      const cv = peakDelta(
        await render({ drive: { a: 1, b: 1 }, leg: { kind: 'cv', id, offset: to - DEFAULTS[target]! } }),
        ctrl,
      );
      const knob = peakDelta(await render({ params: { [target]: to }, drive: { a: 1, b: 1 } }), ctrl);
      table.push(`${id} ${DEFAULTS[target]}→${to} cv=${fmt(cv)} knob=${fmt(knob)}`);
      if (cv === 0) dead.push(id);
      // THE STRONG FORM: not "the cable moved the audio" but "the cable moved it
      // to the SAME place the knob does" — which separates a live terminal from
      // a live-but-wrong one.
      if (Math.abs(cv - knob) > 1e-6) disagree.push(`${id} (cv ${fmt(cv)} vs knob ${fmt(knob)})`);
    }
    expect(dead, `CV cable inert (peak |Δ| linear = 0) on: ${table.join(' | ')}`).toEqual([]);
    expect(disagree, `CV and KNOB reach DIFFERENT terminals: ${table.join(' | ')}`).toEqual([]);
  }, TIMEOUT_MS);

  it('CLIP AUTOMATION reaches the same live params the CV cables do', async () => {
    // `engine.ts` prefers `inputs[id].param` over `setParam`, so a dead published
    // param makes automation inert too.
    const ctrl = await render({ drive: { a: 1, b: 1 } });
    const target = PARAM_TARGET_OF.get(PARAM_INPUT_IDS[0]!)!;
    const auto = peakDelta(
      await render({ drive: { a: 1, b: 1 }, leg: { kind: 'automation', id: PARAM_INPUT_IDS[0]!, value: -1 } }),
      ctrl,
    );
    const knob = peakDelta(await render({ params: { [target]: -1 }, drive: { a: 1, b: 1 } }), ctrl);
    expect(auto, `automation must reach a LIVE param: ${fmt(auto)} vs knob ${fmt(knob)}`).toBeGreaterThan(0);
    expect(auto, 'automation and knob agree on a live param (peak |Δ| linear)').toBeCloseTo(knob, 6);
  }, TIMEOUT_MS);

  it('⚠ THE CV IS HALF-DEAD AT THE SHIPPED DEFAULT — sampled AT the declared rail', async () => {
    // THE #1750 LESSON APPLIED. This module's fold point is the AudioParam's own
    // declared range, and its DEFAULT SITS EXACTLY ON IT: `attA`/`attB` ship at
    // +1 = `maxValue`, and a CV cable ADDS to the knob, so the computed value is
    // clamped and every positive volt is discarded. Sampled AT +1 (the declared
    // value) and beyond, not merely around it.
    const ctrl = await render({ drive: { a: 1, b: 1 } });
    for (const id of PARAM_INPUT_IDS) {
      for (const offset of [ALM_PROBE, 5]) {
        const d = peakDelta(await render({ drive: { a: 1, b: 1 }, leg: { kind: 'cv', id, offset } }), ctrl);
        expect(d, `'${id}' + ${offset} V at the shipped default: peak |Δ| linear = ${fmt(d)}`).toBe(0);
      }
    }
    // POSITIVE CONTROL — from a knob at 0 the SAME cable lands exactly where the
    // knob at +0.5 does, so the null above is the CLAMP and not a dead cable.
    const target = PARAM_TARGET_OF.get(PARAM_INPUT_IDS[0]!)!;
    const withCv = await render({
      params: { [target]: 0 },
      drive: { a: 1, b: 1 },
      leg: { kind: 'cv', id: PARAM_INPUT_IDS[0]!, offset: 0.5 },
    });
    const withKnob = await render({ params: { [target]: 0.5 }, drive: { a: 1, b: 1 } });
    const d = peakDelta(withCv, withKnob);
    expect(d, `knob 0 + CV 0.5 must equal knob 0.5: peak |Δ| linear = ${fmt(d)}`).toBeLessThan(1e-6);
    // …and the DOWNWARD half is live at the default, which is why the input is
    // half-dead rather than dead.
    const down = peakDelta(
      await render({ drive: { a: 1, b: 1 }, leg: { kind: 'cv', id: PARAM_INPUT_IDS[0]!, offset: -2 } }),
      ctrl,
    );
    expect(down, `the downward half of the same cable IS live: peak |Δ| linear = ${fmt(down)}`)
      .toBeGreaterThan(0.5);
  }, TIMEOUT_MS);

  it('SCOPE — the terminal split is what the handle claims, and no param is published off-worklet', async () => {
    // Deny-by-default and DERIVED off the LIVE handle, not typed. The #1661
    // defect shape removes an input from any filter that asks "is it on the
    // worklet", so a sweep that silently skipped such rows would stay green
    // through the exact defect it exists to find.
    const ctrl = await render({ drive: { a: 1, b: 1 } });
    expect(
      ctrl.offWorkletHosts.slice().sort(),
      'paramTarget inputs published on a non-DSP node — their CV would be a dead end; see #1661/#1662',
    ).toEqual([]);
    expect(
      [...ctrl.paramTerminals, ...ctrl.portTerminals].sort(),
      'every paramTarget input must publish exactly one terminal',
    ).toEqual([...PARAM_INPUT_IDS].sort());
    expect(
      ctrl.portTerminals.slice().sort(),
      'no paramTarget input on this module is audio-rate — a param that stopped being published would land here silently',
    ).toEqual([]);
  }, TIMEOUT_MS);

  it('⚠ THE SHARED NODE-INPUT SLOT IS A LATENT SIGNAL LEAK — named, and shown', async () => {
    // `attA_cv` and `attB_cv` are BOTH published at `{ node: worklet, input: 0 }`
    // — the same node input the `a` SIGNAL port uses — with `param:` set. Every
    // engine path that connects a cable (`addEdge`, its stereo/merger branches,
    // and `scheduleParam`) checks `din.param` FIRST, so the slot is inert today
    // and the leg above proves the cable reaches the param.
    //
    // This leg shows what the shared slot WOULD do if a future edit dropped the
    // `param`, so the hazard is a measured fact in the tree rather than a worry
    // in a comment: the CV would be summed into INPUT A as audio.
    const silent = await render({ drive: { a: 0, b: 0 } });
    for (const id of PARAM_INPUT_IDS) {
      const leaked = await render({
        drive: { a: 0, b: 0 },
        leg: { kind: 'cv-to-node-input', id, offset: 0.25 },
      });
      const d = peakDelta(leaked, silent);
      expect(
        d,
        `'${id}' forced onto its NODE INPUT leaks into signal A (peak |Δ| linear = ${fmt(d)}) — ` +
          `this is what the published \`param\` is protecting, not a live defect`,
      ).toBeGreaterThan(0.2);
    }
  }, TIMEOUT_MS);
});

// ── M7 — the rank, and the axis this module REFUSES ────────────────────────

describe('ALM audit / M7 — REACH is a property of the STIMULUS here, not of the module', () => {
  it('the reach ranking FLIPS when the two input amplitudes are swapped', async () => {
    // ILLOGIC ranked four identical dials by how many jacks each one moves. That
    // axis is intrinsic there (in1/in2 are tapped by the logic block) and it is
    // NOT intrinsic here — MIN and MAX are SELECTORS, so whichever channel is
    // louder owns them and the "reach" of a dial is decided by the patch.
    //
    // Measured both ways so the refusal is a result rather than an opinion. This
    // is the "a clean probe can be the WRONG probe" control, kept permanently.
    const reachUnder = async (av: number, bv: number): Promise<Record<string, string[]>> => {
      const outByParam: Record<string, string[]> = {};
      for (const p of analogLogicMathsDef.params) {
        const lo = await render({ params: { [p.id]: p.min! }, drive: { a: av, b: bv } });
        const hi = await render({ params: { [p.id]: p.max! }, drive: { a: av, b: bv } });
        outByParam[p.id] = OUT_IDS.filter((id) => Math.abs(lo.out[id]! - hi.out[id]!) > 0);
      }
      return outByParam;
    };
    const [pA, pB] = ALM_ATT_PARAM_IDS as [string, string];
    const loud = await reachUnder(0.7, 0.4);
    const swapped = await reachUnder(0.4, 0.7);
    const note = `a>b: ${pA}→${loud[pA]!.length} ${pB}→${loud[pB]!.length} | a<b: ${pA}→${swapped[pA]!.length} ${pB}→${swapped[pB]!.length}`;
    expect(loud[pA]!.length, `with A louder, A reaches MORE jacks: ${note}`)
      .toBeGreaterThan(loud[pB]!.length);
    expect(swapped[pB]!.length, `with B louder, B reaches more — THE AXIS FLIPS: ${note}`)
      .toBeGreaterThan(swapped[pA]!.length);
  }, TIMEOUT_MS);

  it('the axis that IS intrinsic is POLARITY — DIFF subtracts exactly one channel', async () => {
    // The rank the face ships, measured. Under a COMMON-MODE input (no selector
    // asymmetry to confound it) each dial enters SUM positively and exactly one
    // enters DIFF negatively — which is why `face.order` puts ATT A first.
    const rows: string[] = [];
    const signs: Record<string, { sum: number; diff: number }> = {};
    for (const p of analogLogicMathsDef.params) {
      const lo = await render({ params: { [p.id]: 0 }, drive: { a: 0.5, b: 0.5 } });
      const hi = await render({ params: { [p.id]: 1 }, drive: { a: 0.5, b: 0.5 } });
      signs[p.id] = {
        sum: Math.sign(hi.out['sum']! - lo.out['sum']!),
        diff: Math.sign(hi.out['diff']! - lo.out['diff']!),
      };
      rows.push(`${p.id}: sum ${signs[p.id]!.sum} diff ${signs[p.id]!.diff}`);
    }
    const [pA, pB] = ALM_ATT_PARAM_IDS as [string, string];
    expect(signs[pA]!.sum, `every dial enters SUM positively: ${rows.join(' | ')}`).toBe(1);
    expect(signs[pB]!.sum, `every dial enters SUM positively: ${rows.join(' | ')}`).toBe(1);
    expect(signs[pA]!.diff, `${pA} enters DIFF POSITIVELY — the rank-1 argument: ${rows.join(' | ')}`).toBe(1);
    expect(signs[pB]!.diff, `${pB} enters DIFF NEGATIVELY: ${rows.join(' | ')}`).toBe(-1);
    // …and the model's own `diff` law agrees with the rendered polarity, which
    // is what licenses the readout's sign.
    expect(Math.sign(almDiffGain([1, 0])), 'the model puts ATT A on the + side').toBe(1);
    expect(Math.sign(almDiffGain([0, 1])), 'and ATT B on the − side').toBe(-1);
    // ANCHORED TO `face.order`: the first-ranked key must be the additive one.
    expect(analogLogicMathsDef.face!.order![0], 'face.order ranks the additive dial first').toBe(pA);
  }, TIMEOUT_MS);

  it('SWAPPING the two dials moves DIFF and nothing else — the symmetry claim', async () => {
    // The structural fact the face-model matrix asserts on the printed strings,
    // measured here at the jacks: SUM, PRODUCT, MIN and MAX are symmetric in A
    // and B; only DIFF is antisymmetric.
    const x = await render({ params: { attA: 1, attB: 0.5 }, drive: { a: 0.6, b: 0.6 } });
    const y = await render({ params: { attA: 0.5, attB: 1 }, drive: { a: 0.6, b: 0.6 } });
    const moved = OUT_IDS.filter((id) => Math.abs(x.out[id]! - y.out[id]!) > 1e-7);
    expect(moved, 'exactly DIFF notices a dial swap under a common-mode input').toEqual(['diff']);
  }, TIMEOUT_MS);
});

// ── M8 — the readouts, at the jack ──────────────────────────────────────────

describe('ALM audit / M8 — every faceplate readout is measured at the JACK', () => {
  it('all four laws agree with the rendered module over a table of dial settings', async () => {
    // The join the faceplate needs and nothing else makes: the readouts print
    // float64 arithmetic while the player hears a float32 worklet. `peak` is a
    // WORST CASE rather than a settled value, so it is checked by driving the
    // pair that attains it.
    const rows: string[] = [];
    for (const [attA, attB] of [
      [1, 1],
      [1, -1],
      [0.5, 0.5],
      [0.8, 0.2],
      [-0.4, 0.9],
      [0, 1],
    ] as const) {
      const a = [attA, attB];
      const common = await render({ params: { attA, attB }, drive: { a: ALM_PROBE, b: ALM_PROBE } });
      const anti = await render({ params: { attA, attB }, drive: { a: Math.sign(attA) || 1, b: -(Math.sign(attB) || 1) } });
      rows.push(`att=${attA}/${attB} sum=${common.out['sum']!.toPrecision(7)} diff=${common.out['diff']!.toPrecision(7)} ring=${common.out['product']!.toPrecision(7)} peak=${anti.out['diff']!.toPrecision(7)}`);
      expect(common.out['sum']!, `\`sum\` law at the jack: ${rows.at(-1)}`)
        .toBeCloseTo(almSumGain(a) * ALM_PROBE, 6);
      expect(common.out['diff']!, `\`diff\` law at the jack: ${rows.at(-1)}`)
        .toBeCloseTo(almDiffGain(a) * ALM_PROBE, 6);
      expect(common.out['product']!, `\`ring\` law at the jack: ${rows.at(-1)}`)
        .toBeCloseTo(almRingGain(a) * ALM_PROBE, 6);
      expect(Math.abs(anti.out['diff']!), `\`peak\` law at the jack: ${rows.at(-1)}`)
        .toBeCloseTo(almPeak(a) * ALM_PROBE, 5);
    }
  }, TIMEOUT_MS);
});
