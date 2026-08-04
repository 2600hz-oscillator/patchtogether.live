// packages/dsp/src/lib/treeohvox-envelope.test.ts
//
// THE FOUR MEASURED TREE.oh.VOX DEFECTS, each pinned by the number that found
// it, each with a negative control that runs on EVERY invocation (not once at
// authoring time).
//
// Why nothing caught these before — the adversarial answer, per defect:
//
//   D1 gate length ignored. `renderVoiceSequence` (which every ART scenario and
//      the parity test go through) took a `gateDurationSamples` per note AND
//      NEVER READ IT, and the worklet had no falling-edge branch. So the whole
//      pinned layer was *structurally incapable* of expressing a note-off: ART
//      could not have gone red no matter how wrong the release was. Fixed on
//      both sides; the test below drives the REAL worklet's process() so the
//      edge wiring itself — not just the voice class — is covered.
//   D2 WAVE null at 1/3. Every existing WAVE assertion sampled the ENDPOINTS
//      (blend 0 = saw, blend 1 = square) and both endpoints were correct. The
//      null lives strictly inside the travel. This test sweeps 33 points and
//      carries the OLD formula inline as a permanent negative control, so the
//      DFT probe is proven able to see a null on every run.
//   D3 filter reset on every gate edge. No test ever retriggered a note that
//      was still ringing — the one condition under which the reset is audible.
//   D4 dead bottom of CUTOFF. Every cutoff assertion used values ABOVE the
//      200 Hz clamp, so the clamped region was outside the observation window
//      by construction.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  TreeohvoxVoice,
  PolyBlepBlendOsc,
  TbVoxAmpEnv,
  renderVoiceSequence,
  TB303_CUTOFF_FLOOR_HZ,
  TB303_CUTOFF_CEILING_HZ,
  TBVOX_AMP_DECAY_MS,
  type VoiceParams,
} from './treeohvox-dsp';

const SR = 48000;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

const DEFAULTS: VoiceParams = {
  tuneSemitones: 0,
  cutoffHz: 1000,
  resonance: 0.5,
  envAmount01: 0.5,
  decayMs: 600,
  accentAmount01: 0.5,
  waveform: 0,
};

// ---------------------------------------------------------------------------
// The REAL worklet, captured through a registerProcessor shim (the
// mandelbulb-osc.test.ts / cube.test.ts pattern — the entry deliberately
// top-level-exports nothing).
// ---------------------------------------------------------------------------
type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
type ProcCtor = new () => ProcInstance;
let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  await import('../treeohvox');
  g.registerProcessor = prev;
  if (!registered) throw new Error('treeohvox processor did not register');
  capturedProc = registered;
  return capturedProc;
}

/** Render `totalSamples` through the REAL worklet with a gate that is high for
 *  `gateSamples` samples starting at sample 0. Params are held constant. */
async function renderWorkletGated(
  totalSamples: number,
  gateSamples: number,
  over: Partial<Record<string, number>> = {},
): Promise<Float32Array> {
  const Proc = await loadProcessor();
  const p = new Proc();
  const knobs: Record<string, number> = {
    tune: 0, cutoff: 1000, resonance: 0.5, envelope: 0.5,
    decay: 600, accent: 0.5, waveform: 0, ...over,
  };
  const params: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(knobs)) params[k] = new Float32Array([v]);
  const out = new Float32Array(totalSamples);
  const pitch = new Float32Array(BLOCK);
  const gate = new Float32Array(BLOCK);
  const accent = new Float32Array(BLOCK);
  const blockOut = new Float32Array(BLOCK);
  for (let base = 0; base < totalSamples; base += BLOCK) {
    for (let s = 0; s < BLOCK; s++) gate[s] = base + s < gateSamples ? 1 : 0;
    blockOut.fill(0);
    p.process([[pitch], [gate], [accent]], [[blockOut]], params);
    out.set(blockOut.subarray(0, Math.min(BLOCK, totalSamples - base)), base);
  }
  return out;
}

function peak(a: Float32Array): number {
  let m = 0;
  for (const v of a) m = Math.max(m, Math.abs(v));
  return m;
}
function rms(a: Float32Array): number {
  let s = 0;
  for (const v of a) s += v * v;
  return Math.sqrt(s / Math.max(1, a.length));
}
function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}
/** ms at which the windowed peak envelope first falls below `frac` of the
 *  render's own peak. Window is 1 ms so the resolution is stated in ms, not
 *  in an unlabelled sample count. */
