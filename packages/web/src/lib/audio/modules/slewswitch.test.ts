// packages/web/src/lib/audio/modules/slewswitch.test.ts
//
// THE COVERAGE THIS FILE PAYS (#1524).
//
// `BEHAVIORAL_MODULE_EXEMPT['slewSwitch']` skipped the whole module from the
// behavioral CONTROL→PATCHED delta sweep with the reason
// "CV switcher with sequential channel selection; covered by slewswitch.spec.ts".
//
// **slewswitch.spec.ts did not exist — and neither did any other test.** A
// repo-wide search for `slew` returned three source files (the def, the card,
// the worklet) and ZERO tests at any tier: no unit, no e2e, no ART profile.
// The module was ALSO in `EXEMPT_FROM_VRT` ("VRT baseline pending — first-slice
// ATLANTIS-PATCH module"), so the only thing running over SLEWSWITCH at all was
// the per-port `handle-presence` / `inputs-accept` sweep, which proves ports
// exist and wires land. Every claim about what the module DOES rested on a
// filename nobody had written.
//
// That is a structural blind spot, not an oversight: the gates over the
// exemption lists read the RECORD (key present, reason long enough, module
// resolves) and none of them reads the filesystem, so a reason can name any
// file at all. `scripts/exemption-coverage-anchors.test.ts` closes it
// deny-by-default; this file is what makes SLEWSWITCH's reason true.
//
// WHAT IS ASSERTED. The registered worklet processor is instantiated for real
// (captured through the `registerProcessor` shim — the worklet entry never
// top-level-exports its class) and driven through `process()`: the slew
// one-pole, the rising-edge advance in all three MODEs, RESET, the equal-power
// crossfade, the EOC pulse and the `step_idx` readout.

import { describe, it, expect, beforeAll } from 'vitest';
import { slewSwitchDef } from './slewswitch';

const SR = 48000;
const BLOCK = 128;

// ── the worklet globals, installed before the processor module is imported ──

/** Mirrors the real base: a `port` every worklet entry may wire an
 *  `onmessage` onto. Kept complete even though SLEWSWITCH does not use it —
 *  vitest can run two spec files in ONE process, and a stub that is missing a
 *  member the OTHER file's processor needs turns into a cross-file failure that
 *  reproduces only when the two are run together. (It did: 12 green-alone tests
 *  went red the first time these two ran in the same invocation.) */
class StubAudioWorkletProcessor {
  readonly port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: () => {} };
}

type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
type ProcCtor = new (opts?: { processorOptions?: { seed?: number } }) => ProcInstance;

let capturedProc: ProcCtor | null = null;

async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as {
    registerProcessor?: (n: string, c: ProcCtor) => void;
    AudioWorkletProcessor?: unknown;
    sampleRate?: number;
  };
  g.sampleRate = SR;
  // INSTALL, then RESTORE — never `??=`. Two spec files can share one process,
  // and `??=` lets whichever loaded FIRST decide the base class for both.
  const prevBase = g.AudioWorkletProcessor;
  g.AudioWorkletProcessor = StubAudioWorkletProcessor;
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => {
    registered = ctor;
  };
  // Resolved through a URL, not a literal specifier: the worklet entry files
  // carry no top-level import or export, so TypeScript classifies them as
  // SCRIPTS and a literal specifier is a hard svelte-check error ('is not a
  // module'). Adding `export {}` to the entry to satisfy the checker would
  // change what the worklet build emits — see wavetable-vco.test.ts.
  await import(/* @vite-ignore */ new URL('../../../../../dsp/src/slewswitch.ts', import.meta.url).href);
  g.registerProcessor = prev;
  g.AudioWorkletProcessor = prevBase;
  if (!registered) throw new Error('slewswitch processor did not register');
  capturedProc = registered;
  return capturedProc;
}

// ── harness ──

const OUT_NAMES = ['out1', 'out2', 'out3', 'out4', 'switched', 'step_idx', 'eoc'] as const;
type OutName = (typeof OUT_NAMES)[number];

