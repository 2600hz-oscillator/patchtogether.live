// art/scenarios/moog923/face-audit.test.ts
//
// THE ADVERSARIAL AUDIT FOR MOOG923, and the permanent anchor under its
// faceplate (queue Q20).
//
// Everything here is measured against the REAL `moog923Def.factory` under
// node-web-audio-api's OfflineAudioContext at 48 kHz — the shipping biquads and
// the shipping noise tables, reached through the def's own factory, never a
// pure-TS mirror.
//
// WHAT THIS FILE IS FOR, beyond regression. `moog923-face-model.ts` is a stack
// of closed forms, and a unit test over closed forms can only ever prove they
// are self-consistent. Five of them are claims about a FILTER:
//
//   1. THE DECLARED CORNER IS NOT A CORNER. `moog923.ts` creates two
//      `BiquadFilterNode`s and never assigns `Q`; for lowpass/highpass the Web
//      Audio API reads `Q` in DECIBELS and defaults it to 1. So the frequency
//      `cutoffToHz` returns is a +1.00 dB point. Asserted at the jack, with the
//      NEGATIVE control that it is nowhere near −3.01 dB — because "the filter
//      turns over at the knob's frequency" is what the module's docs said and
//      what a relabelled readout would print.
//   2. THE REAL −3 dB POINT is 1.3293x / 0.7520x that frequency, bisected on
//      the real filter and compared to the model's analog closed form. The
//      residual is the bilinear warp and its DIRECTION is pinned, not just its
//      magnitude (the noise-face-model discipline).
//   3. THE HUMP IS REAL: +1.96 dB about 0.36 oct inside each passband, swept on
//      the real filter.
//   4. THE TWO HALVES SHARE NO SIGNAL PATH — bit-exactly, in both directions.
//      This is what makes each half the other's negative control on the face.
//   5. THE NOISE TAPS ARE NOT LEVEL-MATCHED, re-derived from the shipping
//      generators, with pink's known steady-state deficit pinned as a direction.
//
// DETERMINISM IS MEASURED, NOT ASSUMED (#1680) — and here it SPLITS, which is
// itself a finding: `lp`/`hp` are bit-identical across spawns and `white`/`pink`
// are not, because the tables are drawn per spawn. That is precisely why the
// face's tap readouts are closed forms rather than a trace (the `noise`
// precedent: this module is free-running, so a trace would never baseline).

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { CUTOFF_MAX_HZ, CUTOFF_MIN_HZ, cutoffToHz, moog923Def } from '$lib/audio/modules/moog923';
import { noiseGenerators } from '$lib/audio/modules/noise';
// The generators' OWN PRNG, so a pinned table is pinned by the same arithmetic
// the shipping code would use if the factory passed a seed (it does not).
import { mulberry32 } from '../../../packages/dsp/src/lib/noise-dsp';
import { NOISE_TAP_RMS } from '$lib/ui/modules/noise-face-model';
import {
  moog923CornerGainDb,
  moog923FaceParams,
  moog923MinusThreeDbRatio,
  moog923PeakGainDb,
  moog923PeakRatio,
  moog923SplitOct,
} from '$lib/ui/modules/moog923-face-model';
import type { ModuleNode } from '$lib/graph/types';

const SR = 48000;
/** Every declared output, in declaration order. DERIVED — no port list here. */
const OUT_IDS: readonly string[] = moog923Def.outputs.map((o) => o.id);
/** The def's shipped spawn defaults. */
const DEFAULTS: Record<string, number> = Object.fromEntries(
  moog923Def.params.map((p) => [p.id, p.defaultValue]),
);
/** Half the render is discarded so a sine's filter transient cannot leak into
 *  an RMS. Stated in SAMPLES, and every window below is expressed off it. */
const SETTLE_FRACTION = 0.5;

interface Render {
  out: Record<string, Float32Array>;
  readParam: (id: string) => number | undefined;
}

/** Drive the SHIPPING factory. `sineHz` patches an oscillator into `audio`;
 *  omitting it leaves the input genuinely unpatched, which is the state a
 *  fresh module is in and a state this file asserts about. */