function decayToMs(a: Float32Array, frac: number): number {
  const W = Math.round(SR / 1000);
  const pk = peak(a);
  if (pk === 0) return 0;
  for (let i = 0; i + W <= a.length; i += W) {
    let m = 0;
    for (let j = i; j < i + W; j++) m = Math.max(m, Math.abs(a[j]!));
    if (m < pk * frac) return (i / SR) * 1000;
  }
  return Infinity;
}
/** Exact single-bin magnitude of harmonic `k` of `f0`, scaled so a unit sine
 *  reads 1.0. `buf` must span a whole number of f0 periods. */
function harmonic(buf: Float32Array, f0: number, k: number): number {
  const w = (2 * Math.PI * k * f0) / SR;
  let re = 0;
  let im = 0;
  for (let i = 0; i < buf.length; i++) {
    re += buf[i]! * Math.cos(w * i);
    im += buf[i]! * Math.sin(w * i);
  }
  return (2 * Math.sqrt(re * re + im * im)) / buf.length;
}

// ===========================================================================
// D1 — GATE LENGTH IS THE NOTE LENGTH (was: ignored entirely)
// ===========================================================================
describe('D1 · gate length is the note length', () => {
  it('a 10 ms gate and a 1 s gate are NOT byte-identical (they were: 0.0000e+0 over 3 s)', async () => {
    const short = await renderWorkletGated(SR * 3, 480);
    const long = await renderWorkletGated(SR * 3, 48000);
    const diff = maxAbsDiff(short, long);
    expect(
      diff,
      `gate 480 vs 48000 samples maxAbsDiff (linear, full scale). ` +
      `Shipped defect measured EXACTLY 0.0000e+0 — the falling edge was never read. Got ${diff.toExponential(4)}`,
    ).toBeGreaterThan(0.1);
  });

  it('the note ENDS with the gate: 100/300/900 ms gates give 100/300/900 ms notes', async () => {
    const seen: { gateMs: number; noteMs: number }[] = [];
    for (const gateMs of [100, 300, 900]) {
      const buf = await renderWorkletGated(SR * 3, Math.round((gateMs / 1000) * SR));
      seen.push({ gateMs, noteMs: decayToMs(buf, 1e-3) }); // -60 dB
    }
    for (const { gateMs, noteMs } of seen) {
      // Release is 1 ms (Open303 ampRelease); -60 dB of a 1 ms exponential is
      // ~7 ms, plus the 1 ms measurement window → allow 15 ms of overhang.
      expect(
        noteMs,
        `gate ${gateMs} ms → note ${noteMs} ms (ms to -60 dB). Gate length must set note length. ` +
        `All three were ~2400 ms before the fix.`,
      ).toBeGreaterThanOrEqual(gateMs - 2);
      expect(noteMs).toBeLessThanOrEqual(gateMs + 15);
    }
    // Monotone, and a real spread — not three copies of one number.
    expect(seen[2]!.noteMs - seen[0]!.noteMs).toBeGreaterThan(700);
  });

  it('NEGATIVE CONTROL · a gate that never falls still rings the full fixed VCA decay', async () => {
    // Both directions on the SAME metric: if `decayToMs` had merely become
    // "always short" the previous test would pass for the wrong reason. A held
    // gate must still ring on Open303's fixed 1230 ms ampEnv decay.
    const held = await renderWorkletGated(SR * 4, SR * 4);
    const heldMs = decayToMs(held, 1e-3);
    expect(
      heldMs,
      `held gate → ${heldMs} ms to -60 dB; must ring on the fixed ${TBVOX_AMP_DECAY_MS} ms VCA decay ` +
      `(-60 dB ≈ 13.8 τ). If this is short, the metric — not the gate — is broken.`,
    ).toBeGreaterThan(2000);
  });

  it('DECAY drives the FILTER envelope, not the note length (a real 303 DECAY knob)', async () => {
    // The knob's documented job. Same 400 ms gate, 60× knob move: the note
    // length must NOT move (the gate owns it) but the timbre MUST.
    const gate = Math.round(0.4 * SR);
    const dShort = await renderWorkletGated(SR, gate, { decay: 50, envelope: 1 });
    const dLong = await renderWorkletGated(SR, gate, { decay: 3000, envelope: 1 });
    expect(Math.abs(decayToMs(dShort, 1e-3) - decayToMs(dLong, 1e-3))).toBeLessThanOrEqual(15);
    // …and it is not a no-op: the filter sweep differs audibly.
    expect(
      maxAbsDiff(dShort, dLong),
      'DECAY 50 vs 3000 ms must change the FILTER sweep',
    ).toBeGreaterThan(0.05);
  });

  it('renderVoiceSequence HONOURS gateDurationSamples (it was declared and unread)', () => {
    const notes = [{ atSample: 0, pitchCv: 0, accented: false, gateDurationSamples: 4800 }];
    const gated = renderVoiceSequence(DEFAULTS, SR, SR, notes);
    const held = renderVoiceSequence(
      DEFAULTS, SR,
      SR,
      [{ ...notes[0]!, gateDurationSamples: 0 }], // 0 = "no note-off"
    );
    expect(rms(gated.subarray(SR / 2))).toBeLessThan(rms(held.subarray(SR / 2)) * 1e-3);
  });

  it('a note-off on an IDLE voice is a no-op (no state to corrupt)', () => {
    const v = new TreeohvoxVoice(SR, DEFAULTS);
    v.release();
    v.release();
    const out = new Float32Array(256);
    for (let i = 0; i < out.length; i++) out[i] = v.step();
    expect(peak(out)).toBe(0);
  });

  it('TbVoxAmpEnv release is a RATE change, not a jump (the value is continuous)', () => {
    const e = new TbVoxAmpEnv(SR);
    e.trigger(1);
    let last = 0;
    for (let i = 0; i < 4800; i++) last = e.step();
    expect(e.phase()).toBe('decay');
    e.noteOff();
    expect(e.phase()).toBe('release');
    const first = e.step();
    expect(Math.abs(first - last)).toBeLessThan(0.05); // no discontinuity
    expect(first).toBeLessThan(last); // …and it really is falling
  });
});

