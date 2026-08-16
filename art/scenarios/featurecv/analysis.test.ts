// art/scenarios/featurecv/analysis.test.ts
//
// THE FEATURECV AUDIT, as a permanent scenario — every claim the faceplate and
// the docs make about this module's BEHAVIOUR, re-derived on every run from the
// SHIPPING worklet through the def's OWN factory, plus the trigger-capture
// census the #1703 / #1725 defect class exists for.
//
// WHY THIS IS NOT COVERED BY WHAT WAS ALREADY HERE
// (module-adversarial-audit.md step 3):
//   * `feature-extract.test.ts` (this directory) pins four rendered feature
//     waveforms as .f32 baselines and asserts the headline orderings (noise is
//     brighter than a sine; a burst produces ≥ 1 onset). It drives the PURE
//     CORE, never the factory, and every one of its assertions is a comparison
//     between two renders — so a mapping constant could move both sides and
//     stay green.
//   * `featurecv-source-chain.spec.ts` drives a real NOISE → featurecv →
//     filter.cutoff chain in the browser and asserts the CV moves a downstream
//     param. It proves the jack is ALIVE; it says nothing about what LEVEL it
//     is alive at, and its margins are deliberately generous.
//   * `contract-lock`, `module-docs-lint` and the per-module-per-port sweep all
//     read the DECLARATION. Every defect this file records is a VALUE.
//   * `featurecv-face-model.test.ts` is the PARAM half — pure arithmetic over
//     the model. This file is the AUDIO half, and the two are joined below: the
//     faceplate's `idle` / `−12 dB` / `max rate` numbers are asserted against
//     what the worklet actually emits, not against the model that prints them.
//
// ⚠ THE INSTRUMENT, AND WHAT IT IS INVARIANT TO. Two metrics, deliberately
// different in kind:
//   * for the three continuous CVs — the SETTLED sample in LINEAR amplitude on
//     each mono output. The drivers are steady, so there is no window to choose
//     and no phase to align.
//   * for ONSET — a RISING-EDGE COUNT across `GATE_HI`, which is the same
//     predicate `$lib/audio/edge-detect` applies and the same one the ART
//     scenario next door uses. A LEVEL metric cannot count triggers at all.
//
// ⚠ AND THE ONSET SWEEP CARRIES ITS OWN POSITIVE CONTROL, because a capture
// census that reads 100 % and a census that never drove anything look identical
// from the output. Every row asserts the DRIVE produced the hits it claims, and
// the debounce leg is the negative control ON THE COUNTER: pushing the train
// past the lockout MUST collapse the count, or the counter is not counting.
//
// Nothing here is pinned, so this scenario needs no baseline and no `.sha` — it
// is an assertion scenario like art/scenarios/unityscalemathematik/cv-path.test.ts.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { featurecvDef } from '$lib/audio/modules/featurecv';
import {
  featurecvFaceParams,
  featurecvIdleCv,
  featurecvLoudCv,
  featurecvMaxTrigHz,
  FEATURECV_LOUD_CLIP_RMS,
  FEATURECV_PROBE_RMS,
} from '$lib/ui/modules/featurecv-face-model';
import {
  GATE_HI,
  TRIGGER_PULSE_S,
  renderFeatureCv,
} from '../../../packages/dsp/src/lib/featurecv-dsp';
import { noiseGenerators } from '../../../packages/dsp/src/lib/noise-dsp';

const SR = 48000;
/** Past the worklet's first `load` message, the 1024-sample analysis window and
 *  several release constants. */
const SETTLE_S = 1.2;
const OUT_IDS: readonly string[] = featurecvDef.outputs.map((o) => o.id);
const CV_OUT_IDS: readonly string[] = featurecvDef.outputs.filter((o) => o.type === 'cv').map((o) => o.id);

/** Each leg instantiates the REAL worklet in a fresh OfflineAudioContext. It
 *  bounds the failure; it is never the gate. */
const SWEEP_TIMEOUT_MS = 300_000;

function basePatch(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of featurecvDef.params) out[p.id] = p.defaultValue;
  return out;
}

interface Render {
  /** settled sample per declared output id. */
  out: Record<string, number>;
  /** whole buffer per output — for the edge count and the bit-identity leg. */
  buf: Record<string, Float32Array>;
}