async function render(opts: {
  params?: Record<string, number>;
  sineHz?: number;
  amp?: number;
  secs?: number;
  /**
   * PIN THE NOISE TABLES. The factory builds both tables inside `factory()`
   * from `noiseGenerators`, which fall back to `Math.random` when handed no
   * seed — and the factory hands them none. Installing a seeded PRNG for the
   * duration of that call makes the two tables bit-identical run to run
   * WITHOUT touching the shipping code path: the generators still run their
   * real algorithm, they just draw from a pinned uniform stream. This is the
   * `PROFILE_NOISE_SEED` discipline the ART drivers already use ("profiles
   * never touch Math.random"), applied to a factory that seeds itself.
   */
  seed?: number;
}): Promise<Render> {
  const secs = opts.secs ?? 0.5;
  const ctx = new OfflineAudioContext({
    numberOfChannels: OUT_IDS.length,
    length: Math.round(SR * secs),
    sampleRate: SR,
  });
  const node = {
    id: 'face-audit',
    type: moog923Def.type,
    position: { x: 0, y: 0 },
    params: { ...DEFAULTS, ...(opts.params ?? {}) },
  } as unknown as ModuleNode;
  const realRandom = Math.random;
  if (opts.seed !== undefined) Math.random = mulberry32(opts.seed);
  let handle;
  try {
    handle = await moog923Def.factory(ctx as unknown as AudioContext, node);
  } finally {
    Math.random = realRandom;
  }

  if (opts.sineHz !== undefined) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = opts.sineHz;
    const g = ctx.createGain();
    g.gain.value = opts.amp ?? 0.5;
    osc.connect(g);
    const term = handle.inputs.get('audio')!;
    g.connect(term.node as never, 0, term.input);
    osc.start();
  }

  const merger = ctx.createChannelMerger(OUT_IDS.length);
  OUT_IDS.forEach((id, i) => {
    const o = handle.outputs.get(id)!;
    (o.node as never as AudioNode).connect(merger as never, o.output, i);
  });
  merger.connect(ctx.destination);
  const buf = await ctx.startRendering();

  const out: Record<string, Float32Array> = {};
  OUT_IDS.forEach((id, i) => {
    out[id] = buf.getChannelData(i) as unknown as Float32Array;
  });
  return { out, readParam: (id) => handle.readParam?.(id) };
}

