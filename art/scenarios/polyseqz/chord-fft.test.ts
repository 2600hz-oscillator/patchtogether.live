// art/scenarios/polyseqz/chord-fft.test.ts
//
// POLYSEQZ chord-FFT verification — DX7 isn't yet on main, so we substitute
// a deterministic OscillatorNode bank as the synth ("DX7-like sine voices")
// and assert that POLYSEQZ's chord output (as MIDI → freqs) lights up the
// expected carrier frequencies for each step's quality.
//
// The full POLYSEQZ → DX7 chain is exercised in the E2E spec; this ART layer
// is responsible for the deterministic numeric claim:
//   chordToVoices(60, 'maj') = [c4, e4, g4, c5, e5] = [261.63, 329.63, 392.00, 523.25, 659.26] Hz.
// FFT (Goertzel) the rendered audio and assert each expected peak is at
// least 10x its ±100Hz noise probe.
//
// We intentionally do NOT spin up the polyseqzDef factory here — the
// AudioModuleDef factory uses livePatch (a SyncedStore) that doesn't load
// cleanly inside vitest without a Yjs root. The chord math is what's under
// test; the factory's tick loop is exercised in the e2e spec.

import { describe, it, expect } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { chordToVoices, type ChordQualityName } from '../../../packages/web/src/lib/audio/chord-tables';
import { midiToHz } from '../../../packages/web/src/lib/audio/note-entry';

const SAMPLE_RATE = 48000;
const DURATION_S = 0.75;
const TWO_PI = Math.PI * 2;

function goertzel(samples: Float32Array, sampleRate: number, targetFreq: number): number {
  const k = (samples.length * targetFreq) / sampleRate;
  const omega = (TWO_PI * k) / samples.length;
  const cosine = Math.cos(omega);
  const coeff = 2 * cosine;
  let q1 = 0, q2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

function hannInPlace(buf: Float32Array): Float32Array {
  const n = buf.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((TWO_PI * i) / (n - 1)));
    out[i] = buf[i] * w;
  }
  return out;
}

/** Render N parallel sine OscillatorNodes (one per gated lane). Returns the
 *  summed mono buffer. */
async function renderChord(freqs: number[], gain = 0.15): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.round(SAMPLE_RATE * DURATION_S),
    sampleRate: SAMPLE_RATE,
  });
  const sum = ctx.createGain();
  sum.gain.value = gain;
  sum.connect(ctx.destination);
  for (const f of freqs) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f, 0);
    osc.connect(sum);
    osc.start(0);
    osc.stop(DURATION_S);
  }
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

function gatedFreqs(midi: number, q: ChordQualityName): number[] {
  const voices = chordToVoices(midi, q, 0, 'closed');
  return voices
    .filter((l) => l.gate === 1 && l.midi !== null)
    .map((l) => midiToHz(l.midi as number));
}

/** Assert that every expected frequency has clear FFT energy vs ±100Hz noise probe. */
function assertChordPeaks(buf: Float32Array, expectedHz: number[]) {
  const w = hannInPlace(buf);
  for (const f of expectedHz) {
    const peak = goertzel(w, SAMPLE_RATE, f);
    const probeLow = goertzel(w, SAMPLE_RATE, f - 100);
    const probeHigh = goertzel(w, SAMPLE_RATE, f + 100);
    const probe = Math.max(probeLow, probeHigh, 1e-12);
    expect(
      peak / probe,
      `peak at ${f.toFixed(2)}Hz vs ±100Hz probe (peak=${peak.toExponential(3)}, probe=${probe.toExponential(3)})`,
    ).toBeGreaterThan(10);
  }
}

describe('POLYSEQZ ART: Cmaj triad → DX7-like voices → FFT', () => {
  it('chordToVoices(C4, maj) emits 5 gated lanes (closed voicing)', () => {
    const v = chordToVoices(60, 'maj', 0, 'closed');
    const gated = v.filter((l) => l.gate === 1);
    expect(gated.length).toBe(5);
    expect(gated.map((l) => l.midi)).toEqual([60, 64, 67, 72, 76]);
  });

  it('rendered Cmaj chord has FFT peaks at C4 / E4 / G4 / C5 / E5', async () => {
    const freqs = gatedFreqs(60, 'maj');
    // Sanity: equal-tempered C4=261.63, E4=329.63, G4=392.00, C5=523.25, E5=659.26.
    expect(freqs[0]).toBeCloseTo(261.63, 1);
    expect(freqs[1]).toBeCloseTo(329.63, 1);
    expect(freqs[2]).toBeCloseTo(392.00, 1);
    expect(freqs[3]).toBeCloseTo(523.25, 1);
    expect(freqs[4]).toBeCloseTo(659.26, 1);
    const buf = await renderChord(freqs);
    assertChordPeaks(buf, freqs);
  });
});

describe('POLYSEQZ ART: progression Cmaj → Dmin → Em → Fmaj', () => {
  // Each step's chord, expected lowest 3 carriers (the triad — sufficient
  // to identify the chord; the closed-voicing octave doublings just thicken
  // existing peaks).
  const PROGRESSION: Array<{ root: number; q: ChordQualityName; name: string; expectedTriadHz: [number, number, number] }> = [
    { root: 60, q: 'maj', name: 'Cmaj', expectedTriadHz: [midiToHz(60), midiToHz(64), midiToHz(67)] },
    { root: 62, q: 'min', name: 'Dmin', expectedTriadHz: [midiToHz(62), midiToHz(65), midiToHz(69)] },
    { root: 64, q: 'min', name: 'Emin', expectedTriadHz: [midiToHz(64), midiToHz(67), midiToHz(71)] },
    { root: 65, q: 'maj', name: 'Fmaj', expectedTriadHz: [midiToHz(65), midiToHz(69), midiToHz(72)] },
  ];

  for (const step of PROGRESSION) {
    it(`${step.name} chord renders with FFT peaks at the expected triad frequencies`, async () => {
      const freqs = gatedFreqs(step.root, step.q);
      // The triad must be present in the gated set.
      for (const tri of step.expectedTriadHz) {
        const present = freqs.some((f) => Math.abs(f - tri) < 0.5);
        expect(present, `${step.name}: ${tri.toFixed(2)}Hz must be among rendered freqs`).toBe(true);
      }
      const buf = await renderChord(freqs);
      assertChordPeaks(buf, step.expectedTriadHz);
    });
  }
});

describe('POLYSEQZ ART: dom7 (4-voice chord) renders the 7th', () => {
  it('Cdom7 includes Bb4 (~466.16 Hz)', async () => {
    const freqs = gatedFreqs(60, 'dom7');
    const bb4 = midiToHz(70);
    expect(freqs.some((f) => Math.abs(f - bb4) < 0.5)).toBe(true);
    const buf = await renderChord(freqs);
    assertChordPeaks(buf, [midiToHz(60), midiToHz(64), midiToHz(67), bb4]);
  });
});