// ===========================================================================
// D2 — THE WAVE MORPH HAS NO NULL
// ===========================================================================

/** The SHIPPED (defective) square tap, kept verbatim as a permanent negative
 *  control on the DFT probe: an oppositely-signed square must still show the
 *  null, which proves the measurement below can SEE a null when there is one. */
function legacyBlendRender(f0: number, blend: number, n: number): Float32Array {
  const out = new Float32Array(n);
  let phase = 0;
  const dt = f0 / SR;
  for (let i = 0; i < n; i++) {
    const t = phase;
    let saw = 2 * t - 1;
    if (t < dt) { const x = t / dt; saw -= x + x - x * x - 1; }
    else if (t > 1 - dt) { const x = (t - 1) / dt; saw -= x * x + x + x + 1; }
    const w = blend;
    let o = saw;
    if (w > 0) {
      let sq = t < 0.5 ? 1 : -1; // ← the old, opposite polarity
      if (t < dt) { const x = t / dt; sq += x + x - x * x - 1; }
      else if (t > 1 - dt) { const x = (t - 1) / dt; sq += x * x + x + x + 1; }
      const tt = t < 0.5 ? t + 0.5 : t - 0.5;
      if (tt < dt) { const x = tt / dt; sq -= x + x - x * x - 1; }
      else if (tt > 1 - dt) { const x = (tt - 1) / dt; sq -= x * x + x + x + 1; }
      o = (1 - w) * saw + w * sq;
    }
    out[i] = o;
    phase += dt;
    if (phase >= 1) phase -= 1;
  }
  return out;
}

