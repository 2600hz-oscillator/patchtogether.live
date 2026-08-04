// packages/dsp/src/lib/cube-envelope.test.ts
//
// CUBE's amp ADSR did NOTHING at the shipped default — the identical defect
// #1350 fixed in WAVECEL, flagged in that PR's blast-radius section and
// deliberately scoped out because CUBE is a second module, not one fix. Pinned
// here by the numbers that found it, each with a negative control that runs on
// EVERY invocation.
//
// Everything here drives the REAL cube worklet through a registerProcessor shim,
// because the defect is only visible at the level of the assembled processor:
// the AudioParam DEFAULTS, and the raw-VCO branch. Both the GATED-MONO (TRIG)
// and the POLY path are exercised — they are separate branches of process() and
// the defect was live in both.
//
// WHY NOTHING CAUGHT IT
//   `poly-osc-sum.test.ts` pins `vcaGain(base, env) = base + (1−base)·env` and
//   every one of its assertions is CORRECT. The arithmetic was never wrong — the
//   DEFAULT was. A helper test that supplies its own inputs is structurally blind
//   to the value the module actually ships with, and nothing joined the helper to
//   the `defaultValue` in the descriptor. `cube.test.ts` drove the gated paths
//   with an EXPLICIT `base_vol: 0` in every case that asserted the envelope did
//   anything, so it never once rendered CUBE the way a user gets it. This file
//   asserts the descriptor itself and renders at the shipped defaults.

import { describe, it, expect, beforeAll } from 'vitest';

const SR = 48000;
const BLOCK = 128;
const COLS = 256;
const FRAMES = 64;
const POLY_CH = 10;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
};
type ProcCtor = new () => ProcInstance;
let capturedProc: ProcCtor | null = null;
let capturedDescriptors: { name: string; defaultValue: number }[] | null = null;

async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  await import('../cube');
  g.registerProcessor = prev;
  if (!registered) throw new Error('cube processor did not register');
  capturedProc = registered;
  capturedDescriptors = (registered as unknown as {
    parameterDescriptors: { name: string; defaultValue: number }[];
  }).parameterDescriptors;
  return capturedProc;
}

/** Three DIFFERENT synthetic tables (deterministic, machine-independent) so the
 *  FLOOR/WALL/CEILING field — and therefore the sliced waveform — is non-trivial
 *  and the module actually makes a sound to shape. */
function table(harmonic: number, scale: number): number[][] {
  const t: number[][] = [];
  for (let f = 0; f < FRAMES; f++) {
    const row = new Array<number>(COLS);
    for (let c = 0; c < COLS; c++) {
      row[c] = scale * Math.sin((2 * Math.PI * harmonic * c) / COLS) * (0.5 + (0.5 * f) / FRAMES);
    }
    t.push(row);
  }
  return t;
}

interface RenderOpts {
  /** Samples for which the mono TRIGGER gate is high (from sample 0). */
  gateSamples?: number;
  /** Samples for which POLY lane 0's gate is high (from sample 0). */
  polyGateSamples?: number;
}

/**
 * Render n samples of the REAL worklet. Knobs default to the processor's OWN
 * `parameterDescriptors` defaults — the shipped state is the thing under test,
 * so a test only names the knobs it deliberately moves.
 */
