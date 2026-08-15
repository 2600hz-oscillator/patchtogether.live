// packages/web/src/lib/audio/modules/wavetable-vco.test.ts
//
// THE COVERAGE THIS FILE PAYS (#1524).
//
// Three entries in `BEHAVIORAL_SWEEP_EXEMPT`
// (e2e/tests/per-module-per-port-behavioral.spec.ts) opted `wavetableVco.fm`,
// `.fmAmount` and `.pmAmount` OUT of the behavioral CONTROL→PATCHED delta sweep
// with the reason "covered by wavetable-vco.test.ts".
//
// **wavetable-vco.test.ts did not exist.** Nor did any other test touch this
// module's DSP: a repo-wide grep for `fmAmount|pmAmount` over `*.test.ts`
// returned analogVco's tests, three card/def agreement gates, and nothing for
// wavetableVco. The exemption's reason was the ONLY thing standing between
// those ports and zero coverage, and it named a file nobody had written. The
// per-port `inputs-accept` dim still proved the WIRE lands; that the runtime
// consumes the value was asserted nowhere.
//
// That failure is structural, not careless: every gate over those lists reads
// the exemption RECORD (key exists, reason is long enough, module resolves in
// the registry) and NONE of them reads the filesystem, so a reason may name any
// file at all. `scripts/exemption-coverage-anchors.test.ts` closes it —
// deny-by-default, every test/spec filename named in an exemption list must
// resolve to a real file — and this file is what makes wavetableVco's three
// reasons TRUE rather than merely well-formed.
//
// WHAT IS ASSERTED. The registered worklet processor is instantiated for real
// (captured through the `registerProcessor` shim — the worklet entry never
// top-level-exports its class) and driven through `process()`. No CPU mirror:
// a mirror of the recurrence would have passed against a broken processor,
// which is the whole failure mode above.
//
//   * FM is a 1 V/oct-shaped frequency modulation: `fmAmount * fm` is scaled by
//     12 in the processor's semitone sum, so a DC-biased fm of +1 at depth 1
//     is EXACTLY one octave and the cycle count doubles. Asserted as a ratio,
//     not a pixel/level threshold.
//   * PM offsets the READOUT phase only (`p = phase + pmAmount * pm`), leaving
//     the accumulator — and therefore the frequency — untouched.
//   * Both depths are bipolar and both are exact no-ops at depth 0, which is
//     what makes "the knob is off" distinguishable from "the input is dead".

import { describe, it, expect, beforeAll } from 'vitest';
import { wavetableVcoDef } from './wavetable-vco';

const SR = 48000;
const BLOCK = 128;
const C4 = 261.626;

// ── the worklet globals, installed before the processor module is imported ──

interface StubPort {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage: (m: unknown) => void;
}
class StubAudioWorkletProcessor {
  readonly port: StubPort = { onmessage: null, postMessage: () => {} };
}

type ProcInstance = {
  port: StubPort;
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
type ProcCtor = new (opts?: { processorOptions?: unknown }) => ProcInstance;

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
  // Relative path into the DSP source — a worktree may not have the workspace
  // package symlinked under node_modules (same note as sample-hold.test.ts).
  //
  // Resolved through a URL rather than a literal specifier ON PURPOSE: the
  // worklet ENTRY files carry no top-level import or export, so TypeScript
  // classifies them as SCRIPTS and a literal `import('…/wavetable-vco')` is a
  // hard svelte-check error ('is not a module'). Adding `export {}` to the
  // entry to satisfy the checker would change what the worklet build emits,
  // which is the one thing a test must not do to its subject.
  await import(/* @vite-ignore */ new URL('../../../../../dsp/src/wavetable-vco.ts', import.meta.url).href);
  g.registerProcessor = prev;
  g.AudioWorkletProcessor = prevBase;
  if (!registered) throw new Error('wavetable-vco processor did not register');
  capturedProc = registered;
  return capturedProc;
}

// ── fixtures ──

const FRAME_SIZE = 256;
const FRAME_COUNT = 2;

/** Every frame is one cycle of a sine, so `out[i] === sin(2π · readoutPhase)`
 *  regardless of `wavePos`. That isolates the PHASE path (what FM and PM both
 *  act on) from the table-morph path, which is not what these three exemptions
 *  are about. */
function sineTable(): ArrayBuffer {
  const t = new Float32Array(FRAME_SIZE * FRAME_COUNT);
  for (let f = 0; f < FRAME_COUNT; f++) {
    for (let s = 0; s < FRAME_SIZE; s++) {
      t[f * FRAME_SIZE + s] = Math.sin((2 * Math.PI * s) / FRAME_SIZE);
    }
  }
  return t.buffer;
}

