// packages/web/src/lib/audio/modules/twotracks-rate-cv.test.ts
//
// TWOTRACKS varispeed CV — one jack per reel onto the RATE control.
//
// WHAT THIS FILE PROVES, and why each leg exists.
//
// The ask was "CV in for both tape decks' rate/speed setting". The trap is
// that a CV jack can be declared, render a handle, materialise an edge, pass
// every registry sweep — and still move the control across a useless sliver of
// its range, or across none of it. That is not hypothetical: `wavetableVco`'s
// WAVE POSITION omits `cvScale` where its four siblings declare it, and the
// measured consequence is that half a bipolar LFO is BIT-EXACTLY dead
// (maxAbsDiff 0.000e+0). "The port exists" is the assertion that misses it.
//
// So the gate here is the END-TO-END chain, and it is deliberately built out of
// the REAL objects at every link rather than a re-typed model of them:
//
//   the def's `cvScale` hint
//     → `buildCvCurve` (the ACTUAL WaveShaperNode LUT `attachCvScale` installs
//        in the audio graph — not `scaleCv`, the pure function behind it, so a
//        divergence between the curve and the math is in scope)
//     → the delta Web Audio sums into the a-rate AudioParam
//     → the REAL `TwoTracksProcessor` from packages/dsp, captured through the
//        registerProcessor shim
//     → the tape speed MEASURED off the rendered audio.
//
// The measurement is a direct one, not a proxy. We load each reel's ring buffer
// with a linear RAMP and play it: `readInterp` is exact on a ramp, the cursor
// advances by `rate` per sample, so the rendered output's per-sample slope is
// `rate × rampSlope` — divide it out and you have read the tape speed, with its
// SIGN, straight off the audio. Nothing about that metric is invariant to the
// thing under test: a dead CV reads 1.000 (the knob), a half-scaled CV reads
// half, and reverse reads negative. It is negative-controlled on every run in
// both directions (§4), which is what makes a green run mean something.
//
// WHAT IT IS STRUCTURALLY UNABLE TO SEE. It reads the def, the curve builder,
// and the worklet. It does NOT open `AudioEngine.addEdge`, so it cannot see the
// engine declining to consult `cvScale` at all; `getCvScaleForTarget`'s
// preconditions (a cv-typed port carrying BOTH `paramTarget` and `cvScale`, and
// a `paramTarget` naming a real param) are asserted in §1 as the closest
// standing proxy, and `cv-scale-registry.test.ts` holds the registry-wide line.
// It also cannot see the CARD: `TwotracksCard.svelte`'s handle rendering is the
// per-module-per-port sweep's job.

import { describe, it, expect, beforeAll } from 'vitest';
import { twotracksDef, cardParamToWorkletParam } from './twotracks';
import { buildCvCurve } from '$lib/audio/cv-scale';
import type { CvScaleHint, ParamDef, PortDef } from '$lib/graph/types';

const SR = 48000;
const BLOCK = 128;
/** Must match TWOTRACKS_MAX_SAMPLES in the worklet — `seek` is a fraction of
 *  the WHOLE tape, not of the recorded region, so the test has to speak the
 *  same units the DSP does. */
const TAPE_LEN = 960_000;

// The two reels, as a table — every behavioural leg below runs for BOTH, so
// "we wired reel A and forgot reel B" cannot pass.
const REELS = [
  { reel: 'a' as const, port: 'rate_cv_a', param: 'rate_a', worklet: 'rate',   ab: 0 },
  { reel: 'b' as const, port: 'rate_cv_b', param: 'rate_b', worklet: 'rate_b', ab: 1 },
];

function portOf(id: string): PortDef {
  const p = twotracksDef.inputs.find((x) => x.id === id);
  if (!p) throw new Error(`twotracks declares no input port "${id}"`);
  return p;
}
function paramOf(id: string): ParamDef {
  const p = twotracksDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`twotracks declares no param "${id}"`);
  return p;
}

/**
 * The EFFECTIVE param value a CV sample produces, read out of the REAL
 * WaveShaper LUT the engine installs — `curve[i] + knob`, exactly as Web Audio
 * sums the shaper's output into the AudioParam's intrinsic value.
 *
 * Going through the curve rather than `scaleCv` is the point: the curve is what
 * actually processes audio, and it is sampled at 4096 points, so this also
 * exercises the index→cv mapping that a pure-math assertion would skip.
 */