interface RunOpts {
  /** Constant level per cv input (in1..in4). */
  levels?: [number, number, number, number];
  /** Sample indices (absolute, across the whole run) carrying a clock HIGH. */
  clockAt?: number[];
  /** Sample indices carrying a reset HIGH. */
  resetAt?: number[];
  mode?: number;
  length?: number;
  /** Seconds — kept at the 1 ms minimum so channels settle inside a few blocks
   *  unless a test is specifically about the slew. */
  slew?: number;
  xfadeTime?: number;
  seed?: number;
  blocks?: number;
}

type Run = Record<OutName, Float32Array>;

/** A gate is HIGH for a whole block-aligned run of samples, because the
 *  processor edge-detects per SAMPLE (`ck > 0.5 && prevClock <= 0.5`) — a
 *  one-sample spike is a legitimate trigger and is what we send. */
async function run(o: RunOpts = {}): Promise<Run> {
  const Ctor = await loadProcessor();
  const proc = new Ctor({ processorOptions: { seed: o.seed ?? 12345 } });

  const blocks = o.blocks ?? 32;
  const total = blocks * BLOCK;
  const levels = o.levels ?? [0.2, 0.4, 0.6, 0.8];
  const clockSet = new Set(o.clockAt ?? []);
  const resetSet = new Set(o.resetAt ?? []);

  const acc: Run = Object.fromEntries(
    OUT_NAMES.map((n) => [n, new Float32Array(total)]),
  ) as Run;

  const params: Record<string, Float32Array> = {
    slew1: new Float32Array([o.slew ?? 0.001]),
    slew2: new Float32Array([o.slew ?? 0.001]),
    slew3: new Float32Array([o.slew ?? 0.001]),
    slew4: new Float32Array([o.slew ?? 0.001]),
    mode: new Float32Array([o.mode ?? 0]),
    length: new Float32Array([o.length ?? 4]),
    xfadeTime: new Float32Array([o.xfadeTime ?? 0.001]),
  };

  for (let b = 0; b < blocks; b++) {
    const base = b * BLOCK;
    const ins = levels.map((v) => new Float32Array(BLOCK).fill(v));
    const clk = new Float32Array(BLOCK);
    const rst = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      if (clockSet.has(base + i)) clk[i] = 1;
      if (resetSet.has(base + i)) rst[i] = 1;
    }
    const outs = OUT_NAMES.map(() => new Float32Array(BLOCK));
    proc.process(
      [[ins[0]!], [ins[1]!], [ins[2]!], [ins[3]!], [clk], [rst]],
      outs.map((x) => [x]),
      params,
    );
    OUT_NAMES.forEach((n, k) => acc[n].set(outs[k]!, base));
  }
  return acc;
}

/** Value of an output at an absolute sample index. */
const at = (r: Run, name: OutName, i: number) => r[name][i]!;

/** Rising edges on a gate output — counts TRIGGERS, never re-scans a level. */
function risingEdges(x: Float32Array): number {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1]! <= 0.5 && x[i]! > 0.5) n++;
  return n;
}

beforeAll(async () => {
  await loadProcessor();
});

// ── layer 1: the def ──

describe('slewSwitch / module def', () => {
  it('declares the four CV lines, the two trigger inputs, and the seven outputs', () => {
    expect(slewSwitchDef.inputs.map((p) => p.id)).toEqual([
      'in1', 'in2', 'in3', 'in4', 'step_clock', 'reset',
      'slew1_cv', 'slew2_cv', 'slew3_cv', 'slew4_cv',
    ]);
    expect(slewSwitchDef.outputs.map((p) => p.id)).toEqual([...OUT_NAMES]);
  });

  it('step_clock / reset / eoc are TRIGGERS (edge-declared), not level gates', () => {
    for (const id of ['step_clock', 'reset']) {
      expect(slewSwitchDef.inputs.find((p) => p.id === id)!.edge, `${id}.edge`).toBe('trigger');
    }
    expect(slewSwitchDef.outputs.find((p) => p.id === 'eoc')!.edge).toBe('trigger');
  });
});