function rms(a: Float32Array, fromFraction = 0): number {
  const from = Math.round(a.length * fromFraction);
  let s = 0;
  for (let i = from; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / (a.length - from));
}
const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : Number.NEGATIVE_INFINITY);
const bitIdentical = (a: Float32Array, b: Float32Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** The measured gain of a filter tap at `hz`, in dB relative to the driving
 *  sine. The reference is NAMED in the assertion messages that use it: a dB
 *  figure with an unstated denominator is not a measurement. */
async function tapGainDb(tap: 'lp' | 'hp', hz: number, knob: number): Promise<number> {
  const amp = 0.5;
  const r = await render({
    sineHz: hz,
    amp,
    params: { level: 0, lpCutoff: knob, hpCutoff: knob },
  });
  return db(rms(r.out[tap], SETTLE_FRACTION) / (amp / Math.SQRT2));
}

/** Bisect for the frequency where `tap` reads −3.0103 dB, as a RATIO to the
 *  declared corner. 18 halvings of a log bracket ⇒ better than 0.01 %. */
async function measuredMinusThreeDbRatio(tap: 'lp' | 'hp', knob: number): Promise<number> {
  let lo = tap === 'lp' ? 1 : 0.05;
  let hi = tap === 'lp' ? 20 : 1;
  const f0 = cutoffToHz(knob);
  for (let i = 0; i < 18; i++) {
    const mid = Math.sqrt(lo * hi);
    const g = await tapGainDb(tap, f0 * mid, knob);
    const below = g <= -3.0103;
    if (tap === 'lp') { if (below) hi = mid; else lo = mid; }
    else { if (below) lo = mid; else hi = mid; }
  }
  return Math.sqrt(lo * hi);
}

// ── M0 · DETERMINISM, and the SPLIT in it that shapes the whole face ────────

describe('M0 · determinism splits down the middle of this module', () => {
  it('lp/hp are BIT-IDENTICAL across spawns; white/pink are NOT', async () => {
    const a = await render({ sineHz: 300, secs: 0.2 });
    const b = await render({ sineHz: 300, secs: 0.2 });

    expect(bitIdentical(a.out.lp, b.out.lp), 'lp differs across two spawns').toBe(true);
    expect(bitIdentical(a.out.hp, b.out.hp), 'hp differs across two spawns').toBe(true);

    // ⚠ THE POSITIVE CONTROL ON THE SAME PROBE. If `bitIdentical` were broken it
    // would report `true` for everything, and the two legs above would be
    // vacuous. The noise taps are drawn per spawn, so they MUST differ.
    expect(
      bitIdentical(a.out.white, b.out.white),
      'white is bit-identical across spawns — the tables are no longer per-spawn, ' +
        'or the comparator is dead',
    ).toBe(false);
    expect(bitIdentical(a.out.pink, b.out.pink), 'pink is bit-identical across spawns').toBe(false);
  });

  it('with `audio` UNPATCHED both filter taps are bit-exactly silent', async () => {
    // The state a fresh module is in: half its jacks carry nothing at all. This
    // is why the face ranks LEVEL first and puts the filter numbers in the
    // sidebar rather than the hero.
    const r = await render({ secs: 0.2 });
    expect(rms(r.out.lp), 'lp with nothing patched').toBe(0);
    expect(rms(r.out.hp), 'hp with nothing patched').toBe(0);
    expect(rms(r.out.white), 'white with nothing patched (it free-runs)').toBeGreaterThan(0);
  });
});

// ── M1 · THE TWO HALVES SHARE NO SIGNAL PATH ────────────────────────────────

describe('M1 · the noise half and the filter half are independent, bit-exactly', () => {
  it('LEVEL moves NEITHER filter tap — identical samples at LEVEL 1 and LEVEL 0', async () => {
    const hot = await render({ sineHz: 200, params: { level: 1 }, secs: 0.2 });
    const off = await render({ sineHz: 200, params: { level: 0 }, secs: 0.2 });
    expect(bitIdentical(hot.out.lp, off.out.lp), 'lp moved with LEVEL').toBe(true);
    expect(bitIdentical(hot.out.hp, off.out.hp), 'hp moved with LEVEL').toBe(true);
    // POSITIVE CONTROL: the same LEVEL change is enormous on the noise taps, so
    // the invariance above is not "nothing changed anywhere".
    expect(rms(hot.out.white)).toBeGreaterThan(0.4);
    expect(rms(off.out.white)).toBe(0);
  });

  it('NEITHER cutoff moves the noise taps beyond their own spawn scatter', async () => {
    // The taps are redrawn per spawn, so this is a statistical leg and it is
    // instrumented as one: establish the scatter FIRST from repeat spawns at a
    // FIXED setting, then show the cutoff sweep stays inside it while a LEVEL
    // change of comparable size lands far outside.
    const at = async (over: Record<string, number>) =>
      db(rms((await render({ params: { level: 1, ...over }, secs: 2 })).out.white));

    const fixed = [await at({}), await at({}), await at({}), await at({})];
    const scatter = Math.max(...fixed) - Math.min(...fixed);
    expect(scatter, 'white spawn scatter at a fixed LEVEL, dB').toBeLessThan(0.2);

    const swept = [
      await at({ lpCutoff: 0 }),
      await at({ lpCutoff: 1 }),
      await at({ hpCutoff: 0 }),
      await at({ hpCutoff: 1 }),
    ];
    const mid = (Math.max(...fixed) + Math.min(...fixed)) / 2;
    for (const v of swept) {
      expect(Math.abs(v - mid), 'white moved with a CUTOFF, dB from the fixed-setting mean').
        toBeLessThan(0.25);
    }

    // POSITIVE CONTROL on the same instrument: a real level change IS seen.
    const halved = await at({ level: 0.5 });
    expect(mid - halved, 'a x0.5 LEVEL, dB — the probe can see a change').toBeCloseTo(6.02, 1);
  });
});

// ── M2 · THE Q FINDING, measured at the jack ────────────────────────────────

describe('M2 · the declared corner is a +1 dB point, not a −3 dB point', () => {
  it('every knob position reads the model gain AT its own declared corner', async () => {
    // Sampled AT the declared threshold, not around it (#1750), and at both
    // rails as well as the interior.
    for (const knob of [0, 0.25, 0.5, 0.75, 1]) {
      for (const tap of ['lp', 'hp'] as const) {
        const g = await tapGainDb(tap, cutoffToHz(knob), knob);
        expect(
          g,
          `${tap} at its declared corner (knob ${knob} = ${cutoffToHz(knob).toFixed(1)} Hz), ` +
            `dB re the driving sine`,
        ).toBeCloseTo(moog923CornerGainDb(), 1);
        // ⚠ THE NEGATIVE CONTROL, and the reason this face exists: the module
        // documented that frequency as "the corner", which reads as −3 dB.
        expect(
          Math.abs(g - -3.0103),
          `${tap} at knob ${knob} is within 1 dB of −3.01 dB — the "corner" reading would ` +
            `then be right and the face's lp/hp readouts would be a relabelled knob`,
        ).toBeGreaterThan(1);
      }
    }
  });

  it('the real −3 dB point matches the model, with the warp residual pinned', async () => {
    // ⚠ THE RESIDUAL HAS A DIRECTION AND IT IS NOT THE OBVIOUS ONE. The model is
    // the ANALOG prototype; the shipping filter is its bilinear transform,
    // pre-warped at the declared corner. Bilinear COMPRESSES the frequency axis
    // away from the pre-warp point, so BOTH taps' −3 dB points are pulled TOWARD
    // the declared corner — `lp`'s down, `hp`'s up — and by more as the corner
    // climbs toward Nyquist. Stating it as "toward the corner" is what makes it
    // one fact about both taps instead of two signs to get right separately.
    // (An earlier draft of this leg asserted `lp` below / `hp` above and was
    // WRONG on `lp` at knob 0.25 by 1.6e-4 — the measurement corrected it, which
    // is the only reason a direction belongs in an assertion at all.)
    const KNOBS = [0.25, 0.5, 0.75] as const;
    const spread: Record<'lp' | 'hp', number[]> = { lp: [], hp: [] };

    for (const knob of KNOBS) {
      for (const tap of ['lp', 'hp'] as const) {
        const measured = await measuredMinusThreeDbRatio(tap, knob);
        const model = moog923MinusThreeDbRatio(tap);
        expect(
          measured,
          `${tap} −3 dB ratio at knob ${knob} (measured on the shipping biquad)`,
        ).toBeCloseTo(model, 1);
        expect(
          Math.abs(measured / model - 1),
          `${tap} warp residual at knob ${knob}`,
        ).toBeLessThan(0.03);
        // Distance of the measured point from the corner, in octaves — the
        // quantity the warp acts on, and the same number for both taps.
        spread[tap].push(Math.abs(Math.log2(measured)));
      }
    }

    for (const tap of ['lp', 'hp'] as const) {
      const model = Math.abs(Math.log2(moog923MinusThreeDbRatio(tap)));
      // MONOTONE, and that is the assertion: a fixed tolerance would pass on a
      // constant offset, which is a different (and wrong) filter.
      expect(
        spread[tap][0] > spread[tap][1] && spread[tap][1] > spread[tap][2],
        `${tap} −3 dB distance from the corner (oct) must SHRINK as the corner ` +
          `climbs toward Nyquist — measured ${spread[tap].map((v) => v.toFixed(4)).join(' > ')} ` +
          `at knobs ${KNOBS.join('/')}, against the analog ${model.toFixed(4)}`,
      ).toBe(true);
      // …and every one of them is at or inside the analog prediction.
      for (const [i, v] of spread[tap].entries()) {
        expect(v, `${tap} at knob ${KNOBS[i]}, oct from corner vs analog`).toBeLessThanOrEqual(
          model * 1.001,
        );
      }
    }
  });

  it('the resonant hump is where and how tall the model says', async () => {
    const knob = 0.5;
    const f0 = cutoffToHz(knob);
    for (const tap of ['lp', 'hp'] as const) {
      let best = { oct: 0, g: -Infinity };
      for (let e = -1.2; e <= 1.2 + 1e-9; e += 0.05) {
        const g = await tapGainDb(tap, f0 * Math.pow(2, e), knob);
        if (g > best.g) best = { oct: e, g };
      }
      expect(best.g, `${tap} peak gain, dB re the driving sine`).toBeCloseTo(
        moog923PeakGainDb(),
        1,
      );
      expect(best.oct, `${tap} peak position, oct from the declared corner`).toBeCloseTo(
        Math.log2(moog923PeakRatio(tap)),
        1,
      );
      // A flat (Butterworth) filter would peak at 0 dB in the passband and this
      // leg would fail — which is the point of measuring it.
      expect(best.g, `${tap} has no hump at all`).toBeGreaterThan(0.5);
    }
  });
});

// ── M3 · THE FACE'S NUMBERS, against the module they describe ───────────────

describe('M3 · what the faceplate prints is what the module does', () => {
  it('the tap population: white is UNBIASED and pink is not, both re-derived', () => {
    // ⚠ THIS LEG WAS RESTRUCTURED BECAUSE ITS FIRST DRAFT FLAKED, AND THE REASON
    // IS THE POINT. Pink's deviation from its closed form is 0.187 dB while ONE
    // table's RMS has a standard deviation of 0.551 dB — so at the 8 spawns the
    // draft used, the standard error (0.195 dB) was the SIZE OF THE EFFECT and
    // the SIGN of the deficit flipped between runs. A direction asserted below
    // its own resolving power is not a finding; it is a coin toss wearing one.
    //
    // The fix is to measure the population where it is cheap — the SHIPPING
    // generators, which is what the factory fills its buffers from — over enough
    // tables to resolve it (SE at 256 is 0.034 dB, ~5.4 sigma). The FACTORY legs
    // below then only have to prove the factory reaches those generators and
    // scales them by LEVEL, which is a bit-level question needing no N.
    // ⚠ 256 → 1024 (2026-08-21). THE SAME DIAGNOSIS AS THE NOTE ABOVE, ONE
    // ITERATION LATER: at 256 this leg failed a CI run at 2.87 sigma
    // (deficit 0.1031 dB against a 3-sigma bound of 0.1077, SE 0.0359) while
    // passing 5/5 locally. The note above sized the effect at 0.187 dB and
    // therefore called 256 "~5.4 sigma" — but the effect the shipped generators
    // actually produce runs nearer 0.10 dB, so the true margin was ~2.9 sigma
    // against a 3-sigma test. That is a direction asserted at the edge of its
    // own resolving power: the same coin-toss shape the first draft had, just
    // with a longer odds.
    //
    // ⚠ THE THRESHOLD IS UNTOUCHED, DELIBERATELY. Relaxing 3 sigma to 2 would
    // "fix" this by making the assertion weaker than the claim it defends, and
    // the claim — pink measures UNDER its steady state because Voss row 15 is
    // still filling — is the whole point of the leg. Raising N attacks the
    // standard error instead: at 1024 the SE is ~0.018 dB, so the same effect
    // resolves at ~5.7 sigma and the direction is a finding again.
    // Cost is one ART test going from ~1.2 s to ~5 s.
    const TABLES = 1024;
    const LEN = 96000; // 2 s at 48 kHz — `BUFFER_SECONDS * sampleRate`
    const stats = (tap: 'white' | 'pink') => {
      const seen: number[] = [];
      for (let k = 0; k < TABLES; k++) seen.push(db(rms(noiseGenerators[tap](LEN))));
      const mean = seen.reduce((s, v) => s + v, 0) / seen.length;
      const sd = Math.sqrt(seen.reduce((s, v) => s + (v - mean) ** 2, 0) / seen.length);
      const closed = db(NOISE_TAP_RMS[tap]);
      return { mean, sd, closed, deficit: closed - mean, below: seen.filter((v) => v < closed).length };
    };

    const w = stats('white');
    const p = stats('pink');

    // WHITE — a uniform draw, so its 2 s RMS is an UNBIASED estimator of the
    // closed form. This is the instrument's own negative control: on a tap with
    // no bias to find, the probe must find none, and the table count must land
    // near half.
    expect(Math.abs(w.deficit), 'white deficit vs closed form, dB (expected ~0)').toBeLessThan(
      4 * (w.sd / Math.sqrt(TABLES)),
    );
    expect(w.below / TABLES, 'fraction of white tables under the closed form').toBeGreaterThan(0.35);
    expect(w.below / TABLES, 'fraction of white tables under the closed form').toBeLessThan(0.65);

    // PINK — the closed form is the STEADY-STATE value and the shipped 2 s table
    // measures UNDER it, because Voss row 15 re-rolls only every 32 768 samples
    // and starts at zero, so the slow rows are still filling for the first third
    // of every table. A DIRECTION, and now one the sample can actually see.
    expect(p.deficit, 'pink runs UNDER its steady-state closed form, dB').toBeGreaterThan(
      3 * (p.sd / Math.sqrt(TABLES)),
    );
    expect(p.deficit, 'pink deficit vs steady state, dB').toBeLessThan(0.5);
    expect(p.below / TABLES, 'fraction of pink tables under the closed form').toBeGreaterThan(0.55);

    // …and the asymmetry the same probe reads on the two taps, which is what
    // makes "pink is biased" a measurement rather than a tolerance choice.
    expect(p.sd, 'pink per-table sd, dB — an order over white').toBeGreaterThan(10 * w.sd);

    // THE SPREAD THE FACE PRINTS is the closed-form one, so it is the FLOOR of
    // what a player hears on any given spawn, never an overstatement.
    const closedSpread = db(NOISE_TAP_RMS.white) - db(NOISE_TAP_RMS.pink);
    expect(closedSpread, 'the closed-form spread the faceplate prints, dB').toBeCloseTo(12.304, 2);
    expect(w.mean - p.mean, 'measured population spread, dB').toBeGreaterThan(closedSpread);
  });

  it('⚠ THE SEED ACTUALLY BITES — without this leg the one below is luck', async () => {
    // THE INSTRUMENT'S OWN CONTROL, and it is permanent because it has to be:
    // the seeded legs below pin `Math.random` for the duration of `factory()`,
    // and if that stub failed to reach the generators — captured reference,
    // changed call site, a future factory that seeds itself — every assertion
    // there would go on passing on UNSEEDED tables until the day one of them
    // drew a tail. "The seed works" and "the seed does nothing" are
    // indistinguishable from a green run, so both directions are asserted.
    const a = await render({ params: { level: 1 }, secs: 0.2, seed: 0xc0ffee });
    const b = await render({ params: { level: 1 }, secs: 0.2, seed: 0xc0ffee });
    expect(bitIdentical(a.out.white, b.out.white), 'same seed, different white table').toBe(true);
    expect(bitIdentical(a.out.pink, b.out.pink), 'same seed, different pink table').toBe(true);

    // …and it is not that EVERYTHING is identical: a different seed must draw a
    // different table. (M0 already proves the UNSEEDED case differs, which is
    // the other half of the pair and the state CI was measuring.)
    const c = await render({ params: { level: 1 }, secs: 0.2, seed: 0x0badbeef });
    expect(bitIdentical(a.out.white, c.out.white), 'a different seed gave the SAME table').toBe(
      false,
    );
    expect(bitIdentical(a.out.pink, c.out.pink), 'a different seed gave the SAME table').toBe(false);

    // …and the stub is RESTORED, so no later test inherits a pinned Math.random.
    expect(Math.random === Math.random, 'sanity').toBe(true);
    const d = await render({ params: { level: 1 }, secs: 0.2 });
    const e = await render({ params: { level: 1 }, secs: 0.2 });
    expect(bitIdentical(d.out.white, e.out.white), 'Math.random stayed pinned after the render').toBe(
      false,
    );
  });

  it('the FACTORY reaches those generators and scales both taps by ONE level', async () => {
    // ⚠ THIS LEG WENT RED ON CI AND ITS COMMENT WAS THE BUG. It used to assert
    // `white − pink > 11` on UNSEEDED renders, and claimed the ratio between
    // two taps of one render "cancels the per-spawn table draw entirely". IT
    // DOES NOT. White and pink are INDEPENDENT tables: white's per-table RMS sd
    // is 0.0126 dB, pink's is 0.551 dB (both measured in the population leg
    // above), so their difference carries pink's variance in full. Against a
    // ~12.49 dB mean the floor of 11 sat 2.7 sigma out — about one run in 300
    // per assertion, twice per test, on every PR's art lane. CI read 10.883.
    //
    // ⚠ AND A LONGER WINDOW WOULD NOT HAVE FIXED IT, which is the part worth
    // writing down: the factory builds a 2 s table and LOOPS it, so rendering
    // 20 s re-measures the SAME table ten times. The variance is ACROSS SPAWNS,
    // not within a render — window length cannot touch it, and "widen the
    // window" would have looked like a fix while changing nothing.
    //
    // THE SUBJECT IS FIXED INSTEAD OF THE THRESHOLD, two ways at once:
    //
    //   1. THE TABLES ARE PINNED (`seed`), so every number below is exactly
    //      reproducible rather than a draw from a distribution.
    //   2. THE LOAD-BEARING CLAIM IS NOW THE INVARIANCE, not an absolute
    //      floor. "ONE gain, TWO loudnesses" is a statement about LEVEL: the
    //      spread between the taps must not depend on it. With the tables
    //      pinned that is an EXACT equality — one multiplier on both gains —
    //      so it is asserted to 12 decimals instead of a 1.3 dB cushion. A
    //      per-tap gain would break it at any LEVEL; the old floor could only
    //      have caught a break larger than the noise.
    const SEED = 0xc0ffee;
    const spread = (r: Render) => db(rms(r.out.white)) - db(rms(r.out.pink));

    const hot = await render({ params: { level: 1 }, secs: 2, seed: SEED });
    const dim = await render({ params: { level: 0.5 }, secs: 2, seed: SEED });

    // (1) THE CLAIM: the tap spread is EXACTLY LEVEL-invariant.
    expect(
      spread(dim) - spread(hot),
      'white−pink must be IDENTICAL at LEVEL 1 and LEVEL 0.5 — one gain drives both taps',
    ).toBeCloseTo(0, 12);

    // (2) …and LEVEL is one multiplier: each tap moves by exactly 6.0206 dB.
    for (const tap of ['white', 'pink'] as const) {
      expect(
        db(rms(hot.out[tap])) - db(rms(dim.out[tap])),
        `${tap} at LEVEL 1 minus LEVEL 0.5, dB`,
      ).toBeCloseTo(20 * Math.log10(2), 9);
    }

    // (3) The spread is the physical one, bounded by the SINGLE-TABLE spread
    // rather than by a guess. Derivation: pink's per-table RMS sd is 0.551 dB
    // (measured over 256 tables in the population leg); one pinned table is one
    // draw from that, so a +-3 sigma envelope is +-1.65 dB. The bound below is
    // 2.0 dB — comfortably outside 3 sigma, and still far too tight to admit a
    // level-matched pair (0 dB) or a swapped tap (-12.3 dB).
    const closedSpread = db(NOISE_TAP_RMS.white) - db(NOISE_TAP_RMS.pink);
    expect(closedSpread, 'the closed-form spread the faceplate prints, dB').toBeCloseTo(12.304, 2);
    expect(
      Math.abs(spread(hot) - closedSpread),
      `seeded spread ${spread(hot).toFixed(3)} dB vs closed form ${closedSpread.toFixed(3)} dB ` +
        `(bound 2.0 = 3.6x pink's 0.551 dB single-table sd)`,
    ).toBeLessThan(2.0);

    // (4) …and the taps are the right way round, which no tolerance above can
    // say: white is the LOUD one.
    expect(spread(hot), 'white must be ABOVE pink').toBeGreaterThan(0);
  });

  it('the SHIPPED DEFAULT really is an overlap, not the crossover it looks like', async () => {
    // Both dials ship at 0.50. Measure both −3 dB points on the real filter and
    // show the taps overlap — the single fact the `split` readout exists for.
    const lp = cutoffToHz(DEFAULTS.lpCutoff) * (await measuredMinusThreeDbRatio('lp', DEFAULTS.lpCutoff));
    const hp = cutoffToHz(DEFAULTS.hpCutoff) * (await measuredMinusThreeDbRatio('hp', DEFAULTS.hpCutoff));
    const measuredOct = Math.log2(lp / hp);

    expect(DEFAULTS.lpCutoff, 'the two dials ship at the same position').toBe(DEFAULTS.hpCutoff);
    expect(measuredOct, 'measured overlap at the shipped defaults, oct').toBeGreaterThan(0.5);
    expect(measuredOct, 'measured overlap at the shipped defaults, oct').toBeCloseTo(
      moog923SplitOct(moog923FaceParams((id) => DEFAULTS[id])),
      1,
    );
    // ⚠ AND THE NAIVE ANSWER IS ZERO. Two dials at the same position read as a
    // clean crossover; a readout that printed the dials would say `aligned`.
    expect(measuredOct, 'the naive "both dials agree ⇒ aligned" reading').not.toBeCloseTo(0, 1);
  });

  it('readParam round-trips the log map, at the rails as well as the middle', async () => {
    for (const knob of [0, 0.25, 0.5, 0.75, 1]) {
      const r = await render({ params: { lpCutoff: knob, hpCutoff: knob }, secs: 0.05 });
      expect(r.readParam('lpCutoff'), `lpCutoff readback at ${knob}`).toBeCloseTo(knob, 5);
      expect(r.readParam('hpCutoff'), `hpCutoff readback at ${knob}`).toBeCloseTo(knob, 5);
    }
    expect(cutoffToHz(0)).toBeCloseTo(CUTOFF_MIN_HZ, 6);
    expect(cutoffToHz(1)).toBeCloseTo(CUTOFF_MAX_HZ, 6);
  });
});
