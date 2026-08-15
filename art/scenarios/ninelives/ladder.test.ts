// art/scenarios/ninelives/ladder.test.ts
//
// WHICH DECLARED OUTPUT PORT IS WHICH RUNG OF THE ⅓ LADDER?
//
// The audit gate owed by the `noise` lane-meter class. NINE LIVES publishes
// NINE outputs off ONE worklet, and every statement anyone makes about it —
// the def header, `docs.outputs`, the faceplate's whole reason to exist — is a
// claim about the MAP from a declared port id to a rate. That map is built in
// `ninelives.ts`'s factory (`outputs.set('out'+(n+1), { node, output: n })`),
// and NOTHING in the repo reads it:
//
//  * `packages/web/src/lib/audio/modules/ninelives.test.ts` asserts the map
//    against ITS OWN arithmetic (`out${n} → output n-1`), i.e. it pins the
//    factory's index bookkeeping and is structurally blind to what the
//    processor writes to those indices.
//  * `packages/dsp/src/lib/ninelives-dsp.test.ts` drives the pure core, which
//    has no port ids at all — it indexes a scratch array.
//  * `art/scenarios/ninelives/profile.test.ts` drives the PROCESSOR CLASS
//    directly through the shim loader, naming outputs `out1..out9` by
//    convention in ITS OWN literal. It never instantiates the def's factory,
//    so a factory that reversed the map would leave it green.
//  * `per-module-per-port-behavioral` proves an edge materializes, not what
//    is on the far end of it.
//
// So: every existing gate reads ONE side. This one joins the DEF's declared
// port id to the RATE that comes out of it, through the SHIPPED factory in a
// real OfflineAudioContext (node-web-audio-api) — the same route `AudioEngine`
// takes.
//
// THE INSTRUMENT, AND WHAT IT IS INVARIANT TO.
// The measurement is a PHASE-SLOPE readout, not a spectral one, and that
// choice is the whole reason a 1-second render can resolve a tap running at
// 0.0152 Hz. At `shape = 1` the morph is EXACTLY `2φ − 1` (ninelives-dsp.ts
// `saw`), so the rendered sample IS the phase, affinely. Unwrap it, divide the
// total phase advance by the elapsed time, and every rung — from 100 Hz to
// 100/6561 Hz — is read by the same estimator with the same code path. A
// Goertzel/FFT cannot do that: out9 completes 0.0152 of a cycle in this window
// and has no resolvable bin.
//
// Units: every reported number is Hz (cycles per second) unless the assertion
// message says otherwise. Ratios are dimensionless.
//
// THE CONTROLS, all permanent legs (a green sweep with no controls is
// indistinguishable from a sweep that measured nothing):
//  * ESTIMATOR-POSITIVE — a synthetic saw of a KNOWN frequency, built in JS,
//    read by the same estimator. Pins the estimator's absolute scale.
//  * ABSOLUTE-POSITIVE — `out1` at `rate = 48` must measure 48 Hz, not merely
//    "3× out2". Ratios alone are satisfied by a ladder that is uniformly
//    wrong.
//  * ESTIMATOR-NEGATIVE — a CONSTANT buffer must read 0 Hz. "Frozen" and
//    "never looked" have to be distinguishable.
//  * SUBJECT-NEGATIVE — halve the rate knob and EVERY measured tap must halve.
//    An estimator that returned a constant would pass the ladder ratios (they
//    would all be 1) but not this.
//  * DETERMINISM — the render is repeated and asserted BIT-IDENTICAL before
//    any number is believed (#1680: `node-web-audio-api` renders off-thread,
//    and an unstable render hands back confident, wrong numbers).
//
// Nothing is pinned here and every driver is deterministic, so this scenario
// needs no baseline and no `.sha` — it is an assertion scenario like
// art/scenarios/wavetable-vco/cv-path.test.ts.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { ninelivesDef } from '$lib/audio/modules/ninelives';
import { lfoDef } from '$lib/audio/modules/lfo';
import {
  NINE_LIVES_OUTPUT_COUNT,
  NINE_LIVES_RATE_MULTIPLIERS,
} from '../../../packages/dsp/src/lib/ninelives-dsp';

const SR = 48000;
const DUR_S = 1;
const N = Math.round(SR * DUR_S);

/** SAW. The morph is exactly `2φ − 1` here, which is what makes the phase
 *  readable off the sample. Every rate measurement below uses it. */
const SAW = 1;

/**
 * The declared output ports, IN DECLARATION ORDER, read off the def.
 *
 * DERIVED, never typed: the ladder's length is a property of the def, and this
 * file must not carry a second copy of it (CLAUDE.md — never hand-type a
 * population count). Adding a tenth output to the def enrolls it here
 * automatically, and the ratio assertion below then states what rung it is
 * expected to occupy.
 */