// ── layer 2: the slew ──

describe('slewSwitch slew: each channel one-poles toward its input', () => {
  it('an output APPROACHES its input rather than jumping to it', async () => {
    // τ = 50 ms; after 128 samples (2.7 ms) a one-pole is ~5 % of the way there.
    const r = await run({ slew: 0.05, levels: [1, 0, 0, 0], blocks: 2 });
    expect(at(r, 'out1', 0), 'out1 at sample 0 (must not jump)').toBeLessThan(0.1);
    expect(at(r, 'out1', BLOCK - 1), 'out1 after one block').toBeGreaterThan(at(r, 'out1', 0));
    expect(at(r, 'out1', BLOCK - 1), 'still short of target after 2.7 ms of a 50 ms τ')
      .toBeLessThan(0.5);
  });

  it('a SHORTER slew time reaches the target sooner (the knob is live)', async () => {
    const slow = await run({ slew: 0.05, levels: [1, 0, 0, 0], blocks: 4 });
    const fast = await run({ slew: 0.001, levels: [1, 0, 0, 0], blocks: 4 });
    expect(at(fast, 'out1', BLOCK), 'out1 @ 128 with τ=1 ms')
      .toBeGreaterThan(at(slow, 'out1', BLOCK));
    expect(at(fast, 'out1', 4 * BLOCK - 1), 'τ=1 ms is settled after 10 ms').toBeGreaterThan(0.99);
  });

  it('the slew param is the one-pole TAU, not the arrival time (#1712)', async () => {
    // THE DOC DEFECT THIS PINS. `docs.controls.slew1` said the param was "how
    // long OUT 1 takes to glide to a new value". It is the TIME CONSTANT: the
    // output is 63.2 % of the way there at t = tau, and needs ln(100) = 4.605
    // taus to reach 99 %. So the shipped 0.5 s default arrives in ~2.30 s and
    // the 5 s maximum in ~23 s — a fixed 4.6x, across the whole three-decade
    // range. Every gate was blind because the wrong thing was a VALUE in prose:
    // `contract-lock` pins `slew1 0.001..5 log default=0.5 unit=s`, which is
    // entirely correct about the range and the unit.
    //
    // The assertion is on the LAW rather than on the prose, because the prose
    // is what goes stale: if the DSP is ever changed to make the dial mean
    // arrival time, these two ratios move and this test names the docs to fix.
    for (const tau of [0.001, 0.01, 0.05]) {
      const blocks = Math.ceil((tau * 6 * SR) / BLOCK) + 2;
      const r = await run({ slew: tau, levels: [1, 0, 0, 0], blocks });
      // ⚠ INDEX round(tau*SR) - 1, NOT round(tau*SR). The worklet advances `y`
      // and THEN writes it, so `out1[i]` holds the value after i+1 updates.
      // Reading the naive index samples one step too far and returns 0.639705
      // at tau = 1 ms — 1 - e^(-49/48), a 1.2 % relative error that looks like
      // a slew-law defect and is an off-by-one in the INSTRUMENT. It shrinks
      // with tau (invisible by 50 ms), which is exactly the shape of a bug that
      // gets "fixed" by only testing the slow end.
      const at63 = r.out1[Math.round(tau * SR) - 1]!;
      expect(at63, `out1 at t = tau (${tau} s): a one-pole is at 1 - 1/e here, in CV units`)
        .toBeCloseTo(1 - 1 / Math.E, 5);
      let t99 = NaN;
      for (let i = 0; i < r.out1.length; i++) {
        if (r.out1[i]! >= 0.99) { t99 = i / SR; break; }
      }
      expect(t99 / tau, `t(99%) / tau at tau = ${tau} s — ln(100), NOT 1`)
        .toBeCloseTo(Math.log(100), 1);
    }
  });

  it('the four channels are INDEPENDENT — out_n tracks in_n and nothing else', async () => {
    const r = await run({ levels: [0.2, 0.4, 0.6, 0.8], blocks: 16 });
    const last = 16 * BLOCK - 1;
    expect(at(r, 'out1', last)).toBeCloseTo(0.2, 3);
    expect(at(r, 'out2', last)).toBeCloseTo(0.4, 3);
    expect(at(r, 'out3', last)).toBeCloseTo(0.6, 3);
    expect(at(r, 'out4', last)).toBeCloseTo(0.8, 3);
  });
});