async function render(
  n: number,
  over: Record<string, number> = {},
  opt: RenderOpts = {},
): Promise<{ L: Float32Array; R: Float32Array }> {
  const Proc = await loadProcessor();
  const p = new Proc();
  p.port.onmessage!({ data: { type: 'loadWavetable', slot: 'floor', frames: table(1, 0.9) } });
  p.port.onmessage!({ data: { type: 'loadWavetable', slot: 'wall', frames: table(3, 0.7) } });
  p.port.onmessage!({ data: { type: 'loadWavetable', slot: 'ceiling', frames: table(5, 0.8) } });

  const knobs: Record<string, number> = {};
  for (const d of capturedDescriptors!) knobs[d.name] = d.defaultValue;
  Object.assign(knobs, over);
  const params: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(knobs)) params[k] = new Float32Array([v]);

  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const poly: Float32Array[] = Array.from({ length: POLY_CH }, () => new Float32Array(BLOCK));
  const pitch = new Float32Array(BLOCK);
  const trig = new Float32Array(BLOCK);
  const oL = new Float32Array(BLOCK);
  const oR = new Float32Array(BLOCK);
  for (let b = 0; b < n; b += BLOCK) {
    // Gates are sampled at the FIRST sample of each block by the worklet, so a
    // block-granular fill is exact for its edge detection.
    if (opt.gateSamples !== undefined) trig.fill(b < opt.gateSamples ? 1 : 0);
    if (opt.polyGateSamples !== undefined) poly[1]!.fill(b < opt.polyGateSamples ? 1 : 0);
    oL.fill(0);
    oR.fill(0);
    p.process([[pitch], poly, [trig]], [[oL, oR]], params);
    const take = Math.min(BLOCK, n - b);
    L.set(oL.subarray(0, take), b);
    R.set(oR.subarray(0, take), b);
  }
  return { L, R };
}

const rms = (a: Float32Array): number => {
  let s = 0;
  for (const v of a) s += v * v;
  return Math.sqrt(s / Math.max(1, a.length));
};
const db = (x: number): number => 20 * Math.log10(Math.max(1e-12, x));
const peak = (a: Float32Array): number => {
  let m = 0;
  for (const v of a) m = Math.max(m, Math.abs(v));
  return m;
};
const maxAbsDiff = (a: Float32Array, b: Float32Array): number => {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
};
/** ms until the 64-sample peak envelope first reaches 90 % of the render's own
 *  peak. Renderer-independent: it counts SAMPLES, converted to ms for the
 *  message. */
function riseTo90Ms(a: Float32Array): number {
  const W = 64;
  let pk = 0;
  const env: number[] = [];
  for (let i = 0; i + W <= a.length; i += W) {
    let m = 0;
    for (let j = i; j < i + W; j++) m = Math.max(m, Math.abs(a[j]!));
    env.push(m);
    pk = Math.max(pk, m);
  }
  for (let i = 0; i < env.length; i++) if (env[i]! >= 0.9 * pk) return ((i * W) / SR) * 1000;
  return Infinity;
}
/** Largest sample-to-sample step in [from, to). */
function maxStep(a: Float32Array, from: number, to: number): number {
  let m = 0;
  for (let i = Math.max(1, from); i < Math.min(a.length, to); i++) {
    m = Math.max(m, Math.abs(a[i]! - a[i - 1]!));
  }
  return m;
}

