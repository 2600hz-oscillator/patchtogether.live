// art/scenarios/scope-tuner/internal-references.test.ts
//
// Layer 2 calibration: pitch tuner against project-internal reference
// instruments. The detector under test is YIN (packages/web/src/lib/audio/
// pitch-detect.ts). The signals here exercise harmonic content beyond the
// pure-sine math sanity in pitch-detect.test.ts:
//
//   - Saw-wave at the same per-MIDI Hz that ANALOGVCO produces. ANALOGVCO's
//     DSP is `os.sawtooth(f)` with f = 261.626 * 2^(pitch + tune/12 + ...).
//     ANALOGVCO can't be rendered under node-web-audio-api directly (its
//     output is a Faust AudioWorklet); we render the same fundamental as a
//     band-limited saw via the OscillatorNode 'sawtooth' type, which has
//     the same idealized infinite harmonic series the YIN tuner is
//     supposed to handle. The V/oct convention being tested is the
//     SHARED one across the codebase (see analog-vco.dsp + wavetable-vco.ts).
//
//   - Wavetable-equivalent — same fundamentals via a triangle source as a
//     proxy for WAVETABLEVCO's smoother spectrum.
//
//   - DX7 — rendered via the pure-TS dx7-render.ts (the ART-grade authoritative
//     renderer; the AudioWorklet keeps in sync via dx7-render.test.ts in
//     packages/web). DX7 produces real FM-synth harmonic content with mild
//     inharmonicity from modulation index, exactly the kind of signal that
//     fools naive autocorrelation. ±10 cent tolerance matches the spec.

import { describe, it, expect } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { detectPitch } from '../../../packages/web/src/lib/audio/pitch-detect';
import { renderDx7Note } from '../../../packages/web/src/lib/audio/dx7-render';
import { DX7_BUILTIN_BANK } from '../../../packages/web/src/lib/audio/dx7-banks';

const SR = 48000;
const DURATION_S = 1.0;
const C4_HZ = 261.625565;

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Render a band-limited saw at a given freq using OfflineAudioContext. */
async function renderSaw(hz: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.round(SR * DURATION_S),
    sampleRate: SR,
  });
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(hz, 0);
  osc.connect(ctx.destination);
  osc.start(0);
  osc.stop(DURATION_S);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

async function renderTriangle(hz: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.round(SR * DURATION_S),
    sampleRate: SR,
  });
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(hz, 0);
  osc.connect(ctx.destination);
  osc.start(0);
  osc.stop(DURATION_S);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

/** YIN reads a 2048-sample window — match the SCOPE analyser's fftSize. */
function take2048Window(buf: Float32Array): Float32Array {
  // Skip the attack — pull the window from the steady-state half.
  const start = Math.floor(buf.length / 2);
  return buf.subarray(start, start + 2048).slice();
}

/** Equal-tempered Hz match → midi number assertion via the SHARED V/oct
 *  convention `freqHz = C4_HZ * 2^vOct` where vOct = (midi - 60)/12. The
 *  ANALOGVCO/wavetable-vco DSP is anchored on C4 = 261.626. We anchor the
 *  TEST on midiToHz (A4 = 440) so a deviation surfaces as cents in the
 *  detector output, not as a frequency mismatch in our setup. */
const REFS_VCO: Array<{ midi: number; expectedNote: string }> = [
  { midi: 40, expectedNote: 'E2' },   // 82.41 Hz — bass register
  { midi: 48, expectedNote: 'C3' },   // 130.81 Hz
  { midi: 60, expectedNote: 'C4' },   // 261.63 Hz — middle C
  { midi: 69, expectedNote: 'A4' },   // 440 Hz — concert A
  { midi: 76, expectedNote: 'E5' },   // 659.26 Hz
  { midi: 84, expectedNote: 'C6' },   // 1046.50 Hz
];