function effectiveViaCurve(cv: number, knob: number, p: ParamDef, hint: CvScaleHint): number {
  const curve = buildCvCurve(p.min, p.max, knob, hint);
  const i = Math.round(((cv + 1) / 2) * (curve.length - 1));
  return (curve[i] as number) + knob;
}

// ───────────────────────── the real worklet ─────────────────────────

type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
};
type ProcCtor = new () => ProcInstance;
type Descriptor = { name: string; defaultValue: number; minValue: number; maxValue: number };

let Proc: ProcCtor;
let descriptors: Descriptor[];

beforeAll(async () => {
  const g = globalThis as unknown as {
    sampleRate?: number;
    AudioWorkletProcessor?: unknown;
    registerProcessor?: (n: string, c: ProcCtor) => void;
  };
  g.sampleRate = SR;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown, postMessage: (): void => {} };
  };
  let captured: ProcCtor | null = null;
  const prev = g.registerProcessor;
  g.registerProcessor = (_n, ctor) => { captured = ctor; };
  // Relative path into the DSP source — a worktree may not have the workspace
  // package symlinked under node_modules (the cube / worklet-params pattern).
  await import('../../../../../dsp/src/twotracks');
  g.registerProcessor = prev;
  if (!captured) throw new Error('twotracks processor did not register');
  Proc = captured;
  descriptors = (captured as unknown as { parameterDescriptors: Descriptor[] }).parameterDescriptors;
});

/** Every declared worklet param at its default, as k-rate length-1 arrays. */
function baseParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const d of descriptors) out[d.name] = new Float32Array([over[d.name] ?? d.defaultValue]);
  return out;
}

/**
 * Load a reel with a linear ramp, park the head mid-tape, roll it at `rate`
 * (supplied as an a-rate block, which is how a patched CV arrives), and return
 * the rendered block for that reel.
 *
 * `rate` is fed as a full-length a-rate array on purpose: the worklet reads it
 * per-sample (`av(pRate, i, 1)`), and a k-rate length-1 array would exercise a
 * different branch than a real audio-rate CV cable does.
 */
function renderReel(reel: 'a' | 'b', ab: number, rate: number, tapeLen = 4000): {
  out: Float32Array;
  rampSlope: number;
} {
  const proc = new Proc();
  // Ramp over the recorded region: bufL[k] = k / tapeLen. readInterp is linear,
  // so a linear ramp reads back EXACTLY — the output slope is pure tape speed
  // with no interpolation error folded in.
  const ramp = new Float32Array(tapeLen);
  for (let k = 0; k < tapeLen; k++) ramp[k] = k / tapeLen;
  const rampSlope = 1 / tapeLen;

  const send = (m: Record<string, unknown>): void => { proc.port.onmessage?.({ data: m }); };
  send({
    type: 'load-tape', reel, bufLen: tapeLen,
    bufL: ramp.slice(0).buffer, bufR: ramp.slice(0).buffer,
  });
  send({ type: 'transport', reel, action: 'play' }); // idle → play (seeks to 0)
  // Park mid-tape so BOTH directions have room to run for a full block without
  // hitting a loop boundary (rate −3 × 128 samples = 384 tape samples).
  send({ type: 'seek', reel, pos: (tapeLen / 2) / TAPE_LEN });

  const params = baseParams({ ab });
  params['rate'] = new Float32Array(BLOCK).fill(reel === 'a' ? rate : 1);
  params['rate_b'] = new Float32Array(BLOCK).fill(reel === 'b' ? rate : 1);

  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  // Four mono inputs (A-L, A-R, B-L, B-R), all silent — this is playback.
  const inputs: Float32Array[][] = [
    [new Float32Array(BLOCK)], [new Float32Array(BLOCK)],
    [new Float32Array(BLOCK)], [new Float32Array(BLOCK)],
  ];
  proc.process(inputs, [[outL, outR]], params);
  return { out: outL, rampSlope };
}

/**
 * The measured tape speed, in the same units as the RATE control, recovered
 * from the rendered audio: least-squares slope of the output against sample
 * index, divided by the ramp's slope.
 *
 * Least-squares (not a first/last difference) so a single boundary sample can't
 * dominate the reading.
 */
function measuredRate(out: Float32Array, rampSlope: number): number {
  const n = out.length;
  const meanX = (n - 1) / 2;
  let meanY = 0;
  for (let i = 0; i < n; i++) meanY += out[i] as number;
  meanY /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    num += dx * ((out[i] as number) - meanY);
    den += dx * dx;
  }
  return num / den / rampSlope;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] as number) - (b[i] as number)));
  return m;
}