describe('D2 · the WAVE morph never cancels', () => {
  const F0 = 100; // 1 s at 48 kHz = exactly 100 whole periods
  const N = SR;

  function blendRender(blend: number): Float32Array {
    const osc = new PolyBlepBlendOsc(SR);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = osc.step(F0, blend);
    return out;
  }

  it('NEGATIVE CONTROL · the OLD polarity still nulls at 1/3 (so the probe can see a null)', () => {
    const old = legacyBlendRender(F0, 1 / 3, N);
    expect(harmonic(old, F0, 1)).toBeLessThan(1e-5); // measured 0.00000
    expect(harmonic(old, F0, 3)).toBeLessThan(1e-5); // measured 0.00000
    // …and the same probe reads a healthy fundamental at blend 0, so it is not
    // simply returning zero.
    expect(harmonic(legacyBlendRender(F0, 0, N), F0, 1)).toBeGreaterThan(0.6);
  });

  it('the fundamental is non-zero and MONOTONE across the whole travel', () => {
    const sawH1 = harmonic(blendRender(0), F0, 1);
    let prev = -Infinity;
    for (let i = 0; i <= 32; i++) {
      const w = i / 32;
      const h1 = harmonic(blendRender(w), F0, 1);
      expect(
        h1,
        `WAVE ${w.toFixed(4)}: h1 = ${h1.toFixed(5)} (linear, unit-sine scale). ` +
        `Shipped defect: h1 = 0.00000 at w = 1/3.`,
      ).toBeGreaterThan(sawH1 * 0.9);
      expect(h1, `h1 must not fall as WAVE rises (w = ${w.toFixed(4)})`).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = h1;
    }
  });

  it('the THIRD harmonic never nulls either (all odd harmonics cancelled together)', () => {
    for (let i = 0; i <= 32; i++) {
      const w = i / 32;
      expect(harmonic(blendRender(w), F0, 3), `h3 at WAVE ${w.toFixed(4)}`).toBeGreaterThan(0.15);
    }
  });

  it('through the VOICE, level rises monotonically saw → square (was 0.08145 → 0.03001 → 0.13535)', () => {
    const level = (w: number) =>
      rms(renderVoiceSequence({ ...DEFAULTS, waveform: w }, SR, SR, [
        { atSample: 0, pitchCv: 0, accented: false, gateDurationSamples: SR },
      ]));
    const l0 = level(0);
    const lThird = level(1 / 3);
    const l1 = level(1);
    expect(lThird, `voice rms at WAVE 1/3 = ${lThird.toFixed(5)}; saw = ${l0.toFixed(5)}`).toBeGreaterThan(l0);
    expect(l1).toBeGreaterThan(lThird);
    // The old bug was an 8.7 dB DROP at 1/3; assert we are nowhere near it.
    expect(20 * Math.log10(lThird / l0)).toBeGreaterThan(0);
  });

  it('WAVE 0 is still bit-identical to the pure saw (ART baselines depend on it)', () => {
    const a = blendRender(0);
    const osc = new PolyBlepBlendOsc(SR);
    const b = new Float32Array(2048);
    for (let i = 0; i < b.length; i++) b[i] = osc.step(F0, 0);
    for (let i = 0; i < b.length; i++) expect(a[i]).toBe(b[i]);
  });
});

// ===========================================================================
// D3 — A RETRIGGER OVER A RINGING NOTE DOES NOT RESET THE FILTER
// ===========================================================================
describe('D3 · retrigger over a ringing note does not step to zero', () => {
  const AT = 9600;

  function twoNotes(gap: number, total = 30000): Float32Array {
    const v = new TreeohvoxVoice(SR, DEFAULTS);
    const out = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      if (i === 0 || i === gap) v.trigger({ pitchCv: 0, accented: false });
      out[i] = v.step();
    }
    return out;
  }

  it('the retrigger sample is NOT 0.0 and the step is small next to the signal', () => {
    const out = twoNotes(AT);
    const step = Math.abs(out[AT]! - out[AT - 1]!);
    let maxElsewhere = 0;
    for (let i = 1; i < out.length; i++) {
      if (i === AT) continue;
      maxElsewhere = Math.max(maxElsewhere, Math.abs(out[i]! - out[i - 1]!));
    }
    expect(
      out[AT],
      `sample[${AT}] was EXACTLY 0.00000 before the fix (from 0.06633 the sample before)`,
    ).not.toBe(0);
    expect(
      step / maxElsewhere,
      `retrigger step ${step.toFixed(5)} vs max delta elsewhere ${maxElsewhere.toFixed(5)} (linear). ` +
      `Before the fix the retrigger was among the largest deltas in the whole render.`,
    ).toBeLessThan(0.5);
  });

  it('NEGATIVE CONTROL · a retrigger on an IDLE voice DOES reset (fresh note starts from zero state)', () => {
    // The other direction. Open303 resets phase when idle; so must we, or the
    // fix would have simply deleted the reset. A gated note that has fully
    // released leaves the voice idle → the next note starts from silence.
    const v = new TreeohvoxVoice(SR, DEFAULTS);
    const out = new Float32Array(SR);
    // note 1: short gate, then a long silence so the voice goes idle
    v.trigger({ pitchCv: 0, accented: false });
    for (let i = 0; i < 4800; i++) out[i] = v.step();
    v.release();
    for (let i = 4800; i < 24000; i++) out[i] = v.step();
    expect(peak(out.subarray(20000, 24000))).toBe(0); // genuinely idle
    v.trigger({ pitchCv: 0, accented: false });
    out[24000] = v.step();
    // A reset filter + reset phase means the first sample of a fresh note is
    // (essentially) zero — that is CORRECT here and wrong mid-note.
    expect(Math.abs(out[24000]!)).toBeLessThan(1e-6);
  });

  it('the amp envelope and the filter now agree: NEITHER resets on an overlapping retrigger', () => {
    const v = new TreeohvoxVoice(SR, DEFAULTS);
    v.trigger({ pitchCv: 0, accented: false });
    for (let i = 0; i < 2400; i++) v.step();
    const before = v.step();
    v.trigger({ pitchCv: 0, accented: false }); // overlapping
    const after = v.step();
    expect(Math.abs(after - before)).toBeLessThan(Math.abs(before) * 2 + 0.05);
    expect(after).not.toBe(0);
  });
});