describe('Layer 2 — ANALOGVCO-equivalent saw (same V/oct, same fundamentals)', () => {
  for (const ref of REFS_VCO) {
    it(`MIDI ${ref.midi} → "${ref.expectedNote}" within ±5 cents`, async () => {
      const hz = C4_HZ * Math.pow(2, (ref.midi - 60) / 12);
      const audio = await renderSaw(hz);
      const window = take2048Window(audio);
      const r = detectPitch(window, SR);
      expect(r.note, `expected ${ref.expectedNote}, got ${r.note} (hz=${r.hz})`).toBe(
        ref.expectedNote,
      );
      expect(
        Math.abs(r.cents!),
        `MIDI ${ref.midi} cents=${r.cents} (target ±5)`,
      ).toBeLessThan(5);
    });
  }
});

describe('Layer 2 — WAVETABLEVCO-equivalent triangle (same V/oct, smoother spectrum)', () => {
  for (const ref of REFS_VCO) {
    it(`MIDI ${ref.midi} → "${ref.expectedNote}" within ±5 cents`, async () => {
      const hz = C4_HZ * Math.pow(2, (ref.midi - 60) / 12);
      const audio = await renderTriangle(hz);
      const window = take2048Window(audio);
      const r = detectPitch(window, SR);
      expect(r.note, `expected ${ref.expectedNote}, got ${r.note} (hz=${r.hz})`).toBe(
        ref.expectedNote,
      );
      expect(
        Math.abs(r.cents!),
        `MIDI ${ref.midi} cents=${r.cents} (target ±5)`,
      ).toBeLessThan(5);
    });
  }
});

describe('Layer 2 — DX7 (FM with real harmonic + inharmonic content)', () => {
  // Use the BRASS 1 patch — algorithm 1, classic harmonic series with a slight
  // amount of FM modulation. The spec wants ±10 cents tolerance for DX7
  // because FM modulation index gives the spectrum some inharmonicity that
  // shifts the perceived fundamental compared to a pure sine.
  const voice = DX7_BUILTIN_BANK.find((v) => v.name === 'BRASS 1')!;

  it('DX7 BRASS 1 at MIDI 69 → "A4" within ±10 cents', () => {
    const buf = renderDx7Note(voice, {
      midi: 69,
      durationS: DURATION_S,
      sampleRate: SR,
      holdGate: true,
    });
    expect(buf.length).toBeGreaterThan(2048);
    const window = take2048Window(buf);
    const r = detectPitch(window, SR);
    expect(r.hz, 'detector returned a pitch').not.toBeNull();
    expect(r.note, `expected "A4", got ${r.note} (hz=${r.hz})`).toBe('A4');
    expect(
      Math.abs(r.cents!),
      `DX7 BRASS 1 A4 cents=${r.cents} (target ±10)`,
    ).toBeLessThan(10);
  });

  it('DX7 BRASS 1 at MIDI 60 → "C4" within ±10 cents', () => {
    const buf = renderDx7Note(voice, {
      midi: 60,
      durationS: DURATION_S,
      sampleRate: SR,
      holdGate: true,
    });
    const window = take2048Window(buf);
    const r = detectPitch(window, SR);
    expect(r.note, `expected "C4", got ${r.note} (hz=${r.hz})`).toBe('C4');
    expect(Math.abs(r.cents!)).toBeLessThan(10);
  });

  it('DX7 E.PIANO 1 at MIDI 69 → "A4" within ±10 cents', () => {
    const epiano = DX7_BUILTIN_BANK.find((v) => v.name === 'E.PIANO 1')!;
    const buf = renderDx7Note(epiano, {
      midi: 69,
      durationS: DURATION_S,
      sampleRate: SR,
      holdGate: true,
    });
    const window = take2048Window(buf);
    const r = detectPitch(window, SR);
    expect(r.note, `E.PIANO 1 A4 → ${r.note} (hz=${r.hz})`).toBe('A4');
    expect(Math.abs(r.cents!)).toBeLessThan(10);
  });
});

describe('Layer 2 — sanity: midiToHz consistency', () => {
  it('A4 anchor matches both conventions', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 5);
    expect(C4_HZ * Math.pow(2, 9 / 12)).toBeCloseTo(440, 2);
  });
});