const PORTS: readonly string[] = ninelivesDef.outputs.map((o) => o.id);

/** The def's own shipped spawn defaults, overlaid with a patch. */
function patch(over: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of ninelivesDef.params) out[p.id] = p.defaultValue;
  return { ...out, ...over };
}

/**
 * Render every declared output through the DEF'S OWN FACTORY, one merger
 * channel per declared port, keyed by port ID.
 *
 * ⚠ THE KEYING IS THE POINT. The channel index comes from this file's
 * enumeration of `PORTS`; the worklet output index comes from the FACTORY's
 * handle. A factory that mapped `out9 → worklet output 0` would land here as
 * channel 8 carrying the fastest rate, which is exactly the assertion below.
 */
async function renderTaps(
  params: Record<string, number>,
  opts?: { resetAtSample?: number },
): Promise<Record<string, Float32Array>> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: PORTS.length,
    length: N,
    sampleRate: SR,
  });
  const node = { id: 'ladder', type: 'ninelives', position: { x: 0, y: 0 }, params } as never;
  const handle = await ninelivesDef.factory(ctx as unknown as AudioContext, node);

  if (opts?.resetAtSample !== undefined) {
    // A single rising edge, through the DECLARED `reset` port, at the terminal
    // the handle publishes (no `param` → a raw node input, the `gate` cable).
    const ref = handle.inputs.get('reset')!;
    const cs = ctx.createConstantSource();
    cs.offset.value = 0;
    cs.offset.setValueAtTime(0, 0);
    cs.offset.setValueAtTime(1, opts.resetAtSample / SR);
    cs.connect(ref.node, 0, ref.input);
    cs.start(0);
  }

  const merger = ctx.createChannelMerger(PORTS.length);
  PORTS.forEach((id, ch) => {
    const out = handle.outputs.get(id);
    if (!out) throw new Error(`ladder: factory published no output '${id}'`);
    out.node.connect(merger, out.output, ch);
  });
  merger.connect(ctx.destination);

  const buf = await ctx.startRendering();
  const byPort: Record<string, Float32Array> = {};
  PORTS.forEach((id, ch) => {
    byPort[id] = buf.getChannelData(ch).slice();
  });
  return byPort;
}

/**
 * Frequency in Hz from a SAW buffer, by unwrapped phase slope.
 *
 * `x = 2φ − 1` ⇒ `φ = (x+1)/2`. A wrap is the only place φ decreases, and it
 * decreases by ~1, so a 0.5 threshold separates a wrap from an increment at
 * every rate this module can produce (the fastest, 100 Hz at 48 kHz, steps
 * 0.00208 per sample). Total advance / elapsed seconds = Hz.
 */
function sawHz(x: Float32Array, sampleRate = SR): number {
  const phi = (i: number) => (x[i]! + 1) / 2;
  let wraps = 0;
  let prev = phi(0);
  for (let i = 1; i < x.length; i++) {
    const p = phi(i);
    if (p < prev - 0.5) wraps += 1;
    prev = p;
  }
  const total = wraps + prev - phi(0);
  return (total * sampleRate) / (x.length - 1);
}

/** A synthetic saw at a known frequency — the estimator's positive control. */
function syntheticSaw(hz: number, n = N, sampleRate = SR): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = ((i + 1) * hz) / sampleRate;
    out[i] = 2 * (p - Math.floor(p)) - 1;
  }
  return out;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i]! - b[i]!));
  return d;
}

const RENDER_TIMEOUT_MS = 120_000;