// ===========================================================================
// THE AMP ADSR ACTUALLY SHAPES A NOTE AT THE SHIPPED DEFAULT
// ===========================================================================
describe('CUBE · the amp ADSR is audible at the shipped default', () => {
  it('base_vol SHIPS at 0 (pure ADSR) — the descriptor is the thing under test', async () => {
    await loadProcessor();
    const d = capturedDescriptors!.find((x) => x.name === 'base_vol');
    expect(
      d?.defaultValue,
      'base_vol shipped at 1, which makes gain = 1 + 0·env — the whole A/D/S/R a no-op',
    ).toBe(0);
  });

  it('MONO/TRIG · ATTACK changes the rise (it was IDENTICAL at 1 ms and 2 s)', async () => {
    // Measured before the fix: 1.33 ms at BOTH ATTACK 0.001 s and ATTACK 2 s.
    const fast = await render(SR, { attack: 0.001, trigger_connected: 1 }, { gateSamples: SR });
    const slow = await render(SR, { attack: 2, trigger_connected: 1 }, { gateSamples: SR });
    const rf = riseTo90Ms(fast.L);
    const rs = riseTo90Ms(slow.L);
    expect(
      rs - rf,
      `rise-to-90 %: ATTACK 1 ms → ${rf.toFixed(2)} ms, ATTACK 2 s → ${rs.toFixed(2)} ms. ` +
      'Before the fix BOTH were 1.33 ms.',
    ).toBeGreaterThan(500);
  });

  it('POLY · ATTACK changes the rise (it was IDENTICAL at 1 ms and 2 s)', async () => {
    // The poly branch is a SEPARATE code path (polyEnvSum, not monoEnvSample)
    // and carried the same defect: 1.33 ms at both attacks before the fix.
    const fast = await render(SR, { attack: 0.001, poly_connected: 1 }, { polyGateSamples: SR });
    const slow = await render(SR, { attack: 2, poly_connected: 1 }, { polyGateSamples: SR });
    const rf = riseTo90Ms(fast.L);
    const rs = riseTo90Ms(slow.L);
    expect(
      rs - rf,
      `POLY rise-to-90 %: ATTACK 1 ms → ${rf.toFixed(2)} ms, ATTACK 2 s → ${rs.toFixed(2)} ms. ` +
      'Before the fix BOTH were 1.33 ms.',
    ).toBeGreaterThan(500);
  });

  it('a GATED render differs from the undriven drone over the gate-high window', async () => {
    // Measured before the fix: EXACTLY 0.0000e+0. The envelope contributed
    // nothing whatsoever while the gate was up.
    const gated = await render(SR, { trigger_connected: 1, attack: 0.2 }, { gateSamples: 4800 });
    const drone = await render(SR, {});
    const d = maxAbsDiff(gated.L.subarray(0, 4800), drone.L.subarray(0, 4800));
    expect(d, `gated-vs-drone maxAbsDiff over the gate = ${d.toExponential(4)} (was 0.0000e+0)`)
      .toBeGreaterThan(0.05);
  });

  it('NEGATIVE CONTROL · at base_vol = 1 the envelope IS still a no-op (by design)', async () => {
    // The knob's documented top end. This is the other direction: if the fix had
    // been to delete the floor rather than to change the default, this leg would
    // go red. It also proves the previous leg's metric CAN read 0 — without it,
    // "differs from the drone" could be satisfied by any change at all.
    const gated = await render(SR, { trigger_connected: 1, attack: 0.2, base_vol: 1 }, { gateSamples: 4800 });
    const drone = await render(SR, { base_vol: 1 });
    expect(maxAbsDiff(gated.L.subarray(0, 4800), drone.L.subarray(0, 4800))).toBe(0);
  });

  it('THE PRESERVED PROPERTY · the unpatched raw-VCO drone is still FULL LEVEL', async () => {
    // CUBE's base_vol shipped at 1 so that the raw-VCO drone stayed
    // byte-identical. That property is what this leg protects; it is now
    // protected DIRECTLY in the unpatched branch instead of via the default, so
    // the two no longer trade off. VERIFIED against origin/main's worklet:
    // maxAbsDiff 0.0000e+0 over 8192 samples at the shipped defaults.
    const { L, R } = await render(4096, {});
    expect(peak(L), 'unpatched CUBE must still drone').toBeGreaterThan(0.5);
    expect(maxAbsDiff(L, R), 'spread 0 → mono').toBe(0);
  });

  it('THE PRESERVED PROPERTY · the raw drone is INDEPENDENT of BASE', async () => {
    // Stronger than the old base=1-only leg: the drone used to be
    // `readFrame(...) * baseVol * level`, so a user who turned BASE down silenced
    // their unpatched oscillator (measured peak 0 / 0.172 / 0.344 / 0.688 at BASE
    // 0 / 0.25 / 0.5 / 1). It no longer routes through the knob at all.
    const atDefault = await render(4096, {});
    for (const base of [0, 0.25, 0.5, 1]) {
      const other = await render(4096, { base_vol: base });
      expect(maxAbsDiff(atDefault.L, other.L), `raw drone at BASE ${base}`).toBe(0);
    }
  });

  it('NEGATIVE CONTROL · LEVEL still moves the raw drone', async () => {
    // The leg above asserts a number STAYS PUT across the BASE sweep. A metric
    // blind to gain would satisfy it for free. LEVEL is the knob that IS the
    // output level, so it must move the same probe — and by the right amount.
    const full = await render(4096, {});
    const half = await render(4096, { level: 0.5 });
    expect(db(rms(half.L)) - db(rms(full.L)), 'LEVEL 1 → 0.5 must read −6.02 dB')
      .toBeCloseTo(-6.0206, 3);
    const off = await render(4096, { level: 0 });
    expect(peak(off.L), 'LEVEL 0 must silence it').toBe(0);
  });

  it('THE PRESERVED PROPERTY · a PATCHED-but-never-gated voice is still SILENT', async () => {
    // The no-stray-drone rule, which never depended on base_vol at all (it is the
    // gated-or-releasing ACTIVE test in polyEnvSum/monoEnvSample, untouched here).
    // Asserted at BOTH ends of the BASE knob, on BOTH gated branches, so a future
    // floor change cannot resurrect it.
    for (const base of [0, 0.5, 1]) {
      const trig = await render(4096, { trigger_connected: 1, base_vol: base });
      expect(peak(trig.L), `patched-but-ungated TRIGGER at BASE ${base} must be silent`).toBe(0);
      const poly = await render(4096, { poly_connected: 1, base_vol: base });
      expect(peak(poly.L), `patched-but-ungated POLY at BASE ${base} must be silent`).toBe(0);
    }
  });
});