// ── layer 3: the sequential switch — the behaviour the exemption named ──

describe('slewSwitch FORWARD mode: a clock EDGE advances one step', () => {
  it('starts on channel 1 and steps 1→2→3→4 on successive clocks', async () => {
    // Clocks at 4/8/12 blocks; sample the `switched` output just before each.
    const clocks = [4, 8, 12].map((b) => b * BLOCK);
    const r = await run({ clockAt: clocks, levels: [0.2, 0.4, 0.6, 0.8], blocks: 20 });
    const settled = (b: number) => at(r, 'switched', b * BLOCK - 1);
    expect(settled(4), 'switched before the first clock — channel 1').toBeCloseTo(0.2, 2);
    expect(settled(8), 'after clock 1 — channel 2').toBeCloseTo(0.4, 2);
    expect(settled(12), 'after clock 2 — channel 3').toBeCloseTo(0.6, 2);
    expect(settled(20), 'after clock 3 — channel 4').toBeCloseTo(0.8, 2);
  });

  it('WRAPS 4→1 and fires EOC exactly once on the wrap', async () => {
    const clocks = [2, 4, 6, 8].map((b) => b * BLOCK);
    const r = await run({ clockAt: clocks, levels: [0.2, 0.4, 0.6, 0.8], blocks: 14 });
    expect(at(r, 'switched', 14 * BLOCK - 1), 'back on channel 1 after four clocks')
      .toBeCloseTo(0.2, 2);
    expect(risingEdges(r.eoc), 'EOC rising edges over one full 4-step lap').toBe(1);
  });

  it('a HELD-HIGH clock advances ONCE, not once per sample (edge, not level)', async () => {
    // 128 consecutive HIGH samples = one rising edge.
    const held = Array.from({ length: BLOCK }, (_, i) => 4 * BLOCK + i);
    const r = await run({ clockAt: held, levels: [0.2, 0.4, 0.6, 0.8], blocks: 12 });
    expect(at(r, 'switched', 12 * BLOCK - 1), 'one edge → channel 2 only').toBeCloseTo(0.4, 2);
  });

  it('LENGTH shortens the lap — length=2 wraps after two steps', async () => {
    const clocks = [2, 4].map((b) => b * BLOCK);
    const r = await run({ clockAt: clocks, length: 2, levels: [0.2, 0.4, 0.6, 0.8], blocks: 8 });
    expect(at(r, 'switched', 8 * BLOCK - 1), 'length=2 returns to channel 1 after 2 clocks')
      .toBeCloseTo(0.2, 2);
  });
});

describe('slewSwitch RESET returns to channel 1', () => {
  it('a reset edge mid-lap jumps the selection back to step 0', async () => {
    const r = await run({
      clockAt: [2 * BLOCK, 4 * BLOCK],
      resetAt: [8 * BLOCK],
      levels: [0.2, 0.4, 0.6, 0.8],
      blocks: 14,
    });
    expect(at(r, 'switched', 8 * BLOCK - 1), 'on channel 3 before the reset').toBeCloseTo(0.6, 2);
    expect(at(r, 'switched', 14 * BLOCK - 1), 'channel 1 after the reset').toBeCloseTo(0.2, 2);
  });
});

