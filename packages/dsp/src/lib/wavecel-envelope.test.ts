// packages/dsp/src/lib/wavecel-envelope.test.ts
//
// THE FOUR MEASURED WAVECEL DEFECTS, pinned by the numbers that found them,
// each with a negative control that runs on EVERY invocation.
//
// Everything here drives the REAL wavecel worklet through a registerProcessor
// shim, because three of the four defects are only visible at the level of the
// assembled processor: the AudioParam DEFAULTS, and the raw-VCO branch.
//
// Why nothing caught these:
//
//   D5/D6 (the ADSR was a no-op at the shipped default). `poly-osc-sum.test.ts`
//     pins `vcaGain(base, env) = base + (1−base)·env` and every one of its
//     assertions is CORRECT. The arithmetic was never wrong — the DEFAULT was.
//     A helper test that supplies its own inputs is structurally blind to which
//     input the module actually ships with; nothing joined the helper to the
//     `defaultValue` in the descriptor.
//   D7/D8 (SPREAD). `wavetable-osc.test.ts` asserted spread 1, spread 3 and
//     spread 5 — three points, none of them near 1, where the cliff is. And its
//     stereo leg used a centre frame in the MIDDLE of the table, so it never
//     hit the clamp aliasing that killed the stereo at the DEFAULT morph of 0.

import { describe, it, expect, beforeAll } from 'vitest';

const SR = 48000;
const BLOCK = 128;

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
  await import('../wavecel');
  g.registerProcessor = prev;
  if (!registered) throw new Error('wavecel processor did not register');
  capturedProc = registered;
  capturedDescriptors = (registered as unknown as {
    parameterDescriptors: { name: string; defaultValue: number }[];
  }).parameterDescriptors;
  return capturedProc;
}

/** An 8-frame table whose frame k is the (k+1)th harmonic — adjacent frames are
 *  strongly different, so a frame-spread that works is unmissable and one that
 *  does not is unmistakable. */
function harmonicTable(): number[][] {
  const out: number[][] = [];
  for (let k = 0; k < 8; k++) {
    const f = new Array<number>(256);
    for (let i = 0; i < 256; i++) f[i] = Math.sin((2 * Math.PI * (k + 1) * i) / 256);
    out.push(f);
  }
  return out;
}

/** Knobs the module ships with. `base_vol` is DELIBERATELY absent from the
 *  caller-supplied set unless a test names it: omitting the key exercises the
 *  processor's own default path, which is the thing under test. */
const KNOBS: Record<string, number> = {
  tune: 0, fine: 0, morph: 0, spread: 1, fold: 0,
  attack: 0.001, decay: 0.1, sustain: 1, release: 0.005,
  poly_connected: 0, trigger_connected: 0,
};

interface RenderOpts {
  /** Samples for which the mono TRIGGER gate is high (from sample 0). */
  gateSamples?: number;
  /** a-rate spread ramp across the whole render. */
  spreadRamp?: [number, number];
}