interface RunOpts {
  blocks?: number;
  /** DC value on the audio-rate fm input. */
  fm?: number;
  /** DC value on the audio-rate pm input. */
  pm?: number;
  fmAmount?: number;
  pmAmount?: number;
  wavePos?: number;
  wavePosCv?: number;
  tune?: number;
}

/** Instantiate a FRESH processor (phase state is per-instance), post the table,
 *  and render `blocks` × 128 samples with a constant pitch of 0 V (C4). */
async function render(o: RunOpts = {}): Promise<Float32Array> {
  const Ctor = await loadProcessor();
  const proc = new Ctor();
  proc.port.onmessage?.({
    data: { type: 'load', table: sineTable(), frameSize: FRAME_SIZE, frameCount: FRAME_COUNT },
  });

  const blocks = o.blocks ?? 64;
  const out = new Float32Array(blocks * BLOCK);
  const pitch = new Float32Array(BLOCK); // 0 V = C4
  const fm = new Float32Array(BLOCK).fill(o.fm ?? 0);
  const pm = new Float32Array(BLOCK).fill(o.pm ?? 0);
  const wpCv = new Float32Array(BLOCK).fill(o.wavePosCv ?? 0);
  const params: Record<string, Float32Array> = {
    tune: new Float32Array([o.tune ?? 0]),
    fine: new Float32Array([0]),
    wavePos: new Float32Array([o.wavePos ?? 0]),
    fmAmount: new Float32Array([o.fmAmount ?? 0]),
    pmAmount: new Float32Array([o.pmAmount ?? 0]),
  };

  for (let b = 0; b < blocks; b++) {
    const buf = new Float32Array(BLOCK);
    proc.process([[pitch], [fm], [wpCv], [pm]], [[buf]], params);
    out.set(buf, b * BLOCK);
  }
  return out;
}

/** Upward zero crossings — one per cycle for a sine, so this IS the rendered
 *  frequency in cycles-per-window. Units: cycles (not Hz, not samples). */
function cycles(x: Float32Array): number {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1]! <= 0 && x[i]! > 0) n++;
  return n;
}

const maxAbsDiff = (a: Float32Array, b: Float32Array): number => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
};

beforeAll(async () => {
  await loadProcessor();
});

// ── layer 1: the def declares the ports + depths these exemptions name ──

describe('wavetableVco / module def', () => {
  it('declares the audio-rate fm + pm inputs the sweep exempts', () => {
    const ids = wavetableVcoDef.inputs.map((p) => p.id);
    expect(ids).toContain('fm');
    expect(ids).toContain('pm');
    expect(wavetableVcoDef.inputs.find((p) => p.id === 'fm')!.type).toBe('audio');
    expect(wavetableVcoDef.inputs.find((p) => p.id === 'pm')!.type).toBe('audio');
  });

  it('fmAmount + pmAmount are BIPOLAR depths that default to off', () => {
    for (const id of ['fmAmount', 'pmAmount']) {
      const p = wavetableVcoDef.params.find((q) => q.id === id)!;
      expect(p.min, `${id}.min`).toBe(-1);
      expect(p.max, `${id}.max`).toBe(1);
      expect(p.defaultValue, `${id}.defaultValue`).toBe(0);
    }
  });
});

// ── layer 2: the real processor consumes fm / pm / the two depths ──