/**
 * Render `input` through the DEF'S OWN FACTORY. `input === null` means NOTHING
 * PATCHED — the resting state, which is a leg in its own right and the reason
 * the signal source is optional rather than a zero buffer (a connected silent
 * source and no source at all are different graphs).
 */
async function render(
  input: Float32Array | null,
  params: Record<string, number> = {},
  seconds?: number,
): Promise<Render> {
  const n = Math.max(1, Math.round((seconds ?? (input ? input.length / SR : 0.3)) * SR));
  const ctx = new OfflineAudioContext({ numberOfChannels: OUT_IDS.length, length: n, sampleRate: SR });
  const node = {
    id: 'analysis',
    type: 'featurecv',
    position: { x: 0, y: 0 },
    params: { ...basePatch(), ...params },
  } as never;
  const handle = await featurecvDef.factory(ctx as unknown as AudioContext, node);

  if (input) {
    const buf = ctx.createBuffer(1, Math.max(1, input.length), SR);
    // A fresh, definitely-`ArrayBuffer`-backed copy: `copyToChannel` is typed
    // `Float32Array<ArrayBuffer>` and a slice of a `Float32Array<ArrayBufferLike>`
    // does not satisfy it.
    buf.copyToChannel(new Float32Array(input), 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const ref = handle.inputs.get('in')!;
    src.connect(ref.node, 0, ref.input);
    src.start(0);
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
  OUT_IDS.forEach((id, i) => {
    const chan = rendered.getChannelData(i);
    buf[id] = Float32Array.from(chan);
    out[id] = chan[n - 1]!;
  });
  return { out, buf };
}

/** Rising edges across GATE_HI — the trigger predicate, not a level. */
function countEdges(b: Float32Array): number {
  let count = 0;
  let prev = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i]! >= GATE_HI && prev < GATE_HI) count++;
    prev = b[i]!;
  }
  return count;
}

/** A train of exponentially-decaying tone bursts — the canonical hit source. */
function hitTrain(hz: number, secs: number, decayS = 0.01, amp = 1, freq = 1200): Float32Array {
  const n = Math.round(secs * SR);
  const out = new Float32Array(n);
  const period = Math.round(SR / hz);
  const tail = Math.round(decayS * 6 * SR);
  for (let h = 0; h * period < n; h++) {
    const start = h * period;
    for (let i = start; i < Math.min(n, start + tail); i++) {
      out[i] += amp * Math.exp(-(i - start) / (decayS * SR)) * Math.sin((2 * Math.PI * freq * i) / SR);
    }
  }
  return out;
}

/** How many hits a train of `hz` actually contains over `secs`. The census's
 *  own positive control: a row that expected more hits than were played would
 *  report a capture shortfall that is really an arithmetic bug. */
const hitsIn = (hz: number, secs: number): number => Math.ceil(hz * secs);

/**
 * Silence in front of a signal.
 *
 * ⚠ THE LEAD-IN IS PART OF THE INSTRUMENT, and it was added because its absence
 * produced a clean, plausible, WRONG number. The factory pushes the k-rate
 * params with `setValueAtTime(v, ctx.currentTime)`, and in an OfflineAudioContext
 * the FIRST render quantum still reads the descriptor DEFAULT — so a hit inside
 * the first 128 samples arms the lockout with `onset_debounce` = 80 ms whatever
 * the patch says, and the SECOND hit of a 16 Hz train then vanishes. Measured:
 * 47 of 48 through the factory against 48 of 48 through the pure core, with the
 * two buffers otherwise bit-identical and the missing edge at sample 3022. That
 * is a one-quantum initialisation artifact of the HOST, not a property of the
 * module, and a census that swallowed it would be reporting a 97.9 % capture
 * rate for the wrong reason.
 */
function withLeadIn(sig: Float32Array, secs = 0.1): Float32Array {
  const lead = Math.round(secs * SR);
  const out = new Float32Array(lead + sig.length);
  out.set(sig, lead);
  return out;
}

/** DC at a given amplitude, for the settled-level legs. A sine at amplitude
 *  `a` has RMS `a/√2`; DC at `a` has RMS `a`, which makes the LOUD arithmetic
 *  the reader's rather than the harness's. */