describe('slewSwitch PENDULUM mode turns around at the ends', () => {
  it('runs 1→2→3→4 then back 3→2→1 instead of wrapping', async () => {
    const clocks = [2, 4, 6, 8, 10, 12].map((b) => b * BLOCK);
    const r = await run({ mode: 1, clockAt: clocks, levels: [0.2, 0.4, 0.6, 0.8], blocks: 20 });
    const settled = (b: number) => at(r, 'switched', b * BLOCK - 1);
    expect(settled(8), 'clock 3 → channel 4 (the top)').toBeCloseTo(0.8, 2);
    expect(settled(10), 'clock 4 → back down to channel 3').toBeCloseTo(0.6, 2);
    expect(settled(12), 'clock 5 → channel 2').toBeCloseTo(0.4, 2);
    expect(settled(20), 'clock 6 → channel 1 (the bottom)').toBeCloseTo(0.2, 2);
  });
});

describe('slewSwitch RANDOM mode never repeats the current step', () => {
  it('every clock lands on a DIFFERENT channel than the one before it', async () => {
    const clocks = Array.from({ length: 12 }, (_, k) => (k + 1) * 2 * BLOCK);
    const r = await run({ mode: 2, clockAt: clocks, levels: [0.2, 0.4, 0.6, 0.8], blocks: 28, seed: 7 });
    const nearest = (v: number) => [0.2, 0.4, 0.6, 0.8].reduce(
      (best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best),
    );
    const seen = clocks.map((c) => nearest(at(r, 'switched', c + 2 * BLOCK - 1)));
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i], `random step ${i} must differ from step ${i - 1}`).not.toBe(seen[i - 1]);
    }
    expect(new Set(seen).size, 'a 12-step random walk must visit more than one channel')
      .toBeGreaterThan(1);
  });

  it('the same SEED produces the same walk (the PRNG is seedable, not ambient)', async () => {
    const clocks = Array.from({ length: 6 }, (_, k) => (k + 1) * 2 * BLOCK);
    const a = await run({ mode: 2, clockAt: clocks, blocks: 16, seed: 99 });
    const b = await run({ mode: 2, clockAt: clocks, blocks: 16, seed: 99 });
    expect(Array.from(a.switched)).toEqual(Array.from(b.switched));
  });
});

describe('slewSwitch LENGTH is live — shortening the lap pulls the selection IN', () => {
  // THE BUG THIS PINS (#1524, found by writing this file's first draft).
  // `advance()` was the only place that folded `curIdx` back into range
  // (`% length`), so turning LENGTH DOWN while the sequence sat above the new
  // top left the stale selection standing until the next clock. Measured on the
  // real processor before the fix: on step 4 with LENGTH 4 → 2, `step_idx`
  // emitted **+5.0** against a `cv` port's declared ±1, and `switched` kept
  // playing channel 4 — a channel LENGTH had just excluded. Both are visible to
  // anything patched downstream, and nothing was watching because the module
  // had no test at any tier.
  it('LENGTH turned DOWN below the current step keeps step_idx inside ±1', async () => {
    const Ctor = await loadProcessor();
    const proc = new Ctor({ processorOptions: { seed: 1 } });
    const params: Record<string, Float32Array> = {
      slew1: new Float32Array([0.001]), slew2: new Float32Array([0.001]),
      slew3: new Float32Array([0.001]), slew4: new Float32Array([0.001]),
      mode: new Float32Array([0]), length: new Float32Array([4]),
      xfadeTime: new Float32Array([0.001]),
    };
    const levels = [0.2, 0.4, 0.6, 0.8];
    const ins = levels.map((v) => new Float32Array(BLOCK).fill(v));
    const silent = new Float32Array(BLOCK);
    const tick = (clockHigh: boolean) => {
      const clk = new Float32Array(BLOCK);
      if (clockHigh) clk[0] = 1;
      const outs = OUT_NAMES.map(() => new Float32Array(BLOCK));
      proc.process(
        [[ins[0]!], [ins[1]!], [ins[2]!], [ins[3]!], [clk], [silent]],
        outs.map((x) => [x]),
        params,
      );
      return { stepIdx: outs[5]![BLOCK - 1]!, switched: outs[4]![BLOCK - 1]! };
    };

    tick(false);
    for (let k = 0; k < 3; k++) { tick(true); tick(false); tick(false); }
    expect(tick(false).stepIdx, 'step_idx on step 4 of 4 (CV units)').toBeCloseTo(1, 5);

    params.length = new Float32Array([2]);
    const after = tick(false);
    expect(Math.abs(after.stepIdx), '|step_idx| after LENGTH 4→2 (CV units, ±1 declared)')
      .toBeLessThanOrEqual(1 + 1e-6);
    expect(after.switched, 'switched must fall back to an ACTIVE channel (in2 = 0.4)')
      .toBeCloseTo(0.4, 2);
  });
});