async function render(
  n: number,
  over: Record<string, number> = {},
  opt: RenderOpts = {},
): Promise<{ L: Float32Array; R: Float32Array }> {
  const Proc = await loadProcessor();
  const p = new Proc();
  p.port.onmessage!({ data: { type: 'loadWavetable', frames: harmonicTable() } });
  const knobs = { ...KNOBS, ...over };
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const zero = new Float32Array(BLOCK);
  const poly: Float32Array[] = Array.from({ length: 10 }, () => new Float32Array(BLOCK));
  const trig = new Float32Array(BLOCK);
  const oL = new Float32Array(BLOCK);
  const oR = new Float32Array(BLOCK);
  for (let b = 0; b < n; b += BLOCK) {
    const params: Record<string, Float32Array> = {};
    for (const [k, v] of Object.entries(knobs)) params[k] = new Float32Array([v]);
    if (opt.spreadRamp) {
      const a = new Float32Array(BLOCK);
      for (let s = 0; s < BLOCK; s++) {
        const t = (b + s) / n;
        a[s] = opt.spreadRamp[0] + (opt.spreadRamp[1] - opt.spreadRamp[0]) * t;
      }
      params.spread = a;
    }
    for (let s = 0; s < BLOCK; s++) {
      trig[s] = opt.gateSamples !== undefined && b + s < opt.gateSamples ? 1 : 0;
    }
    oL.fill(0);
    oR.fill(0);
    p.process([[zero], [zero], [zero], [zero], [zero], poly, [trig]], [[oL], [oR]], params);
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
// D5 — THE AMP ADSR ACTUALLY SHAPES A NOTE AT THE SHIPPED DEFAULT
// ===========================================================================
describe('D5 · the amp ADSR is audible at the shipped default', () => {
  it('base_vol SHIPS at 0 (pure ADSR) — the descriptor is the thing under test', async () => {
    await loadProcessor();
    const d = capturedDescriptors!.find((x) => x.name === 'base_vol');
    expect(
      d?.defaultValue,
      'base_vol shipped at 1, which makes gain = 1 + 0·env — the whole A/D/S/R a no-op',
    ).toBe(0);
  });

  it('ATTACK changes the rise (it was IDENTICAL at 1 ms and 2 s)', async () => {
    const fast = await render(SR, { attack: 0.001, trigger_connected: 1 }, { gateSamples: SR });
    const slow = await render(SR, { attack: 2, trigger_connected: 1 }, { gateSamples: SR });
    const rf = riseTo90Ms(fast.L);
    const rs = riseTo90Ms(slow.L);
    expect(
      rs - rf,
      `rise-to-90 %: ATTACK 1 ms → ${rf.toFixed(2)} ms, ATTACK 2 s → ${rs.toFixed(2)} ms. ` +
      'Before the fix BOTH were the same number.',
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
    // The knob's documented top end. This is the other direction: if the fix
    // had been to delete the floor rather than to change the default, this leg
    // would go red. It also proves the previous leg's metric can read 0.
    const gated = await render(SR, { trigger_connected: 1, attack: 0.2, base_vol: 1 }, { gateSamples: 4800 });
    const drone = await render(SR, { base_vol: 1 });
    expect(maxAbsDiff(gated.L.subarray(0, 4800), drone.L.subarray(0, 4800))).toBe(0);
  });

  it('THE PRESERVED PROPERTY · the unpatched raw-VCO drone is still FULL LEVEL', async () => {
    // #675 ("kill stray drone + add Base Vol VCA floor") shipped base_vol = 1
    // so that the raw-VCO drone stayed byte-identical. That property is what
    // this leg protects; it is now protected DIRECTLY in the unpatched branch
    // instead of via the default, so the two no longer trade off.
    const { L, R } = await render(4096, {});
    let pk = 0;
    for (const v of L) pk = Math.max(pk, Math.abs(v));
    expect(pk, 'unpatched WAVECEL must still drone at full level').toBeGreaterThan(0.99);
    expect(maxAbsDiff(L, R)).toBe(0); // spread 1 → mono
  });

  it('THE PRESERVED PROPERTY · the raw drone is INDEPENDENT of BASE', async () => {
    // Stronger than #675's version: the drone used to be `osc * base_vol`, so
    // a user who turned BASE down silenced their unpatched oscillator. It no
    // longer routes through the knob at all.
    const atZero = await render(4096, {});
    for (const base of [0.25, 0.5, 1]) {
      const other = await render(4096, { base_vol: base });
      expect(maxAbsDiff(atZero.L, other.L), `raw drone at BASE ${base}`).toBe(0);
    }
  });

  it('THE PRESERVED PROPERTY · a PATCHED-but-never-gated TRIGGER is still SILENT', async () => {
    // The other half of #675 — no stray drone — which never depended on
    // base_vol at all (it is the gated-or-releasing ACTIVE test). Assert it at
    // BOTH ends of the BASE knob so a future floor change cannot resurrect it.
    for (const base of [0, 0.5, 1]) {
      const { L } = await render(4096, { trigger_connected: 1, base_vol: base });
      let pk = 0;
      for (const v of L) pk = Math.max(pk, Math.abs(v));
      expect(pk, `patched-but-ungated TRIGGER at BASE ${base} must be silent`).toBe(0);
    }
  });
});

// ===========================================================================
// D6 — NOTE-OFF NO LONGER CLICKS AT THE SHIPPED DEFAULT
// ===========================================================================
describe('D6 · note-off is click-free at the shipped default', () => {
  const GATE = 12800;

  it('the note-off step is SMALLER than the waveform\'s own slope', async () => {
    // Measured before the fix: last sample −0.869457 → next 0.000000, a step
    // 25× the largest step while the note was sounding. The floored voice held
    // gain 1 until its envelope crossed ENV_AUDIBLE_EPS and was then CUT.
    const { L } = await render(SR, { trigger_connected: 1 }, { gateSamples: GATE });
    const offStep = maxStep(L, GATE + 1, L.length);
    const soundingStep = maxStep(L, 1, GATE - 800);
    expect(
      offStep,
      `note-off step ${offStep.toFixed(6)} vs the waveform's own max step ` +
      `${soundingStep.toFixed(6)} (linear, full scale). Was 0.869457.`,
    ).toBeLessThanOrEqual(soundingStep);
  });

  it('NEGATIVE CONTROL · the same probe still SEES the cut at base_vol = 1', async () => {
    // Proves the measurement is not simply reading a quiet tail. A floored
    // voice must still be cut when its envelope expires — that is what a floor
    // MEANS — and the probe must be able to see it.
    const { L } = await render(SR, { trigger_connected: 1, base_vol: 1 }, { gateSamples: GATE });
    const offStep = maxStep(L, GATE + 1, L.length);
    expect(offStep, `base_vol = 1 note-off step = ${offStep.toFixed(6)}`).toBeGreaterThan(0.5);
  });

  it('the release is a RAMP, not a cut: a longer RELEASE gives a longer tail', async () => {
    const tail = async (release: number): Promise<number> => {
      const { L } = await render(SR, { trigger_connected: 1, release }, { gateSamples: GATE });
      return rms(L.subarray(GATE + 2400, GATE + 9600));
    };
    const shortR = await tail(0.005);
    const longR = await tail(0.5);
    expect(db(longR) - db(shortR), 'RELEASE 0.5 s vs 5 ms tail energy').toBeGreaterThan(20);
  });
});

// ===========================================================================
// D7 — SPREAD IS A WIDTH CONTROL, NOT A VOLUME CONTROL
// ===========================================================================
describe('D7 · SPREAD does not move the level', () => {
  it('there is NO cliff just above spread 1 (it was 43 dB)', async () => {
    // Measured: rms −5.99 dB at spread 1.0 → −49.11 dB at spread 1.0001.
    const at1 = await render(SR / 4, { spread: 1, morph: 0.5 });
    const justOver = await render(SR / 4, { spread: 1.0001, morph: 0.5 });
    const delta = db(rms(at1.L)) - db(rms(justOver.L));
    expect(
      Math.abs(delta),
      `rms at spread 1 = ${db(rms(at1.L)).toFixed(2)} dB, at 1.0001 = ` +
      `${db(rms(justOver.L)).toFixed(2)} dB → ${delta.toFixed(2)} dB step. Was 43.12 dB.`,
    ).toBeLessThan(0.5);
  });

  it('the WHOLE travel stays within a few dB, at both ends of MORPH', async () => {
    for (const morph of [0, 0.5]) {
      const levels: number[] = [];
      for (let i = 0; i <= 16; i++) {
        const spread = 1 + (4 * i) / 16;
        const { L } = await render(SR / 8, { spread, morph });
        levels.push(db(rms(L)));
      }
      const swing = Math.max(...levels) - Math.min(...levels);
      expect(
        swing,
        `MORPH ${morph}: level swing across SPREAD 1→5 = ${swing.toFixed(2)} dB ` +
        `(${levels.map((x) => x.toFixed(1)).join(', ')})`,
      ).toBeLessThan(8);
    }
  });

  it('an a-rate SPREAD ramp does not swing the level (was 13.96 dB)', async () => {
    const { L } = await render(SR, { morph: 0.5 }, { spreadRamp: [1, 5] });
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i + 2048 <= L.length; i += 2048) {
      const r = rms(L.subarray(i, i + 2048));
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
    expect(db(hi) - db(lo), `a-rate 1→5 ramp swing = ${(db(hi) - db(lo)).toFixed(2)} dB`)
      .toBeLessThan(6);
  });

  it('NEGATIVE CONTROL · the rms probe is NOT level-invariant', async () => {
    // Every leg above asserts a number STAYS PUT. A metric blind to level would
    // satisfy all of them for free — which is exactly the failure mode CLAUDE.md
    // calls out ("ask what the measurement is invariant to"). Halve the render
    // and the probe must read −6.02 dB, and the module's own FOLD must move it.
    const { L } = await render(SR / 8, { spread: 1, morph: 0.5 });
    const halved = Float32Array.from(L, (v) => v * 0.5);
    expect(db(rms(halved)) - db(rms(L))).toBeCloseTo(-6.0206, 3);
    const folded = await render(SR / 8, { spread: 1, morph: 0.5, fold: 1 });
    expect(
      Math.abs(db(rms(folded.L)) - db(rms(L))),
      'FOLD 0 → 1 must move the rms probe',
    ).toBeGreaterThan(0.5);
  });
});

// ===========================================================================
// D8 — SPREAD ACTUALLY PRODUCES STEREO, AT THE DEFAULT MORPH
// ===========================================================================
describe('D8 · SPREAD produces stereo at the DEFAULT morph', () => {
  it('|L−R| is non-zero and GROWS with spread at morph 0 (it was EXACTLY 0)', async () => {
    // Measured before the fix at the def-default morph of 0:
    //   spread 1.00 / 1.25 / 1.50 / 1.75 / 2.00 → |L−R|max = 0.0000e+0, all of
    //   them. Two taps at centre ±0.5 frames both aliased onto the same
    //   frames[0]/frames[1] interpolation under sampleFrame's index clamp, so
    //   hard-panning them gave L == R exactly.
    let prev = 0;
    for (const spread of [1.25, 1.5, 1.75, 2, 3, 5]) {
      const { L, R } = await render(SR / 8, { spread, morph: 0 });
      const d = maxAbsDiff(L, R);
      expect(d, `morph 0, spread ${spread}: |L−R|max = ${d.toExponential(4)}`).toBeGreaterThan(0.05);
      expect(d, `width must grow with SPREAD (spread ${spread})`).toBeGreaterThan(prev);
      prev = d;
    }
  });

  it('NEGATIVE CONTROL · spread 1 is EXACTLY mono, at every morph', async () => {
    // The other direction: a "wider is different" metric would be satisfied by
    // making everything different. Spread 1 must remain bit-exactly centred.
    for (const morph of [0, 0.25, 0.5, 1]) {
      const { L, R } = await render(SR / 8, { spread: 1, morph });
      expect(maxAbsDiff(L, R), `spread 1 at morph ${morph} must be mono`).toBe(0);
    }
  });

  it('stereo works at the OTHER end of the table too (morph 1)', async () => {
    const { L, R } = await render(SR / 8, { spread: 3, morph: 1 });
    expect(maxAbsDiff(L, R)).toBeGreaterThan(0.05);
  });
});