describe('wavetableVco FM: the fm input bends FREQUENCY, scaled by fmAmount', () => {
  it('a DC fm of +1 at depth 1 is EXACTLY one octave up (cycle count doubles)', async () => {
    const base = cycles(await render({}));
    const up = cycles(await render({ fm: 1, fmAmount: 1 }));
    // 64 blocks @ 48 kHz = 8192 samples = 170.6 ms → ~44.6 cycles at C4.
    expect(base, 'cycles at C4 over the render window').toBeGreaterThan(30);
    // Ratio, not a magic count: ±1 cycle of window-edge truncation on each run.
    expect(up / base, 'cycles(fm=+1, depth=1) ÷ cycles(unmodulated) — expect 2 (one octave)')
      .toBeGreaterThan(1.9);
    expect(up / base).toBeLessThan(2.1);
  });

  it('a DC fm of −1 at depth 1 is one octave DOWN (cycle count halves)', async () => {
    const base = cycles(await render({}));
    const down = cycles(await render({ fm: -1, fmAmount: 1 }));
    expect(down / base, 'cycles(fm=−1, depth=1) ÷ cycles(unmodulated) — expect 0.5')
      .toBeGreaterThan(0.45);
    expect(down / base).toBeLessThan(0.55);
  });

  it('fmAmount SCALES the bend — half depth is half an octave, not full', async () => {
    const base = cycles(await render({}));
    const half = cycles(await render({ fm: 1, fmAmount: 0.5 }));
    const full = cycles(await render({ fm: 1, fmAmount: 1 }));
    expect(half, 'half depth must land strictly between unmodulated and full').toBeGreaterThan(base);
    expect(half).toBeLessThan(full);
    // 2^0.5 = 1.4142; ±1 cycle of truncation over ~63 cycles is ±1.6 %.
    expect(half / base, 'cycles ratio at depth 0.5 — expect 2^0.5').toBeGreaterThan(1.36);
    expect(half / base).toBeLessThan(1.47);
  });

  it('fmAmount is BIPOLAR: negative depth inverts the bend', async () => {
    const up = cycles(await render({ fm: 1, fmAmount: 1 }));
    const inverted = cycles(await render({ fm: 1, fmAmount: -1 }));
    expect(inverted, 'fm=+1 at depth −1 must go DOWN, not up').toBeLessThan(up);
    const base = cycles(await render({}));
    expect(inverted / base).toBeLessThan(0.55);
  });

  it('at depth 0 the fm input is an EXACT no-op (the knob really is off)', async () => {
    const silent = await render({ fm: 0, fmAmount: 0 });
    const driven = await render({ fm: 1, fmAmount: 0 });
    expect(maxAbsDiff(silent, driven), 'max |Δ| in output amplitude at fmAmount=0').toBe(0);
  });
});

describe('wavetableVco PM: the pm input offsets READOUT PHASE, not frequency', () => {
  it('a DC pm at depth 0.25 shifts the waveform without moving the frequency', async () => {
    const base = await render({});
    const shifted = await render({ pm: 1, pmAmount: 0.25 });
    expect(maxAbsDiff(base, shifted), 'max |Δ| in output amplitude — PM must change the wave')
      .toBeGreaterThan(0.5);
    // Cycle count is the frequency: PM leaves the accumulator alone, so it holds.
    expect(cycles(shifted), 'cycles under PM vs unmodulated — PM must NOT retune')
      .toBe(cycles(base));
  });

  it('pmAmount SCALES the offset — deeper depth moves the wave further', async () => {
    const base = await render({});
    const shallow = maxAbsDiff(base, await render({ pm: 1, pmAmount: 0.1 }));
    const deep = maxAbsDiff(base, await render({ pm: 1, pmAmount: 0.25 }));
    expect(shallow, 'max |Δ| at pmAmount=0.1').toBeGreaterThan(0);
    expect(deep, 'max |Δ| at pmAmount=0.25 must exceed the 0.1 case').toBeGreaterThan(shallow);
  });

  it('pmAmount is BIPOLAR: −depth on +pm equals +depth on −pm', async () => {
    const negDepth = await render({ pm: 1, pmAmount: -0.25 });
    const negSignal = await render({ pm: -1, pmAmount: 0.25 });
    expect(maxAbsDiff(negDepth, negSignal), 'max |Δ| between the two sign flips — expect 0')
      .toBeLessThan(1e-6);
  });

  it('a FULL cycle of phase offset (pm=1, depth=1) returns the same waveform', async () => {
    // p = frac(phase + 1·1) === frac(phase). The wrap is what makes the ±1
    // range of pmAmount meaningful rather than an out-of-table read.
    const base = await render({});
    const wrapped = await render({ pm: 1, pmAmount: 1 });
    expect(maxAbsDiff(base, wrapped), 'max |Δ| after a full-cycle phase offset').toBeLessThan(1e-5);
  });

  it('at depth 0 the pm input is an EXACT no-op', async () => {
    const silent = await render({ pm: 0, pmAmount: 0 });
    const driven = await render({ pm: 1, pmAmount: 0 });
    expect(maxAbsDiff(silent, driven), 'max |Δ| in output amplitude at pmAmount=0').toBe(0);
  });
});

describe('wavetableVco modulation: bounded + finite', () => {
  it('FM and PM together stay inside the table range and never go non-finite', async () => {
    const out = await render({ fm: 0.8, fmAmount: 1, pm: 0.7, pmAmount: 1 });
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!), `sample ${i} is finite`).toBe(true);
      expect(Math.abs(out[i]!), `|sample ${i}| within the unit sine table`).toBeLessThanOrEqual(1.001);
    }
  });

  it('the unmodulated oscillator runs at C4 (the reference the FM ratios are taken against)', async () => {
    const out = await render({ blocks: 64 });
    const seconds = out.length / SR;
    const hz = cycles(out) / seconds;
    expect(hz, 'rendered fundamental in Hz at 0 V pitch').toBeGreaterThan(C4 - 8);
    expect(hz).toBeLessThan(C4 + 8);
  });
});