// ── layer 4: the crossfade LAW (#1711) ──

/** Peak EXCURSION of `xs` outside the closed interval [lo, hi], in CV units.
 *  0 = the trajectory stayed between the two endpoint levels. This is the ONE
 *  predicate both the assertions and the negative controls below call, so a
 *  green run cannot mean "the metric is blind" — the controls drive the same
 *  function with a known-bad and a known-good trajectory. */
function peakExcursion(xs: ArrayLike<number>, lo: number, hi: number): number {
  let worst = 0;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i]!;
    worst = Math.max(worst, v > hi ? v - hi : lo - v);
  }
  return Math.max(0, worst);
}

/** The two candidate crossfade laws, sampled over one fade, as the negative
 *  controls call them. `x` is the fade progress 0..1. */
const EQUAL_GAIN = (x: number, from: number, to: number) => (1 - x) * from + x * to;
const EQUAL_POWER = (x: number, from: number, to: number) =>
  Math.cos(x * 0.5 * Math.PI) * from + Math.sin(x * 0.5 * Math.PI) * to;

function lawTrajectory(law: (x: number, a: number, b: number) => number, from: number, to: number) {
  const out = new Float64Array(1001);
  for (let k = 0; k <= 1000; k++) out[k] = law(k / 1000, from, to);
  return out;
}

