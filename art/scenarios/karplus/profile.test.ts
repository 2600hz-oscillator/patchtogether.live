// art/scenarios/karplus/profile.test.ts
//
// AUDIO PROFILE for KARPLUS (id `karplus` — the extended Karplus-Strong
// string/harp voice on the cofefve delay-line core). Ships with the module
// per the audio-profile gate: every new audio def lands with ≥1 committed
// baseline.
//
// Category: trigger-fired SOURCE with a decay tail. Driver: canonical
// trigger train — two plucks at 120 BPM over 1.5 s (≥1.0 s so the 2 s
// default DECAY tail is visible in the gallery; the second pluck lands on
// the still-ringing string, the module's physical re-strike behavior).
// Signature output captured: the single mono `out`.
//
// Rendered from the PURE core (packages/dsp/src/lib/karplus-dsp.ts
// karplusStep — the full EKS chain: seeded burst → color LP → position
// comb → cofefve DelayChannel string loop with tracked damping, dispersion
// allpasses, tracked DC blocker and ρ-compensated loop gain) with the def's
// shipping defaults — deterministic by construction: the strike reseeds the
// burst xorshift32 and the trigger train is epoch-pinned to sample 0.
//
// The .sha pin covers the worklet entry AND every lib the per-sample math
// flows through — including lib/analog-delay-core.ts, the SHARED cofefve
// core (so a delay-line change forces an intentional re-capture HERE too).
// Re-pin the .sha LAST (memory `art-sha-pin-regenerate-last`).

import { describe, expect, it } from 'vitest';
import {
  KARPLUS_DEFAULTS,
  karplusStep,
  makeKarplusState,
} from '../../../packages/dsp/src/lib/karplus-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { triggerTrain } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.5;

/** Render the default-patch 2-pluck train through the pure core. */
function renderProfile(): Record<string, Float32Array> {
  // Two plucks: rising edges at 0 ms and 500 ms (120 BPM), canonical
  // TRIGGER_PULSE_S-wide pulses. Accent + damp unpatched (0).
  const trig = triggerTrain({ totalS: DURATION_S, bpm: 120 });
  const p = { ...KARPLUS_DEFAULTS };
  const st = makeKarplusState(SR);
  return captureOutputs({ durationS: DURATION_S, outputs: ['out'] }, (i) => ({
    out: karplusStep(trig[i]!, 0, 0, p, SR, st),
  }));
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

/** Render a 3-note MELODIC phrase (2026-07-11 coverage audit: the golden
 *  must exercise the voice "plucking pitched notes", not one pitch): plucks
 *  at 0 / 0.5 / 1.0 s with the 1 V/oct input stepping A3 → C4 → E4
 *  (0 / +3 / +7 semitones — the module's real melodic path). */
function renderMelody(): Record<string, Float32Array> {
  const trig = triggerTrain({ totalS: DURATION_S, bpm: 120 });
  const p = { ...KARPLUS_DEFAULTS };
  const st = makeKarplusState(SR);
  return captureOutputs({ durationS: DURATION_S, outputs: ['melody'] }, (i) => {
    const t = i / SR;
    p.pitchCv = t < 0.5 ? 0 : t < 1.0 ? 3 / 12 : 7 / 12;
    return { melody: karplusStep(trig[i]!, 0, 0, p, SR, st) };
  });
}

/** Hann-windowed Goertzel magnitude of buf[from..to) at freq. */
function goertzelMag(buf: Float32Array, from: number, to: number, freq: number): number {
  const w = (2 * Math.PI * freq) / SR;
  const coeff = 2 * Math.cos(w);
  const n = to - from;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = buf[from + i]! * win + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
}

describe('ART karplus / audio profile (default patch, 2-pluck trigger train)', () => {
  it('renders a finite, audible, ringing, deterministic pluck train', () => {
    const { out } = renderProfile();
    const buf = out!;
    expect(buf.length).toBe(Math.round(SR * DURATION_S));
    expect(buf.every(Number.isFinite)).toBe(true);
    // Audible and bounded (the voice's own string physics bound it).
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThan(2);
    // BOTH plucks landed: attack-window energy after each rising edge.
    expect(rms(buf, 0, Math.round(0.1 * SR))).toBeGreaterThan(0.01);
    expect(rms(buf, Math.round(0.5 * SR), Math.round(0.6 * SR))).toBeGreaterThan(0.01);
    // The string RINGS (decay 2 s): the 1.2–1.45 s window still carries
    // energy, but less than the fresh second pluck.
    const tail = rms(buf, Math.round(1.2 * SR), Math.round(1.45 * SR));
    expect(tail).toBeGreaterThan(1e-3);
    expect(tail).toBeLessThan(rms(buf, Math.round(0.5 * SR), Math.round(0.6 * SR)));
    // DC ≈ 0 (position comb zero at DC + the in-loop tracked DC blocker).
    let sum = 0;
    for (const v of buf) sum += v;
    expect(Math.abs(sum / buf.length)).toBeLessThan(0.01);
    // Deterministic: a second render is bit-identical (seeded burst).
    const again = renderProfile().out!;
    let diff = 0;
    for (let i = 0; i < buf.length; i++) diff = Math.max(diff, Math.abs(buf[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the out profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha(
      'karplus.ts',
      'lib/karplus-dsp.ts',
      'lib/analog-delay-core.ts',
      'lib/dsp-utils.ts',
    );
    await pinAll('karplus', srcSha, renderProfile());
  });
});

describe('ART karplus / melodic phrase (3 plucks, 1 V/oct stepping A3→C4→E4)', () => {
  it('each pluck rings at ITS OWN sequenced pitch (the melodic 1 V/oct path)', () => {
    const { melody } = renderMelody();
    const buf = melody!;
    expect(buf.every(Number.isFinite)).toBe(true);
    // Three attacks landed.
    for (const at of [0, 0.5, 1.0]) {
      expect(rms(buf, Math.round(at * SR), Math.round((at + 0.1) * SR))).toBeGreaterThan(0.01);
    }
    // Per-note fundamental beats the OTHER two notes' fundamentals inside
    // its own sustain window (ring-over from earlier notes decays below the
    // fresh pluck — the phrase is audibly MELODIC, not three identical hits).
    const notes = [220, 220 * Math.pow(2, 3 / 12), 220 * Math.pow(2, 7 / 12)];
    const windows: Array<[number, number]> = [
      [0.15, 0.45],
      [0.65, 0.95],
      [1.15, 1.45],
    ];
    for (let n = 0; n < 3; n++) {
      const [w0, w1] = windows[n]!;
      const from = Math.round(w0 * SR);
      const to = Math.round(w1 * SR);
      const own = goertzelMag(buf, from, to, notes[n]!);
      for (let m = 0; m < 3; m++) {
        if (m === n) continue;
        expect(own, `note ${n} window dominated by its own f0 vs note ${m}`).toBeGreaterThan(
          goertzelMag(buf, from, to, notes[m]!),
        );
      }
    }
    // Deterministic re-render.
    const again = renderMelody().melody!;
    let diff = 0;
    for (let i = 0; i < buf.length; i++) diff = Math.max(diff, Math.abs(buf[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the melody baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha(
      'karplus.ts',
      'lib/karplus-dsp.ts',
      'lib/analog-delay-core.ts',
      'lib/dsp-utils.ts',
    );
    await pinAll('karplus', srcSha, renderMelody());
  });
});