// ===========================================================================
// NOTE-OFF NO LONGER CLICKS AT THE SHIPPED DEFAULT
// ===========================================================================
describe('CUBE · note-off is click-free at the shipped default', () => {
  const GATE = 12800;

  it("MONO/TRIG · the note-off step is SMALLER than the waveform's own slope", async () => {
    // Measured before the fix: a 0.504980 step against a 0.027922 largest step
    // while the note was sounding — 18×. The floored voice held gain 1 until its
    // envelope crossed ENV_AUDIBLE_EPS and was then CUT.
    const { L } = await render(SR, { trigger_connected: 1 }, { gateSamples: GATE });
    const offStep = maxStep(L, GATE + 1, L.length);
    const soundingStep = maxStep(L, 1, GATE - 800);
    expect(
      offStep,
      `note-off step ${offStep.toFixed(6)} vs the waveform's own max step ` +
      `${soundingStep.toFixed(6)} (linear, full scale). Was 0.504980.`,
    ).toBeLessThanOrEqual(soundingStep);
  });

  it("POLY · the note-off step is SMALLER than the waveform's own slope", async () => {
    // Measured before the fix: 0.425601 against the same 0.027922 in-note slope.
    const { L } = await render(SR, { poly_connected: 1 }, { polyGateSamples: GATE });
    const offStep = maxStep(L, GATE + 1, L.length);
    const soundingStep = maxStep(L, 1, GATE - 800);
    expect(
      offStep,
      `POLY note-off step ${offStep.toFixed(6)} vs in-note max step ` +
      `${soundingStep.toFixed(6)}. Was 0.425601.`,
    ).toBeLessThanOrEqual(soundingStep);
  });

  it('NEGATIVE CONTROL · the same probe still SEES the cut at base_vol = 1', async () => {
    // Proves the measurement is not simply reading a quiet tail. A floored voice
    // must still be cut when its envelope expires — that is what a floor MEANS —
    // and the probe must be able to see it.
    const { L } = await render(SR, { trigger_connected: 1, base_vol: 1 }, { gateSamples: GATE });
    const offStep = maxStep(L, GATE + 1, L.length);
    expect(offStep, `base_vol = 1 note-off step = ${offStep.toFixed(6)}`).toBeGreaterThan(0.2);
  });

  it('the release is a RAMP, not a cut: a longer RELEASE gives a longer tail', async () => {
    const tail = async (release: number): Promise<number> => {
      const { L } = await render(SR, { trigger_connected: 1, release }, { gateSamples: GATE });
      return rms(L.subarray(GATE + 2400, GATE + 9600));
    };
    const shortR = await tail(0.005);
    const longR = await tail(0.5);
    expect(
      db(longR) - db(shortR),
      `RELEASE 0.5 s vs 5 ms tail energy: ${db(longR).toFixed(2)} dB vs ${db(shortR).toFixed(2)} dB`,
    ).toBeGreaterThan(20);
  });
});