// ===========================================================================
// D4 — THE WHOLE CUTOFF TRAVEL IS ALIVE
// ===========================================================================
describe('D4 · every part of the CUTOFF travel changes the sound', () => {
  /** The def's own taper: log from floor to ceiling. */
  function cutoffAt(knob01: number): number {
    return TB303_CUTOFF_FLOOR_HZ * Math.pow(TB303_CUTOFF_CEILING_HZ / TB303_CUTOFF_FLOOR_HZ, knob01);
  }
  function render(cutoffHz: number, envAmount01: number): Float32Array {
    return renderVoiceSequence({ ...DEFAULTS, cutoffHz, envAmount01 }, SR, 12000, [
      { atSample: 0, pitchCv: 0, accented: false, gateDurationSamples: 12000 },
    ]);
  }

  it('NO adjacent pair over the whole travel is byte-identical, at ENVELOPE 0', () => {
    // ENVELOPE 0 is the worst case: the env lifts the instantaneous cutoff, so
    // the dead zone was WIDEST here. Measured before the fix: everything from
    // 40 Hz to 139.5 Hz — the bottom ~25 % of a log knob — was bit-exact dead.
    const STEPS = 16;
    let prevBuf = render(cutoffAt(0), 0);
    for (let i = 1; i <= STEPS; i++) {
      const hz = cutoffAt(i / STEPS);
      const buf = render(hz, 0);
      const d = maxAbsDiff(prevBuf, buf);
      expect(
        d,
        `knob ${(i / STEPS).toFixed(3)} (${hz.toFixed(1)} Hz) vs the step below it: ` +
        `maxAbsDiff = ${d.toExponential(3)} (linear, full scale). 0 means a DEAD control.`,
      ).toBeGreaterThan(1e-3);
      prevBuf = buf;
    }
  });

  it('NEGATIVE CONTROL · the same probe reads EXACTLY 0 when the setting does not change', () => {
    expect(maxAbsDiff(render(cutoffAt(0.1), 0), render(cutoffAt(0.1), 0))).toBe(0);
  });

  it('the bottom of the knob is genuinely darker than the middle', () => {
    const bottom = rms(render(cutoffAt(0), 0.5));
    const mid = rms(render(cutoffAt(0.5), 0.5));
    expect(20 * Math.log10(bottom / mid)).toBeLessThan(-6);
  });

  it('stays bounded at the extreme corner (floor cutoff, full resonance)', () => {
    const out = renderVoiceSequence(
      { ...DEFAULTS, cutoffHz: TB303_CUTOFF_FLOOR_HZ, resonance: 1, envAmount01: 1 },
      SR, SR * 2,
      [{ atSample: 0, pitchCv: 0, accented: false, gateDurationSamples: SR * 2 }],
    );
    expect(Number.isFinite(peak(out))).toBe(true);
    expect(peak(out)).toBeLessThan(8);
  });
});
