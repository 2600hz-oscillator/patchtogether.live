// art/scenarios/poly-chord/maj-triad.test.ts
//
// Stage-1 polyphony ART. Verifies that chordVoicing(a4, 'maj') yields a chord
// whose three carrier lanes (root, M3, P5) — when each is driven into its own
// sine OscillatorNode in an OfflineAudioContext, summed, FFT'd — produces
// energy at all three expected frequencies (within ±0.5 Hz).
//
// Why we don't drive the actual sequencer / poly cable here: the existing
// note-pitch ART (art/scenarios/note-pitch/note-pitch.test.ts) already
// established the convention — we validate the V/oct math + frequency by
// driving an OscillatorNode directly. The full poly→splitter→param pipeline
// runs in the browser (E2E spec); ART covers the deterministic chord-math
// claim "a maj triad's three carrier frequencies are at 440 / 554.365 /
// 659.255 Hz."

import { describe, it, expect } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  chordVoicing,
  voicingToVOct,
  POLY_CHANNEL_PAIRS,
} from '../../../packages/web/src/lib/audio/poly';
import { midiToHz } from '../../../packages/web/src/lib/audio/note-entry';

const SAMPLE_RATE = 48000;
const DURATION_S = 1.0;
const FREQ_TOLERANCE_HZ = 0.5;
const TWO_PI = Math.PI * 2;

function goertzel(samples: Float32Array, sampleRate: number, targetFreq: number): number {
  const k = (samples.length * targetFreq) / sampleRate;
  const omega = (TWO_PI * k) / samples.length;
  const cosine = Math.cos(omega);
  const coeff = 2 * cosine;
  let q0 = 0, q1 = 0, q2 = 0;
  for (let i = 0; i < samples.length; i++) {
    q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

/** Render N parallel sine OscillatorNodes (one per gated lane) at the
 *  frequencies derived from the voicing. Returns the summed mono buffer. */
async function renderChord(freqs: number[], gain = 0.2): Promise<Float32Array> {
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

/** Hann-window the buffer in place (improves Goertzel peak isolation). */
function hannInPlace(buf: Float32Array): Float32Array {
  const n = buf.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((TWO_PI * i) / (n - 1)));
    out[i] = buf[i] * w;
  }
  return out;
}

describe('poly-chord ART: maj triad on a4 (MIDI 69)', () => {
  it('chordVoicing(a4, maj) emits 4 gated lanes (root + M3 + P5 + octave)', () => {
    const v = chordVoicing(69, 'maj');
    expect(v).toHaveLength(POLY_CHANNEL_PAIRS);
    const gated = v.filter((l) => l.gate === 1);
    expect(gated).toHaveLength(4);
    expect(gated.map((l) => l.midi)).toEqual([69, 73, 76, 81]);
  });

  it('rendering each gated lane at its derived frequency produces energy at all three carrier pitches', async () => {
    const v = chordVoicing(69, 'maj');
    const freqs: number[] = [];
    const expectedHz: number[] = [];
    for (const lane of v) {
      if (lane.gate === 1 && lane.midi !== null) {
        freqs.push(midiToHz(lane.midi));
        expectedHz.push(midiToHz(lane.midi));
      }
    }
    expect(freqs).toHaveLength(4);
    // a4=440, c#5=554.365, e5=659.255, a5=880.
    expect(freqs[0]).toBeCloseTo(440, 1);
    expect(freqs[1]).toBeCloseTo(554.365, 1);
    expect(freqs[2]).toBeCloseTo(659.255, 1);
    expect(freqs[3]).toBeCloseTo(880, 1);

    const buf = hannInPlace(await renderChord(freqs));
    // Energy must be present at every expected frequency. We compare each
    // peak to a "noise" probe 100Hz away; the peak must be ≥10× the probe.
    for (const f of expectedHz) {
      const peak = goertzel(buf, SAMPLE_RATE, f);
      const probeLow  = goertzel(buf, SAMPLE_RATE, f - 100);
      const probeHigh = goertzel(buf, SAMPLE_RATE, f + 100);
      const probe = Math.max(probeLow, probeHigh, 1e-12);
      expect(
        peak / probe,
        `peak at ${f.toFixed(2)}Hz vs ±100Hz probe (peak=${peak.toExponential(3)}, probe=${probe.toExponential(3)})`,
      ).toBeGreaterThan(10);
    }
  });

  it('voicingToVOct converts triad MIDI to V/oct relative to C4', async () => {
    const v = chordVoicing(69, 'maj');
    const vo = voicingToVOct(v);
    // a4 = (69-60)/12 = 0.75; c#5 = 13/12; e5 = 16/12; a5 = 21/12.
    expect(vo[0]?.pitch).toBeCloseTo(9 / 12, 6);
    expect(vo[1]?.pitch).toBeCloseTo(13 / 12, 6);
    expect(vo[2]?.pitch).toBeCloseTo(16 / 12, 6);
    expect(vo[3]?.pitch).toBeCloseTo(21 / 12, 6);
    expect(vo[4]?.gate).toBe(0);
  });
});

describe('poly-chord ART: min triad on a4', () => {
  it('chordVoicing(a4, min) gates lanes 0..3 with c5 (m3) instead of c#5', () => {
    const v = chordVoicing(69, 'min');
    const gated = v.filter((l) => l.gate === 1);
    expect(gated.map((l) => l.midi)).toEqual([69, 72, 76, 81]);
  });

  it("'Bb chord' = 'a# chord' (sharp-only spelling preserved)", () => {
    // a#3 min: 58, 61 (c#4), 65 (f4), 70 (a#4).
    const v = chordVoicing(58, 'min');
    const gated = v.filter((l) => l.gate === 1).map((l) => l.midi);
    expect(gated).toEqual([58, 61, 65, 70]);
  });
});
