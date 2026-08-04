// art/scenarios/meowbox/voct-real-dsp.test.ts
//
// THE 1V/OCT INVARIANT, MEASURED ON THE SHIPPED MEOWBOX WASM.
//
// WHY THIS FILE EXISTS. voct-tracking.test.ts guards a real historical bug —
// the DSP once computed `261.6256 * 2^(v/12)` (a semitone per volt) instead of
// `261.6256 * 2^v` (an octave per volt). But its "Layer 2" render check is
// CIRCULAR:
//
//     const f   = meowboxBaseFreqHz(v, 0);      // a TS helper
//     const buf = await renderOscillatorAt(f);  // a Web Audio SINE at exactly f
//     sweepHz.push(dominantFrequency(buf, SR)); // ...and the FFT finds f
//
// It feeds `f` in and checks `f` comes out. It proves an OscillatorNode set to
// F produces F — true regardless of meowbox, and it would pass unchanged if
// meowbox.dsp were deleted. The `.dsp` is never rendered. Its own comment says
// why ("node-web-audio-api can't host the Faust AudioWorklet"), and that reason
// is now STALE: art/setup/faust-offline.ts renders the real wasm headlessly,
// and meowbox ships a dist.
//
// So this file renders the ACTUAL module and measures what came out.
//
// ── WHAT IS AND IS NOT ASSERTED, and why ──
//
// ASSERTED: the octave RATIO. Measured on the shipped wasm, +1V steps give
// 2.006 / 1.988 / 2.012 / 1.976 — within ~1.2 % of a true doubling, versus the
// old bug's 2^(1/12) = 1.059. That is a 30x separation, so the bar is not tuned.
//
// NOT ASSERTED: the ABSOLUTE fundamental. Measured, every volt reads a CONSTANT
// ~152-173 cents sharp of `261.6256 * 2^v`:
//
//     -2V  72.1 Hz vs   65.4   (+168 cents)
//     -1V 144.6 Hz vs  130.8   (+173 cents)
//      0V 287.4 Hz vs  261.6   (+163 cents)
//     +1V 578.3 Hz vs  523.3   (+173 cents)
//     +2V 1142.9 Hz vs 1046.5  (+152 cents)
//
// A constant offset in CENTS across five octaves is not a scaling error — it is
// a fixed ratio, and meowbox is a MEOW: it glides by design, so a fundamental
// averaged over a window is not the base frequency. Pinning that number would
// pin the glide's shape at one arbitrary window, so it is deliberately left to
// the ratio test, which cancels it. Establishing the true base-frequency
// relationship needs the glide modelled and is NOT done here.
//
// ⚠ Do not "tighten" this by asserting absolute Hz without doing that work — a
// naive peak-pick over 40-2000 Hz lands on formants and harmonics (measured:
// a 2081-cent error at -1V), which is how a plausible-looking wrong number gets
// pinned.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../setup/capture';
import { renderFaustOffline } from '../../setup/faust-offline';
import { meowboxBaseFreqHz } from '../../../packages/web/src/lib/audio/modules/meowbox';

const SR = SAMPLE_RATE;
const N = Math.round(SR * 1.0);

/** Autocorrelation fundamental over [s, e).
 *
 *  Deliberately NOT a spectral peak-pick: meowbox is a formant-rich voiced
 *  model, so the loudest bin is frequently a harmonic or a formant rather than
 *  the fundamental (measured 435 Hz for a nominal 131 Hz note — a 2081-cent
 *  error). Autocorrelation locks to the PERIOD, which is what "fundamental"
 *  means here and is robust to whatever the harmonic structure is doing. */
function acfFundamental(b: Float32Array, s: number, e: number, loHz = 40, hiHz = 2000): number {
  const minLag = Math.floor(SR / hiHz);
  const maxLag = Math.ceil(SR / loHz);
  let best = -Infinity;
  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let d1 = 0;
    let d2 = 0;
    for (let i = s; i + lag < e; i++) {
      const a = b[i]!;
      const c = b[i + lag]!;
      num += a * c;
      d1 += a * a;
      d2 += c * c;
    }
    const r = num / Math.sqrt(Math.max(d1 * d2, 1e-20));
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  return SR / bestLag;
}