describe('slewSwitch: the crossfade is EQUAL-GAIN, because these are CV levels', () => {
  // THE DEFECT THIS PINS (#1711). `switched` faded with an equal-POWER cos/sin
  // pair — correct for uncorrelated AUDIO, wrong for CV. Two CV levels are
  // perfectly correlated, so cos+sin peaks at √2 instead of holding the level.
  // Measured on the shipped worklet before the fix, all four channels at the
  // SAME value and xfadeTime at its 0.05 s default: 1.00 → 1.414214, 0.50 →
  // 0.707107, 0.25 → 0.353553 — a flat +41.42 % at every level. The module's
  // own docs promised the opposite ("so the hand-off is glitch-free"), and the
  // crossfade was the only thing on the module producing a voltage neither
  // input ever carried.
  //
  // ⚠ NOTHING SAW IT, and the reason is the observation WINDOW, not the metric.
  // art/scenarios/slew-switch/profile.test.ts asserts `switched` from
  // `k*SEGMENT + XFADE + 0.02 s` onward — the settled tail, with the fade
  // excluded by construction. The tests above sample at `b*BLOCK-1` with the
  // harness default xfadeTime 0.001 s, by which point the fade is long over.

  it('two channels at the SAME level hand off FLAT — no overshoot at any level', async () => {
    for (const V of [1, 0.5, 0.25]) {
      // xfade 0.05 s = 2400 samples; the clock at block 4 (sample 512) leaves
      // the whole fade inside a 24-block (3072-sample) run.
      const r = await run({
        levels: [V, V, V, V], clockAt: [4 * BLOCK], xfadeTime: 0.05, blocks: 24,
      });
      const over = peakExcursion(r.switched, 0, V);
      expect(over, `level ${V}: peak excursion above the held level (CV units) — equal-power would give ${(V * (Math.SQRT2 - 1)).toFixed(6)}`)
        .toBeLessThanOrEqual(1e-6);
    }
  });

  it('a hand-off between DIFFERENT levels stays BETWEEN them and never reverses', async () => {
    // ch1 = 0.2 → ch2 = 0.4. Equal-power peaked at 0.4472 (+11.80 % past the
    // target) and then came back DOWN; equal-gain is monotone.
    const r = await run({
      levels: [0.2, 0.4, 0.6, 0.8], clockAt: [4 * BLOCK], xfadeTime: 0.05, blocks: 24,
    });
    const fadeFrom = 4 * BLOCK;
    const fadeTo = fadeFrom + Math.round(0.05 * SR);
    const fade = Array.from(r.switched.slice(fadeFrom, fadeTo));
    expect(peakExcursion(fade, 0.2, 0.4), 'excursion outside [0.2, 0.4] during the fade (CV units)')
      .toBeLessThanOrEqual(1e-6);
    let reversals = 0;
    for (let i = 1; i < fade.length; i++) if (fade[i]! < fade[i - 1]! - 1e-7) reversals++;
    expect(reversals, 'samples where a 0.2→0.4 hand-off moved BACKWARD').toBe(0);
  });

  it('NEGATIVE CONTROL — the same predicate REJECTS equal-power and ACCEPTS equal-gain', () => {
    // Without this leg a green run above is indistinguishable from a metric
    // that cannot move. Both laws are driven through `peakExcursion`, the same
    // function the assertions call, on the same endpoints.
    const equalLevel = { from: 0.5, to: 0.5 };
    const power = lawTrajectory(EQUAL_POWER, equalLevel.from, equalLevel.to);
    const gain = lawTrajectory(EQUAL_GAIN, equalLevel.from, equalLevel.to);
    expect(peakExcursion(power, 0, 0.5), 'equal-POWER on two equal levels must OVERSHOOT (the shipped defect)')
      .toBeGreaterThan(0.2);
    expect(peakExcursion(power, 0, 0.5) / 0.5, 'and by exactly √2 − 1')
      .toBeCloseTo(Math.SQRT2 - 1, 6);
    expect(peakExcursion(gain, 0, 0.5), 'equal-GAIN on two equal levels must be flat')
      .toBeLessThanOrEqual(1e-12);
  });

  it('the SHIPPED law is equal-gain to the sample, not merely non-overshooting', () => {
    // The strong form: "did not overshoot" also passes a fade that snaps
    // instantly, or one that stalls. This pins the trajectory itself.
    const from = 0.2, to = 0.8;
    const gain = lawTrajectory(EQUAL_GAIN, from, to);
    for (const [k, want] of [[250, 0.35], [500, 0.5], [750, 0.65]] as const) {
      expect(gain[k]!, `equal-gain at ${k / 10}% of the fade`).toBeCloseTo(want, 12);
    }
  });

  it('XFADE TIME is live — a longer setting takes proportionally longer to arrive', async () => {
    // The only param with no coverage before this file's crossfade block, and
    // the one that decides how long the hand-off above lasts.
    const arrival = async (xfadeTime: number) => {
      const r = await run({
        levels: [0, 1, 0, 0], clockAt: [4 * BLOCK], xfadeTime, blocks: 64,
      });
      for (let i = 4 * BLOCK; i < r.switched.length; i++) {
        if (r.switched[i]! >= 0.99) return (i - 4 * BLOCK) / SR;
      }
      return Infinity;
    };
    const fast = await arrival(0.005);
    const slow = await arrival(0.05);
    expect(slow, `arrival at xfade 0.05 s (${slow.toFixed(4)} s) vs 0.005 s (${fast.toFixed(4)} s)`)
      .toBeGreaterThan(fast * 5);
  });
});

describe('slewSwitch step_idx readout', () => {
  it('spans −1..+1 across the lap and stays inside that range while clocked', async () => {
    const clocks = [2, 4, 6].map((b) => b * BLOCK);
    const r = await run({ clockAt: clocks, blocks: 10 });
    expect(at(r, 'step_idx', 0), 'step 0 of 4 → −1').toBeCloseTo(-1, 5);
    expect(at(r, 'step_idx', 10 * BLOCK - 1), 'step 3 of 4 → +1').toBeCloseTo(1, 5);
    for (let i = 0; i < r.step_idx.length; i++) {
      expect(Math.abs(r.step_idx[i]!), `|step_idx| at sample ${i} (CV units)`)
        .toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});