function dc(amp: number, secs: number): Float32Array {
  return new Float32Array(Math.round(secs * SR)).fill(amp);
}

const fmt = (v: number) => (v === 0 ? '0.0000e+0' : v.toExponential(4));

describe('ART featurecv / analysis — what the faceplate claims, measured on the shipping worklet', () => {
  it(
    'M1 — WITH NOTHING PATCHED all three feature CVs sit at the POLARITY FLOOR, not at zero',
    { timeout: SWEEP_TIMEOUT_MS },
    async () => {
      // The rank-1 argument and the `idle` readout, in one measurement. It is
      // also the reason the module needs a keep-alive at all: without it the
      // worklet would never process and the jacks would read a Web Audio zero,
      // which is a DIFFERENT number from the bipolar floor and would make the
      // faceplate wrong in exactly the direction nobody would check.
      const bi = await render(null, {}, SETTLE_S);
      for (const id of CV_OUT_IDS) {
        expect(bi.out[id], `'${id}' idle level (LINEAR amplitude, bipolar default)`).toBeCloseTo(-1, 5);
      }
      const uni = await render(null, { bipolar: 0 }, SETTLE_S);
      for (const id of CV_OUT_IDS) {
        expect(uni.out[id], `'${id}' idle level (LINEAR amplitude, unipolar)`).toBeCloseTo(0, 5);
      }
      // …and the ONSET jack is quiet in both, which is what makes the three
      // rows above a statement about the FEATURE path rather than about the
      // whole module.
      expect(countEdges(bi.buf.onset!)).toBe(0);
      expect(countEdges(uni.buf.onset!)).toBe(0);

      // THE JOIN: the faceplate's `idle` readout is the number the jack holds.
      expect(featurecvIdleCv(featurecvFaceParams(() => undefined))).toBeCloseTo(bi.out[CV_OUT_IDS[0]!]!, 5);
    },
  );

  it(
    'M2 — POLARITY is the ONLY control that moves an idle jack; the other five are bit-exactly inert',
    { timeout: SWEEP_TIMEOUT_MS },
    async () => {
      // The demotion half of the ranking argument, and it is asserted rather
      // than reasoned: each of the five is driven to the FAR end of its travel
      // against an unpatched module.
      const ctrl = await render(null, {}, SETTLE_S);
      const far: Record<string, number> = {
        gain: 4,
        attack: 500,
        release: 2000,
        onset_sens: 1,
        onset_debounce: 1000,
      };
      for (const [id, to] of Object.entries(far)) {
        const r = await render(null, { [id]: to }, SETTLE_S);
        for (const out of CV_OUT_IDS) {
          const d = Math.abs(r.out[out]! - ctrl.out[out]!);
          expect(d, `'${id}' → ${to} moved idle '${out}' by ${fmt(d)} (LINEAR amplitude)`).toBe(0);
        }
      }
      const flipped = await render(null, { bipolar: 0 }, SETTLE_S);
      const rail = Math.abs(flipped.out[CV_OUT_IDS[0]!]! - ctrl.out[CV_OUT_IDS[0]!]!);
      // POSITIVE CONTROL on the same metric: without this row, "the five are
      // inert" and "the harness measures nothing" are the same output.
      expect(rail, `POLARITY must move an idle jack a full rail: ${fmt(rail)} (LINEAR amplitude)`).toBeCloseTo(1, 5);
    },
  );

  it(
    'M3 — LOUD is `clamp01(2·rms·gain)` and it CLIPS, at the level the faceplate prints',
    { timeout: SWEEP_TIMEOUT_MS },
    async () => {
      // DC drivers, so `rms === amplitude` and the reader can do the arithmetic
      // in their head. The `−12 dB` readout is the second row.
      const rows: { amp: number; gain: number; got: number; want: number }[] = [];
      for (const [amp, gain] of [
        [0.1, 1],
        [FEATURECV_PROBE_RMS, 1],
        [FEATURECV_LOUD_CLIP_RMS, 1],
        [0.8, 1],
        [FEATURECV_PROBE_RMS, 4],
        [FEATURECV_PROBE_RMS, 0.25],
      ] as const) {
        const r = await render(dc(amp, SETTLE_S), { gain });
        rows.push({
          amp,
          gain,
          got: r.out.loud!,
          want: featurecvLoudCv(amp, featurecvFaceParams((id) => (id === 'gain' ? gain : undefined))),
        });
      }
      for (const row of rows) {
        expect(
          row.got,
          `LOUD at rms ${row.amp} × gain ${row.gain}: worklet ${row.got.toFixed(6)} vs faceplate ${row.want.toFixed(6)} (LINEAR amplitude)`,
        ).toBeCloseTo(row.want, 4);
      }
      // THE CLIP, stated as the property rather than as a number: at and above
      // the clip level the feature stops responding to the source at all.
      const atClip = rows.find((r) => r.amp === FEATURECV_LOUD_CLIP_RMS && r.gain === 1)!;
      const wayOver = rows.find((r) => r.amp === 0.8 && r.gain === 1)!;
      expect(atClip.got).toBeCloseTo(1, 4);
      expect(wayOver.got - atClip.got, 'LOUD must be PINNED above the clip level').toBeCloseTo(0, 5);
      // …and it is not pinned below it, which is the control on that claim.
      const below = rows.find((r) => r.amp === 0.1)!;
      expect(below.got).toBeLessThan(atClip.got - 0.1);
    },
  );

  it(
    'M4 — GAIN reaches exactly ONE of the three feature CVs, bit-exactly',
    { timeout: SWEEP_TIMEOUT_MS },
    async () => {
      // The docs correction, measured through the real factory rather than
      // argued from the algebra. The trim is a GainNode in front of the
      // worklet, so if scale-invariance were only approximately true it would
      // show up here.
      const sig = noiseGenerators.white(Math.round(SETTLE_S * SR), 0xc0ffee);
      const ctrl = await render(sig, { gain: 1 });
      for (const gain of [0.25, 0.5, 2, 4]) {
        const r = await render(sig, { gain });
        for (const id of ['bright', 'punch'] as const) {
          const d = Math.abs(r.out[id]! - ctrl.out[id]!);
          expect(d, `GAIN ${gain} moved '${id}' by ${fmt(d)} (LINEAR amplitude) — it must not`).toBe(0);
        }
      }
      // POSITIVE CONTROL on the same drive: the one it DOES reach really moves.
      const quiet = Float32Array.from(sig, (v) => v * 0.1);
      const lo = await render(quiet, { gain: 0.25 });
      const hi = await render(quiet, { gain: 4 });
      expect(
        hi.out.loud! - lo.out.loud!,
        `GAIN must move LOUD: ${lo.out.loud!.toFixed(6)} → ${hi.out.loud!.toFixed(6)} (LINEAR amplitude)`,
      ).toBeGreaterThan(0.5);
    },
  );

  it(
    'M5 — the rack\'s OWN white tap lands PUNCH at the BOTTOM of its rail (#1745)',
    { timeout: SWEEP_TIMEOUT_MS },
    async () => {
      // The false calibration comment, refuted at the jack. The DSP core
      // promised "white noise (~3.5) → ~0.5"; the rack's white tap is UNIFORM,
      // crest √3, so the canonical NOISE → FEATURECV patch reads a third of
      // that — and BELOW the two "darker" taps, which is the opposite ordering.
      const secs = SETTLE_S;
      const got: Record<string, number> = {};
      for (const flavor of ['white', 'pink', 'brown'] as const) {
        const r = await render(noiseGenerators[flavor](Math.round(secs * SR), 0xc0ffee), { bipolar: 0 });
        got[flavor] = r.out.punch!;
      }
      expect(got.white, `white PUNCH (unipolar) = ${got.white!.toFixed(4)}`).toBeLessThan(0.2);
      expect(got.pink, 'pink must be PEAKIER than white').toBeGreaterThan(got.white!);
      expect(got.brown, 'brown must be PEAKIER than white').toBeGreaterThan(got.white!);
      // At the shipped BIPOLAR default the same patch sits well below centre.
      const bi = await render(noiseGenerators.white(Math.round(secs * SR), 0xc0ffee), {});
      expect(bi.out.punch, `white PUNCH (bipolar) = ${bi.out.punch!.toFixed(4)}`).toBeLessThan(-0.6);
    },
  );

  it(
    'M6 — the ONSET jack captures 100 % of a hit train up to the debounce ceiling, and the ceiling is the readout',
    { timeout: SWEEP_TIMEOUT_MS },
    async () => {
      // THE #1703 / #1725 CENSUS. `buggles` captured 1 clock edge in 6 and
      // `backdraft` 28.6 % of 5 ms triggers; the tell for that class is a FLAT
      // FRACTION below 100 %. This consumer is a WORKLET doing a per-sample
      // compare, so it should be exact — and "should" is why it is measured.
      const SECS = 3;
      const CEILING_HZ = featurecvMaxTrigHz(featurecvFaceParams(() => undefined));
      expect(CEILING_HZ, 'the faceplate ceiling at the shipped debounce').toBeCloseTo(12.5, 6);

      // ⚠ THE HIT WIDTH IS PART OF THE INSTRUMENT, and getting it wrong is how
      // the first draft of this leg went red for the wrong reason. Every hit
      // here decays in 2 ms (a ~12 ms tail), so even the fastest train below
      // leaves 28 ms of silence between hits and the DETECTOR is never the
      // constraint — only the lockout is. With the 10 ms decay the other legs
      // use, a 20 Hz train's tails OVERLAP, the slow envelope never falls, the
      // flux never re-rises and the census collapses to ONE pulse at EVERY
      // debounce setting: a result about the material wearing the shape of a
      // result about the dial.
      const DECAY_S = 0.002;
      const rows: string[] = [];
      for (const hz of [1, 2, 4, 8, 12]) {
        const r = await render(withLeadIn(hitTrain(hz, SECS, DECAY_S)), {});
        const got = countEdges(r.buf.onset!);
        const want = hitsIn(hz, SECS);
        rows.push(`${hz} Hz: ${got}/${want}`);
        expect(hz, 'this row must sit UNDER the ceiling or it is testing the lockout').toBeLessThan(CEILING_HZ);
        expect(got, `ONSET capture at ${hz} Hz (rising edges across GATE_HI): ${rows.join(' · ')}`).toBe(want);
      }

      // NEGATIVE CONTROL ON THE COUNTER, in the same units: past the ceiling the
      // count MUST collapse. Without this row a counter stuck at `want` would
      // read as a perfect capture. Measured: an 80 ms lockout against a 16 Hz
      // train passes every OTHER hit — 24 of 48.
      const over = await render(withLeadIn(hitTrain(16, SECS, DECAY_S)), {});
      const overGot = countEdges(over.buf.onset!);
      expect(
        overGot,
        `a 16 Hz train is past the ${CEILING_HZ} Hz lockout and must NOT pass intact: ${overGot}/${hitsIn(16, SECS)}`,
      ).toBeLessThan(hitsIn(16, SECS) * 0.6);

      // …and the ceiling MOVES with the dial, which is what makes the readout a
      // derivation rather than a constant: at DEBNCE 40 ms the same train sits
      // under a 25 Hz ceiling and passes whole.
      const fast = await render(withLeadIn(hitTrain(16, SECS, DECAY_S)), { onset_debounce: 40 });
      expect(
        countEdges(fast.buf.onset!),
        'shortening the lockout must let the same 16 Hz train through',
      ).toBe(hitsIn(16, SECS));
    },
  );

  it(
    'M7 — the ONSET pulse is one TRIGGER_PULSE_S crossing, and POLARITY does not touch it',
    { timeout: SWEEP_TIMEOUT_MS },
    async () => {
      // `edge: 'trigger'` is a DECLARATION; this is the value behind it. A
      // consumer that level-samples this jack would need to know the width, and
      // nothing else in the repo states it for this module.
      const r = await render(hitTrain(2, 2), {});
      const buf = r.buf.onset!;
      let high = 0;
      let runs = 0;
      let inRun = false;
      for (let i = 0; i < buf.length; i++) {
        const on = buf[i]! >= GATE_HI;
        if (on) high++;
        if (on && !inRun) runs++;
        inRun = on;
      }
      expect(runs).toBeGreaterThan(0);
      const meanSamples = high / runs;
      expect(
        meanSamples,
        `mean pulse width = ${meanSamples.toFixed(1)} samples (${((meanSamples / SR) * 1000).toFixed(2)} ms), declared ${(TRIGGER_PULSE_S * 1000).toFixed(1)} ms`,
      ).toBeCloseTo(Math.round(TRIGGER_PULSE_S * SR), -1);

      const uni = await render(hitTrain(2, 2), { bipolar: 0 });
      expect(countEdges(uni.buf.onset!), 'POLARITY must not change the trigger').toBe(runs);
    },
  );

  it(
    'M8 — SENS is CONDITIONAL, and the first probe signal could not see it',
    { timeout: SWEEP_TIMEOUT_MS },
    async () => {
      // ⚠ THIS LEG IS AN INSTRUMENT LESSON KEPT AS A TEST. Swept against a
      // clean, well-separated hit train, the whole SENS travel is a no-op —
      // which reads exactly like a dead dial and is not one: an unambiguous
      // transient clears every threshold, so that probe is INVARIANT to the
      // dimension under test (CLAUDE.md, "a no-op reading is FIRST an
      // instrument bug"). Both halves are asserted, so neither can be mistaken
      // for the other later.
      const SECS = 3;
      const clean = hitTrain(4, SECS);
      const counts = await Promise.all(
        [0, 0.5, 1].map(async (onset_sens) => countEdges((await render(clean, { onset_sens })).buf.onset!)),
      );
      expect(new Set(counts).size, `clean hits are SENS-invariant by design: ${counts.join(', ')}`).toBe(1);
      expect(counts[0]).toBe(hitsIn(4, SECS));

      // THE OTHER HALF: on ambiguous material the same travel has real
      // authority. A tremolo tone has no transient at all — only a rising
      // envelope — so where the threshold sits decides everything.
      const n = Math.round(SECS * SR);
      const tremolo = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const am = 0.5 * (1 + Math.sin((2 * Math.PI * 4 * i) / SR - Math.PI / 2));
        tremolo[i] = 0.7 * am * Math.sin((2 * Math.PI * 500 * i) / SR);
      }
      const lo = countEdges((await render(tremolo, { onset_sens: 0 })).buf.onset!);
      const hi = countEdges((await render(tremolo, { onset_sens: 1 })).buf.onset!);
      expect(
        hi,
        `SENS must have authority on ambiguous material: ${lo} pulses at SENS 0 → ${hi} at SENS 1`,
      ).toBeGreaterThan(lo + 3);
    },
  );

  it(
    'M9 — the WORKLET agrees with the pure core, and two renders are BIT-IDENTICAL (#1680)',
    { timeout: SWEEP_TIMEOUT_MS },
    async () => {
      // `node-web-audio-api` renders off-thread, so a `setInterval` pump would
      // keep firing during a render and make any value written only from one
      // racy. This module has no pump — but three modules measured racy in
      // #1680, so it is asserted rather than assumed, permanently, and a future
      // pump cannot be added quietly.
      const sig = hitTrain(4, 1);
      const a = await render(sig, {});
      const b = await render(sig, {});
      let worst = 0;
      for (const id of OUT_IDS) {
        for (let i = 0; i < a.buf[id]!.length; i++) {
          worst = Math.max(worst, Math.abs(a.buf[id]![i]! - b.buf[id]![i]!));
        }
      }
      expect(worst, `two renders of one patch differ by ${fmt(worst)} (LINEAR amplitude)`).toBe(0);

      // …and the worklet is the SAME arithmetic the pure core (and therefore
      // the ART baselines and the unit tests) runs. `gain` is a GainNode in the
      // factory and an inline multiply offline, so this leg is what says the
      // two seams agree.
      const pure = renderFeatureCv(sig, { sr: SR });
      let vs = 0;
      for (const id of ['loud', 'bright', 'punch', 'onset'] as const) {
        for (let i = 0; i < pure[id].length; i++) {
          vs = Math.max(vs, Math.abs(a.buf[id]![i]! - pure[id][i]!));
        }
      }
      expect(vs, `worklet vs pure core: ${fmt(vs)} (LINEAR amplitude)`).toBe(0);
    },
  );
});