describe('ART ninelives / the ⅓ ladder, read off the DEF FACTORY by declared port id', () => {
  it('THE ROSTER JOIN — the def’s declared ports ARE the DSP core’s ladder rungs', () => {
    // The def used to carry `const OUT_COUNT = 9` and a nine-entry `outputs`
    // literal while `ninelives-dsp.ts` sized the processor's per-sample loop
    // off its own `NINE_LIVES_OUTPUT_COUNT`. Two unjoined copies of one number,
    // in two packages: if either moved, the def would publish ports the
    // processor never writes (silently dead jacks) or the processor would write
    // to indices the node does not have. The def now derives its roster from
    // the DSP constant, and this states the invariant across the package
    // boundary — both directions, no count typed on either side.
    expect(PORTS).toEqual(NINE_LIVES_RATE_MULTIPLIERS.map((_, n) => `out${n + 1}`));
    expect(PORTS.length).toBe(NINE_LIVES_OUTPUT_COUNT);
  });

  it('ESTIMATOR-POSITIVE — a synthetic saw of known frequency reads back its own Hz', () => {
    for (const hz of [100, 48, 1, 0.0152415790275873]) {
      const got = sawHz(syntheticSaw(hz));
      expect(
        Math.abs(got / hz - 1),
        `synthetic saw ${hz} Hz read back as ${got.toExponential(6)} Hz (units: Hz)`,
      ).toBeLessThan(1e-6);
    }
  });

  it('ESTIMATOR-NEGATIVE — a constant buffer reads 0 Hz ("frozen" ≠ "never looked")', () => {
    const flat = new Float32Array(N).fill(-1);
    expect(sawHz(flat), 'a DC buffer must measure 0 Hz, not a plausible number').toBe(0);
  });

  it(
    'DETERMINISM — the render is bit-identical across two runs (#1680) before any number is believed',
    async () => {
      const p = patch({ rate: 100, shape: SAW });
      const a = await renderTaps(p);
      const b = await renderTaps(p);
      for (const id of PORTS) {
        expect(
          maxAbsDiff(a[id]!, b[id]!),
          `${id}: two renders of the same patch must be BIT-IDENTICAL (max |Δsample|, linear)`,
        ).toBe(0);
      }
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    'ABSOLUTE-POSITIVE — out1 runs at the RATE KNOB, in Hz, not merely 3× its neighbour',
    async () => {
      const bufs = await renderTaps(patch({ rate: 48, shape: SAW }));
      const got = sawHz(bufs[PORTS[0]!]!);
      expect(
        Math.abs(got / 48 - 1),
        `${PORTS[0]} at rate=48: measured ${got.toFixed(6)} Hz (units: Hz)`,
      ).toBeLessThan(1e-4);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    'THE LADDER — each declared port, in declaration order, runs at (1/3)^(n-1) of the first',
    async () => {
      const RATE = 100;
      const bufs = await renderTaps(patch({ rate: RATE, shape: SAW }));
      const hz = PORTS.map((id) => sawHz(bufs[id]!));

      // Every tap is strictly SLOWER than the one declared before it. This is
      // the assertion a reversed or shuffled factory map fails, and it is
      // stated over the DECLARED order rather than the worklet indices.
      for (let n = 1; n < PORTS.length; n++) {
        expect(
          hz[n]!,
          `${PORTS[n]} (${hz[n]!.toExponential(6)} Hz) must be slower than ` +
            `${PORTS[n - 1]} (${hz[n - 1]!.toExponential(6)} Hz) — units: Hz`,
        ).toBeLessThan(hz[n - 1]!);
      }

      // …and at exactly the rung the DSP CORE declares for it. Compared against
      // `NINE_LIVES_RATE_MULTIPLIERS` (the shipped ladder) AND against the
      // closed form independently: the first says the processor honours its own
      // table, the second says the table is the ⅓ ladder everything documents.
      for (let n = 0; n < PORTS.length; n++) {
        const fromDsp = RATE * NINE_LIVES_RATE_MULTIPLIERS[n]!;
        const closedForm = RATE * Math.pow(1 / 3, n);
        expect(
          Math.abs(hz[n]! / fromDsp - 1),
          `${PORTS[n]}: measured ${hz[n]!.toExponential(6)} Hz vs the DSP core's ` +
            `rung ${fromDsp.toExponential(6)} Hz (units: Hz)`,
        ).toBeLessThan(1e-4);
        expect(
          Math.abs(fromDsp / closedForm - 1),
          `${PORTS[n]}: the DSP core's rung must BE rate·(1/3)^${n} (units: Hz)`,
        ).toBeLessThan(1e-12);
      }
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    'SUBJECT-NEGATIVE — halving the RATE knob halves EVERY measured tap',
    async () => {
      const fast = await renderTaps(patch({ rate: 100, shape: SAW }));
      const slow = await renderTaps(patch({ rate: 50, shape: SAW }));
      for (const id of PORTS) {
        const f = sawHz(fast[id]!);
        const s = sawHz(slow[id]!);
        expect(
          Math.abs(s / f - 0.5),
          `${id}: rate 100 → ${f.toExponential(6)} Hz, rate 50 → ${s.toExponential(6)} Hz; ` +
            `ratio ${(s / f).toFixed(6)} must be 0.5 (units: Hz)`,
        ).toBeLessThan(1e-4);
      }
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    'SHAPE-NEGATIVE — the ladder is invariant to the WAVEFORM morph',
    async () => {
      // The rates are a property of the accumulators; `shape` only chooses what
      // is read off them. Measured through a DIFFERENT estimator (zero-up
      // crossings of a sine) so this leg cannot be greened by the saw path.
      const bufs = await renderTaps(patch({ rate: 100, shape: 0 }));
      const upCrossings = (x: Float32Array) => {
        let c = 0;
        for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 && x[i]! >= 0) c += 1;
        return c / DUR_S;
      };
      // Only the taps that complete ≥1 cycle in the window are countable, and
      // the count is window-boundary sensitive by ±1: `step()` advances BEFORE
      // it writes, so sample 0 already sits at phase `rate/sr` — just past the
      // rising zero — and that first crossing falls outside the buffer. So 100
      // cycles per second is read as 99 up-crossings. That is a property of the
      // counter, not of the module, and it is why this leg is a CROSS-CHECK on
      // the saw estimator rather than a second measurement of the same rank.
      for (const [n, expected] of [
        [0, 100],
        [1, 100 / 3],
      ] as const) {
        const c = upCrossings(bufs[PORTS[n]!]!);
        expect(
          Math.abs(c - expected),
          `${PORTS[n]}: ${c} sine up-crossings/s vs ${expected.toFixed(4)} expected ` +
            `(units: cycles/s; ±1 is the window boundary, see above)`,
        ).toBeLessThanOrEqual(1);
      }
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    'RESET re-zeroes EVERY declared tap on one rising edge, through the declared gate port',
    async () => {
      const RATE = 100;
      const at = Math.round(N / 2);
      const free = await renderTaps(patch({ rate: RATE, shape: SAW }));
      const sync = await renderTaps(patch({ rate: RATE, shape: SAW }), { resetAtSample: at });

      for (const id of PORTS) {
        // Before the edge the two renders are the SAME signal — the control
        // that says the reset cable changed nothing it should not have.
        let pre = 0;
        for (let i = 0; i < at - 1; i++) pre = Math.max(pre, Math.abs(free[id]![i]! - sync[id]![i]!));
        expect(pre, `${id}: pre-edge max |Δsample| (linear) must be 0`).toBe(0);

        // The sample AFTER the edge sits one increment past phase 0 (the LFO
        // hard-sync convention the core documents), so the saw reads −1 + 2·inc.
        const inc = (RATE * Math.pow(1 / 3, PORTS.indexOf(id))) / SR;
        expect(
          sync[id]![at]!,
          `${id}: first sample after the reset edge must be −1 + 2·(rate_n/sr) = ` +
            `${(-1 + 2 * inc).toExponential(6)} (units: linear sample)`,
        ).toBeCloseTo(-1 + 2 * inc, 6);
      }

      // …and the SLOWEST tap is the one a phase-blind check would miss: it is
      // near-DC, so "did anything happen" needs the jump, not the level.
      const last = PORTS[PORTS.length - 1]!;
      const jump = Math.abs(sync[last]![at]! - sync[last]![at - 1]!);
      expect(
        jump,
        `${last}: the reset must be visible on the SLOWEST tap too — jump ${jump.toExponential(6)} (linear)`,
      ).toBeGreaterThan(0.01);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "LFO PARITY — out1 is bit-identical to the LFO only at the LFO's DEFAULT depth",
    async () => {
      // The def, the DSP core header and `docs` all say out1 is "identical to a
      // normal LFO". Measured: TRUE at the LFO's shipped `depth` default and
      // FALSE anywhere else, because the LFO scales its output by `depth·2`
      // (lfo.ts) and NINE LIVES has no depth control at all.
      const lfoOut = async (depth: number): Promise<Float32Array> => {
        const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
        const params: Record<string, number> = {};
        for (const p of lfoDef.params) params[p.id] = p.defaultValue;
        params.rate = 100;
        params.shape = SAW;
        params.depth = depth;
        const node = { id: 'lfo-ref', type: 'lfo', position: { x: 0, y: 0 }, params } as never;
        const handle = await lfoDef.factory(ctx as unknown as AudioContext, node);
        const o = handle.outputs.get(lfoDef.outputs[0]!.id)!;
        o.node.connect(ctx.destination, o.output);
        return (await ctx.startRendering()).getChannelData(0).slice();
      };

      const mine = (await renderTaps(patch({ rate: 100, shape: SAW })))[PORTS[0]!]!;
      const depthDef = lfoDef.params.find((p) => p.id === 'depth')!;

      expect(
        maxAbsDiff(mine, await lfoOut(depthDef.defaultValue)),
        `out1 vs LFO at its default depth ${depthDef.defaultValue}: max |Δsample| (linear) must be 0`,
      ).toBe(0);

      // The negative control on that claim: at full depth the LFO is 2× and the
      // two are NOT the same signal. Without this leg, "identical" would be
      // indistinguishable from "identical at every setting".
      const d = maxAbsDiff(mine, await lfoOut(depthDef.max));
      expect(
        d,
        `out1 vs LFO at depth ${depthDef.max}: max |Δsample| (linear) = ${d.toFixed(6)} — must NOT be 0`,
      ).toBeGreaterThan(0.9);
    },
    RENDER_TIMEOUT_MS,
  );
});
