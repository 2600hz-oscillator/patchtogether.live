// art/scenarios/_meta/render-harness.test.ts
//
// INSTRUMENT GUARD for art/setup/render.ts's `render()`.
//
// `render()` used to be a Phase-1 stub that IGNORED `opts.moduleName` and
// returned the same 440 Hz sine for every module. Every scenario built on it
// was green by construction: "renders without throwing and produces a
// non-empty buffer" is satisfied by any constant, so the assertion could not
// distinguish a working module from a deleted one.
//
// The downstream `baseline-uniqueness` guard polices the SYMPTOM (two
// baselines with the same md5). This one polices the CAUSE: it asserts the
// harness is actually a function of the module it is handed. A fixed
// placeholder — a sine, silence, any module-independent constant — cannot
// pass the first test here, whatever its waveform.
//
// Scope, stated inside the gate: this checks that `render()` DISPATCHES on
// the module and renders real DSP. It does NOT verify the rendered audio is
// musically correct — that is what the per-module scenarios and their .f32
// baselines are for.

import { describe, it, expect } from 'vitest';
import { render, SAMPLE_RATE } from '../../setup/render';

/** A TS-worklet module (rendered through its shipping def factory) and a
 *  Faust module (rendered headless through @grame/faustwasm) — the harness's
 *  two dispatch arms, so a break in either is caught here. */
const WORKLET_MODULE = 'wavecel';
const FAUST_MODULE = 'mixmstrs';
const DUR_S = 0.1;

function rms(b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < b.length; i++) s += b[i]! * b[i]!;
  return Math.sqrt(s / b.length);
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > m) m = d;
  }
  return m;
}

describe('ART render harness — renders the module it is ASKED for', () => {
  it('two different modules produce two DIFFERENT signals', async () => {
    const a = await render({ moduleName: WORKLET_MODULE, durationS: DUR_S });
    const b = await render({ moduleName: FAUST_MODULE, durationS: DUR_S });

    expect(a.buffer.length).toBe(b.buffer.length);
    // THE negative control: a module-independent placeholder returns the same
    // samples for both names, so this difference is exactly what a stub lacks.
    const diff = maxAbsDiff(a.buffer, b.buffer);
    expect(
      diff,
      `render() returned the SAME signal for '${WORKLET_MODULE}' and ` +
        `'${FAUST_MODULE}' (max|Δ| ${diff}). The harness is ignoring ` +
        `opts.moduleName — it is a placeholder, not a render.`,
    ).toBeGreaterThan(0);
  });

  it('each arm renders AUDIBLE audio, not a zero buffer', async () => {
    // Guards the degenerate way the test above could pass: two different
    // all-but-silent buffers. Both arms must carry real signal.
    for (const moduleName of [WORKLET_MODULE, FAUST_MODULE]) {
      const { buffer } = await render({ moduleName, durationS: DUR_S });
      expect(rms(buffer), `${moduleName} rendered silence`).toBeGreaterThan(1e-4);
    }
  });

  it('the rendered buffer has the requested shape and is finite', async () => {
    const { buffer, sampleRate } = await render({
      moduleName: WORKLET_MODULE,
      durationS: DUR_S,
    });
    expect(sampleRate).toBe(SAMPLE_RATE);
    expect(buffer.length).toBe(Math.round(SAMPLE_RATE * DUR_S));
    const bad = buffer.findIndex((v) => !Number.isFinite(v));
    expect(bad, `non-finite sample at ${bad}`).toBe(-1);
  });

  it('is DETERMINISTIC — the same module renders bit-identically twice', async () => {
    const a = await render({ moduleName: WORKLET_MODULE, durationS: DUR_S });
    const b = await render({ moduleName: WORKLET_MODULE, durationS: DUR_S });
    expect(maxAbsDiff(a.buffer, b.buffer), 'render() is not reproducible').toBe(0);
  });

  it('responds to PARAMS — the same module renders differently when repatched', async () => {
    // A harness could dispatch on the name and still ignore everything else.
    // wavecel's `morph` reshapes the wavetable, so it must move the output.
    const base = await render({ moduleName: WORKLET_MODULE, durationS: DUR_S });
    const morphed = await render({
      moduleName: WORKLET_MODULE,
      durationS: DUR_S,
      params: { morph: 0.9 },
    });
    expect(
      maxAbsDiff(base.buffer, morphed.buffer),
      'render() ignored opts.params — the patch never reached the DSP',
    ).toBeGreaterThan(0);
  });

  it('rejects a module with no compiled artifact', async () => {
    await expect(
      render({ moduleName: 'definitely-not-a-module', durationS: DUR_S }),
    ).rejects.toThrow(/Compiled artifact missing/);
  });
});