/** Render the REAL shipped meowbox with the gate held, at `volts` on the
 *  pitch CV. `process(gate, pitch)` → (L, R). */
async function renderMeowbox(volts: number, params: Record<string, number> = {}) {
  const gate = new Float32Array(N);
  for (let i = 0; i < Math.round(SR * 0.6); i++) gate[i] = 1;
  const pitch = new Float32Array(N).fill(volts);
  return renderFaustOffline({
    name: 'meowbox',
    totalSamples: N,
    inputs: [gate, pitch],
    params,
    outputs: ['L', 'R'],
  });
}

/** Measure the sustained portion, skipping the attack. */
const measure = (buf: Float32Array): number =>
  acfFundamental(buf, Math.round(SR * 0.15), Math.round(SR * 0.45));

const VOLTS = [-2, -1, 0, 1, 2] as const;

describe('meowbox — 1V/oct measured on the SHIPPED wasm (not a stand-in)', () => {
  it('every +1V step DOUBLES the measured fundamental of the real DSP', async () => {
    const hz: number[] = [];
    for (const v of VOLTS) hz.push(measure((await renderMeowbox(v)).L!));

    const ratios = hz.slice(1).map((f, i) => f / hz[i]!);
    for (const [i, ratio] of ratios.entries()) {
      expect(
        Math.abs(ratio - 2),
        `step ${VOLTS[i]}V→${VOLTS[i + 1]}V: the REAL meowbox moved by ×${ratio.toFixed(3)}, ` +
          'not ×2. This is the 1V/oct invariant measured on the shipped DSP — the ' +
          'historical bug (`2^(v/12)`) would show ×1.059. Sequence: ' +
          hz.map((f) => f.toFixed(1)).join(', '),
      ).toBeLessThan(0.1);
    }
  });

  it('the pitch KNOB composes with the CV — +12 semis moves the same as +1V', async () => {
    // The user-reported bug this scenario exists for: "pitch CV input does not
    // really track pitch and is different behavior than the pitch control".
    // Measured on the real DSP, not inferred from the TS helper.
    const viaCv = measure((await renderMeowbox(1)).L!);
    const viaKnob = measure((await renderMeowbox(0, { pitch: 12 })).L!);
    const cents = Math.abs(1200 * Math.log2(viaKnob / viaCv));
    expect(
      cents,
      `knob +12 semis gave ${viaKnob.toFixed(1)} Hz but CV +1V gave ${viaCv.toFixed(1)} Hz ` +
        `(${cents.toFixed(0)} cents apart) — the two pitch paths have diverged in the DSP`,
    ).toBeLessThan(60);
  });

  // ── Negative controls, on every run ──

  it('the estimator can tell an octave from a semitone (the actual bug class)', async () => {
    // Guards the bar itself: if acfFundamental ever returned a constant, or the
    // render returned silence, the ratio test above would pass vacuously.
    const base = measure((await renderMeowbox(0)).L!);
    const octaveUp = measure((await renderMeowbox(1)).L!);
    expect(octaveUp / base).toBeGreaterThan(1.8);
    // ...and the OLD bug's ratio must be clearly outside the accepted band.
    expect(Math.abs(Math.pow(2, 1 / 12) - 2)).toBeGreaterThan(0.1);
  });

  it('the real render is voiced and finite — no vacuous pass', async () => {
    const r = await renderMeowbox(0);
    for (const ch of ['L', 'R'] as const) {
      const buf = r[ch]!;
      expect(buf.length).toBe(N);
      expect(buf.some((v) => !Number.isFinite(v)), `${ch} has NaN/Inf`).toBe(false);
      const rms = Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length);
      expect(rms, `${ch} is silent — the harness rendered nothing`).toBeGreaterThan(1e-4);
    }
  });

  it('the TS helper still agrees with the C4 reference (the formula layer)', () => {
    // Kept explicitly as a FORMULA check, not dressed up as a render check.
    expect(Math.abs(meowboxBaseFreqHz(0, 0) - 261.6256)).toBeLessThan(0.01);
    expect(Math.abs(meowboxBaseFreqHz(1, 0) / meowboxBaseFreqHz(0, 0) - 2)).toBeLessThan(1e-9);
  });
});