// ─────────────────────────────────────────────────────────────────────────
// 1) The DECLARATION — both reels, complete, and pointing somewhere real.
// ─────────────────────────────────────────────────────────────────────────

describe('twotracks RATE CV: the declaration', () => {
  it.each(REELS)('reel $reel declares $port as a cv input scaled onto $param', ({ port, param }) => {
    const p = portOf(port);
    expect(p.type, `${port} must be a cv jack, not audio/gate`).toBe('cv');
    // These three are exactly what AudioEngine.getCvScaleForTarget requires
    // before it will interpose the scaling chain. Any one missing and the edge
    // silently falls back to raw sum-into-AudioParam — the wavetableVco shape.
    expect(p.paramTarget, `${port} must name the param it drives`).toBe(param);
    expect(p.cvScale, `${port} without cvScale is a passthrough by omission`).toBeDefined();
    expect(p.cvScale?.mode).toBe('linear');
    // ...and the paramTarget must resolve, or the engine bails at the lookup.
    expect(twotracksDef.params.some((x) => x.id === param)).toBe(true);
  });

  it.each(REELS)('reel $reel: RATE is the bipolar ±3 varispeed control', ({ param }) => {
    const p = paramOf(param);
    // Pinned here because the full-range proof below is stated in these units;
    // if the contract widens, this test must be re-reasoned, not silently
    // rescaled. (contract-lock.txt pins the same numbers independently.)
    expect([p.min, p.max, p.defaultValue, p.curve]).toEqual([-3, 3, 1, 'linear']);
  });

  it.each(REELS)(
    'reel $reel: the jack lands on the a-rate worklet param the RATE knob writes',
    ({ param, worklet }) => {
      // The `echoes_b` failure this module already shipped once: a name the
      // worklet does not declare makes `params.get()` undefined and the
      // optional-chained write a permanent silent no-op. A CV jack pointed at
      // such a name would render, patch, and do nothing.
      expect(cardParamToWorkletParam(param)).toBe(worklet);
      const d = descriptors.find((x) => x.name === worklet);
      expect(d, `the worklet must declare "${worklet}"`).toBeDefined();
      // a-rate is load-bearing: a k-rate param would quantise the CV to one
      // value per 128-sample block, which is not varispeed, it is a stepped
      // sample-and-hold. The descriptor list is where that is decided.
      const raw = descriptors as unknown as Array<{ name: string; automationRate?: string }>;
      expect(raw.find((x) => x.name === worklet)?.automationRate).toBe('a-rate');
      expect([d!.minValue, d!.maxValue]).toEqual([-3, 3]);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 2) FULL RANGE — a ±1 CV reaches BOTH ends, per reel, through the real LUT.
//
// The standard's semantic (cv-scale.ts) is "±1 sweeps the param's full natural
// range, CENTRED on the user-set knob". So the full-span claim is stated at the
// knob position where centring makes it meaningful — RATE 0, the exact centre
// of −3..+3, and the natural setting for a CV-driven reel (tape stopped, CV
// supplies all the motion). The knob-independent half of the claim — that ±1
// always COMMANDS a full 6-unit swing wherever the knob sits, the param's own
// bounds then pinning it, which is the Eurorack behaviour — is asserted
// separately across the whole knob range.
// ─────────────────────────────────────────────────────────────────────────

describe('twotracks RATE CV: a ±1 CV reaches both ends of the declared range', () => {
  it.each(REELS)('reel $reel: cv −1 → exactly min, cv +1 → exactly max', ({ port, param }) => {
    const p = paramOf(param);
    const hint = portOf(port).cvScale!;
    const atMin = effectiveViaCurve(-1, 0, p, hint);
    const atMax = effectiveViaCurve(+1, 0, p, hint);
    expect(atMin, `cv=−1 at knob 0 must reach RATE min (${p.min}), got ${atMin}`).toBeCloseTo(p.min, 6);
    expect(atMax, `cv=+1 at knob 0 must reach RATE max (${p.max}), got ${atMax}`).toBeCloseTo(p.max, 6);
    // The span reached is the WHOLE declared span — no sliver.
    expect(atMax - atMin).toBeCloseTo(p.max - p.min, 6);
  });

  it.each(REELS)(
    'reel $reel: ±1 commands a full-span swing from ANY knob position (bounds then pin)',
    ({ port, param }) => {
      const p = paramOf(param);
      const hint = portOf(port).cvScale!;
      const span = p.max - p.min;
      // Sample the knob at irregular, non-symmetric offsets — including the
      // default — so a mapping that happened to be right only at the centre
      // cannot pass.
      for (const knob of [p.min, -2.1, -0.7, 0, 0.4, 1 /* default */, 2.3, p.max]) {
        const lo = effectiveViaCurve(-1, knob, p, hint);
        const hi = effectiveViaCurve(+1, knob, p, hint);
        // ±1 COMMANDS knob ∓ half-span (a full 6-unit swing); the param's own
        // bounds then pin whatever falls outside. That is the whole law.
        expect(lo, `knob ${knob}: cv=−1`).toBeCloseTo(Math.max(p.min, knob - span / 2), 6);
        expect(hi, `knob ${knob}: cv=+1`).toBeCloseTo(Math.min(p.max, knob + span / 2), 6);
        // Consequence worth stating on its own: wherever the knob sits, at
        // least one END of the range is reached and the reachable window is
        // never narrower than half the control. Under `passthrough` (§4) this
        // is 1/3 of the control and reaches neither end.
        expect(hi - lo, `knob ${knob}: reachable window`).toBeGreaterThanOrEqual(span / 2 - 1e-6);
        // (Compared with a tolerance, not `===`: the curve is a Float32Array,
        // so an endpoint that lands ON a bound still differs from it in the
        // last bit or two.)
        const EPS = 1e-5;
        expect(
          Math.abs(lo - p.min) < EPS || Math.abs(hi - p.max) < EPS,
          `knob ${knob}: an end must be reachable, got [${lo}, ${hi}]`,
        ).toBe(true);
      }
      // From the DEFAULT knob (1 = normal play speed) a full-scale LFO still
      // reaches maximum fast-forward AND crosses into reverse — the two things
      // a user actually asks a rate CV for.
      expect(effectiveViaCurve(+1, p.defaultValue, p, hint)).toBeCloseTo(p.max, 6);
      expect(effectiveViaCurve(-1, p.defaultValue, p, hint)).toBeLessThan(0);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 3) THE AUDIO — the CV actually moves the tape, both reels, both ends.
//
// Everything above is about numbers on a curve. This is the leg that reads the
// speed off the rendered samples through the real DSP.
// ─────────────────────────────────────────────────────────────────────────

describe('twotracks RATE CV: the rendered tape speed follows the CV', () => {
  it.each(REELS)('reel $reel: the measurement instrument reads a known rate back', ({ reel, ab }) => {
    // The instrument, calibrated against rates fed in directly. If this row is
    // wrong, every number below is meaningless — so it runs FIRST and on every
    // run, rather than being a one-time authoring-time check.
    for (const rate of [-3, -1, 0.5, 1, 2, 3]) {
      const { out, rampSlope } = renderReel(reel, ab, rate);
      expect(measuredRate(out, rampSlope), `fed rate=${rate}`).toBeCloseTo(rate, 2);
    }
  });

  it.each(REELS)('reel $reel: cv −1 runs the tape at full REVERSE (−3×)', ({ reel, ab, port, param }) => {
    const rate = effectiveViaCurve(-1, 0, paramOf(param), portOf(port).cvScale!);
    const { out, rampSlope } = renderReel(reel, ab, rate);
    const m = measuredRate(out, rampSlope);
    expect(m, `cv=−1 must render the tape at ${paramOf(param).min}×, measured ${m.toFixed(4)}×`)
      .toBeCloseTo(paramOf(param).min, 2);
    expect(m, 'a reverse rate must render a NEGATIVE slope — direction, not just magnitude')
      .toBeLessThan(0);
  });

  it.each(REELS)('reel $reel: cv +1 runs the tape at full FORWARD (+3×)', ({ reel, ab, port, param }) => {
    const rate = effectiveViaCurve(+1, 0, paramOf(param), portOf(port).cvScale!);
    const { out, rampSlope } = renderReel(reel, ab, rate);
    const m = measuredRate(out, rampSlope);
    expect(m, `cv=+1 must render the tape at ${paramOf(param).max}×, measured ${m.toFixed(4)}×`)
      .toBeCloseTo(paramOf(param).max, 2);
  });

  it.each(REELS)('reel $reel: the CV audibly changes the output, not just a number', ({ reel, ab, port, param }) => {
    const p = paramOf(param);
    const hint = portOf(port).cvScale!;
    const unpatched = renderReel(reel, ab, p.defaultValue); // knob 1, no cable
    for (const cv of [-1, -0.5, 0.5, 1]) {
      const { out } = renderReel(reel, ab, effectiveViaCurve(cv, p.defaultValue, p, hint));
      const d = maxAbsDiff(out, unpatched.out);
      // The wavetableVco tell was maxAbsDiff 0.000e+0 over half the CV's
      // travel. Assert a real, non-token difference on EVERY sampled cv.
      expect(d, `cv=${cv} left the rendered audio unchanged (maxAbsDiff ${d.toExponential(3)})`)
        .toBeGreaterThan(1e-4);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4) NEGATIVE CONTROLS — both directions, on every run.
//
// A green suite is only evidence if the assertions can go red. These two force
// the failure modes and assert the checks above WOULD have caught them, so the
// instrument is validated continuously rather than once at authoring time.
// ─────────────────────────────────────────────────────────────────────────

describe('twotracks RATE CV: negative controls', () => {
  it.each(REELS)(
    'reel $reel: DROPPING cvScale (passthrough) fails the full-range check',
    ({ reel, ab, param }) => {
      const p = paramOf(param);
      // Exactly the wavetableVco defect: a cv port with a paramTarget and no
      // cvScale. The engine's documented fallback for that is `passthrough` —
      // raw sum-into-AudioParam.
      const naked: CvScaleHint = { mode: 'passthrough' };
      const lo = effectiveViaCurve(-1, 0, p, naked);
      const hi = effectiveViaCurve(+1, 0, p, naked);
      // The claim §2 makes is FALSE here — which is the point.
      expect(lo).not.toBeCloseTo(p.min, 6);
      expect(hi).not.toBeCloseTo(p.max, 6);
      expect(lo).toBeCloseTo(-1, 6);
      expect(hi).toBeCloseTo(+1, 6);
      // Quantified: an unscaled full-scale LFO commands 2 of the 6 available
      // units — 33.3 % of the control — and from the DEFAULT knob it reaches
      // NEITHER end (0..2 out of −3..+3).
      expect((hi - lo) / (p.max - p.min)).toBeCloseTo(1 / 3, 6);
      expect(effectiveViaCurve(+1, p.defaultValue, p, naked)).toBeLessThan(p.max);
      expect(effectiveViaCurve(-1, p.defaultValue, p, naked)).toBeGreaterThan(p.min);
      // And it is audible in the DSP too. From the default knob (1), the
      // unscaled LFO's most-negative excursion lands on rate 0 EXACTLY — the
      // tape stops and that is as far as it goes. The entire reverse half of
      // the control (−3..0) is unreachable, so "play it backwards", the whole
      // point of a bipolar varispeed CV, cannot be patched at all.
      const { out, rampSlope } = renderReel(reel, ab, effectiveViaCurve(-1, p.defaultValue, p, naked));
      const m = measuredRate(out, rampSlope);
      expect(m, 'unscaled cv=−1 stops the tape rather than reversing it').toBeCloseTo(0, 3);
      expect(m, 'unscaled cv=−1 never reaches a NEGATIVE (reverse) rate').not.toBeLessThan(0);
    },
  );

  it.each(REELS)(
    'reel $reel: UNPATCHING the CV fails the "the CV moved it" check',
    ({ reel, ab, param }) => {
      const p = paramOf(param);
      // No cable = no summed delta = the AudioParam holds the knob alone. The
      // §3 audibility assertion must NOT pass in this state, or it was reading
      // something other than the CV.
      const a = renderReel(reel, ab, p.defaultValue);
      const b = renderReel(reel, ab, p.defaultValue);
      expect(maxAbsDiff(a.out, b.out), 'with no CV the render is bit-identical').toBe(0);
      expect(measuredRate(a.out, a.rampSlope), 'with no CV the tape runs at the knob')
        .toBeCloseTo(p.defaultValue, 2);
    },
  );

  it.each(REELS)('reel $reel: the two jacks are not cross-wired', ({ reel, ab }) => {
    // Driving THIS reel's rate must not move the OTHER reel, and vice versa —
    // the copy-paste failure that would make one jack drive both decks. The A/B
    // crossfader is parked so only the reel under test is audible; if the CV
    // reached the silent reel instead, the measured speed would stay at 1.
    const fast = renderReel(reel, ab, 3);
    const still = renderReel(reel, ab, 1);
    expect(measuredRate(fast.out, fast.rampSlope)).toBeCloseTo(3, 2);
    expect(measuredRate(still.out, still.rampSlope)).toBeCloseTo(1, 2);
  });
});
