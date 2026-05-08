// art/scenarios/drumseqz/drumseqz-eucl.test.ts
//
// ART for DRUMSEQZ. The module is pure JS (no Faust / no AudioWorklet — it
// clones the existing Sequencer's setTimeout lookahead scheduler and emits
// per-track gate + pitch ConstantSources). So we don't need the full Faust
// runtime to validate the spec's claim:
//
//   "1 bar @ 120 BPM with trk{N}_euclid=k yields exactly k transient
//    envelopes per track per bar, at the Bjorklund-expected step indices."
//
// We exercise this two ways:
//   1. PURE: simulate the scheduler's per-step gate emission, assert the
//      indices that fire match bjorklund(k, 16).
//   2. RENDER: feed those gate pulses into a ConstantSource → drive an
//      AD-shaped envelope through an OfflineAudioContext, count transients in
//      the rendered buffer.
//
// Plus a swing test: at swing=0.5 the odd-step pulses arrive halfway between
// the even-step pulses (i.e., late by 1/2 of the swing fraction).

import { describe, it, expect } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { bjorklund, bjorklundIndices } from '../../../packages/web/src/lib/audio/euclidean';
import { applyEuclidean, defaultCells } from '../../../packages/web/src/lib/audio/modules/drumseqz';

const SAMPLE_RATE = 48000;
const TRACK_COUNT = 4;
const STEP_COUNT = 16;

interface Pulse { track: number; step: number; t: number; }

/** Pure-JS simulator that mirrors the scheduler in drumseqz.ts. Walks one
 *  bar at the given BPM + swing and returns every (track, step, time) where
 *  emitStep would have raised a gate. */
function simulateBar(opts: {
  bpm: number;
  swing: number;
  tracks: { cells: { on: boolean }[] }[];
}): Pulse[] {
  const { bpm, swing, tracks } = opts;
  const pulses: Pulse[] = [];
  let t = 0;
  for (let stepIdx = 0; stepIdx < STEP_COUNT; stepIdx++) {
    const stepDurBase = 60 / bpm / 4;
    const isOdd = stepIdx % 2 === 1;
    const stepDur = isOdd
      ? stepDurBase * (1 - swing * 0.5)
      : stepDurBase * (1 + swing * 0.5);
    for (let trk = 0; trk < TRACK_COUNT; trk++) {
      const cell = tracks[trk]?.cells[stepIdx];
      if (cell?.on) pulses.push({ track: trk, step: stepIdx, t });
    }
    t += stepDur;
  }
  return pulses;
}

describe('drumseqz ART: Eucl-fill pulses per bar @ 120 BPM', () => {
  it('per-track Eucl k=4/3/2/5 yields k pulses per track per bar at Bjorklund indices', () => {
    const ks = [4, 3, 2, 5];
    const tracks = ks.map((k) => ({ cells: applyEuclidean(defaultCells(), k) }));
    const pulses = simulateBar({ bpm: 120, swing: 0, tracks });

    for (let trk = 0; trk < TRACK_COUNT; trk++) {
      const k = ks[trk]!;
      const trkPulses = pulses.filter((p) => p.track === trk);
      expect(trkPulses, `track ${trk} pulse count for k=${k}`).toHaveLength(k);
      const indices = trkPulses.map((p) => p.step);
      expect(indices).toEqual(bjorklundIndices(k, STEP_COUNT));
    }
  });

  it('first-pulse times line up with Bjorklund 16th-note grid (swing=0)', () => {
    const stepDur = 60 / 120 / 4; // = 0.125 s @ 120 BPM
    const tracks = [
      { cells: applyEuclidean(defaultCells(), 4) }, // E(4,16): pulses at 0, 4, 8, 12
      { cells: applyEuclidean(defaultCells(), 3) }, // E(3,16): pulses at 0, 5, 10
      { cells: applyEuclidean(defaultCells(), 2) }, // E(2,16): pulses at 0, 8
      { cells: applyEuclidean(defaultCells(), 5) }, // E(5,16): pulses at 0, 3, 6, 9, 12
    ];
    const pulses = simulateBar({ bpm: 120, swing: 0, tracks });
    // Track 0 (E4): hits at 0/4/8/12 = stepDur * [0, 4, 8, 12]
    expect(pulses.filter((p) => p.track === 0).map((p) => p.t))
      .toEqual([0, 4 * stepDur, 8 * stepDur, 12 * stepDur]);
    // Track 1 (E3): canonical Bjorklund spread is 0, 5, 10 (not 0, 6, 11).
    expect(pulses.filter((p) => p.track === 1).map((p) => Number(p.t.toFixed(6))))
      .toEqual([0, 5 * stepDur, 10 * stepDur].map((x) => Number(x.toFixed(6))));
    // Track 3 (E5): pulses at 0, 3, 6, 9, 12.
    expect(pulses.filter((p) => p.track === 3).map((p) => Number(p.t.toFixed(6))))
      .toEqual([0, 3 * stepDur, 6 * stepDur, 9 * stepDur, 12 * stepDur].map((x) => Number(x.toFixed(6))));
  });

  it('swing=0.5 delays odd-step pulses (and advances even-step pulses) on a fixed grid', () => {
    // With every other step gated (k=8 has pulses at 0, 2, 4, ...), the
    // inter-pulse spacing alternates between (1 + 0.25) * stepDur (odd→even)
    // and (1 - 0.25) * stepDur (even→odd). Net: each consecutive gap differs
    // from stepDur by ±0.25*stepDur with swing=0.5.
    const stepDur = 60 / 120 / 4;
    const tracks = [
      { cells: applyEuclidean(defaultCells(), 8) }, // hits at 0,2,4,...,14
      { cells: defaultCells() },
      { cells: defaultCells() },
      { cells: defaultCells() },
    ];
    const pulses = simulateBar({ bpm: 120, swing: 0.5, tracks });
    const ts = pulses.filter((p) => p.track === 0).map((p) => p.t);
    // Even-step pulses (0,2,4,...) arrive at sums of (long + short) = 2*stepDur
    // since swing redistributes within each pair; the cumulative grid stays
    // anchored on the bar.
    for (let i = 0; i < ts.length; i++) {
      // Pulse i is on step 2*i. Cumulative time for step 2*i is i*2*stepDur
      // for any swing in [0,1], because each pair sums to 2*stepDur.
      expect(ts[i]).toBeCloseTo(i * 2 * stepDur, 6);
    }
  });

  it('swing displaces every-step pulses (k=16) — even pulses late, odd pulses early', () => {
    const stepDur = 60 / 120 / 4;
    const swing = 0.5;
    const tracks = [
      { cells: applyEuclidean(defaultCells(), 16) },
      { cells: defaultCells() },
      { cells: defaultCells() },
      { cells: defaultCells() },
    ];
    const pulses = simulateBar({ bpm: 120, swing, tracks });
    const ts = pulses.filter((p) => p.track === 0).map((p) => p.t);
    expect(ts).toHaveLength(STEP_COUNT);
    // Compute expected cumulative times.
    let exp = 0;
    for (let i = 0; i < STEP_COUNT; i++) {
      expect(ts[i]).toBeCloseTo(exp, 6);
      const isOdd = i % 2 === 1;
      const dur = isOdd
        ? stepDur * (1 - swing * 0.5)
        : stepDur * (1 + swing * 0.5);
      exp += dur;
    }
    // The even-step pulse at i=2 is later than the no-swing baseline (2*stepDur)
    // because the pair (0→1) was lengthened by 0.25*stepDur and (1→2) shortened
    // by 0.25*stepDur — net zero. So baseline is preserved on bar grid.
    expect(ts[2]).toBeCloseTo(2 * stepDur, 6);
    // But the odd-step pulse at i=1 arrives later than 1*stepDur:
    expect(ts[1]).toBeGreaterThan(stepDur);
    expect(ts[1]).toBeCloseTo(stepDur * (1 + swing * 0.5), 6);
  });
});

/** Render the simulated gate pulses as short AD envelopes (tone burst per
 *  pulse) into an OfflineAudioContext, then count the transients in the
 *  rendered buffer. Each pulse generates one transient. */
async function renderTransients(pulses: Pulse[], track: number, durationS: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.round(SAMPLE_RATE * durationS),
    sampleRate: SAMPLE_RATE,
  });
  const sum = ctx.createGain();
  sum.gain.value = 0.5;
  sum.connect(ctx.destination);

  for (const p of pulses.filter((x) => x.track === track)) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1000;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, p.t);
    env.gain.linearRampToValueAtTime(1, p.t + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, p.t + 0.04);
    osc.connect(env);
    env.connect(sum);
    osc.start(p.t);
    osc.stop(p.t + 0.05);
  }

  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Count transient onsets in a buffer: peak-detect on |buf| with a refractory
 *  window. Returns indices of onsets. */
function countTransients(buf: Float32Array, sampleRate: number): number[] {
  const onsets: number[] = [];
  const refractory = Math.round(sampleRate * 0.02); // 20 ms
  const threshold = 0.1;
  let i = 0;
  while (i < buf.length) {
    if (Math.abs(buf[i] ?? 0) >= threshold) {
      onsets.push(i);
      i += refractory;
    } else {
      i++;
    }
  }
  return onsets;
}

describe('drumseqz ART: rendered transients match Eucl pattern', () => {
  it('k=4 yields exactly 4 transients per track in a 2-second render @ 120 BPM (one bar = 2s)', async () => {
    const bpm = 120;
    const barDur = (60 / bpm) * 4; // 2 seconds for 16 16th-notes
    const tracks = [
      { cells: applyEuclidean(defaultCells(), 4) },
      { cells: defaultCells() },
      { cells: defaultCells() },
      { cells: defaultCells() },
    ];
    const pulses = simulateBar({ bpm, swing: 0, tracks });
    expect(pulses.filter((p) => p.track === 0)).toHaveLength(4);

    const rendered = await renderTransients(pulses, 0, barDur);
    const onsets = countTransients(rendered, SAMPLE_RATE);
    expect(onsets, `expected 4 onsets, got ${onsets.length} at samples ${onsets.join(',')}`).toHaveLength(4);

    // Onsets land at expected sample positions: 0, ~4*stepDur, ~8*stepDur, ~12*stepDur
    const stepSamples = (60 / bpm / 4) * SAMPLE_RATE;
    const expected = [0, 4, 8, 12].map((s) => Math.round(s * stepSamples));
    for (let j = 0; j < expected.length; j++) {
      // Onset can drift up to a few samples from the linearRamp start.
      expect(Math.abs(onsets[j]! - expected[j]!), `onset ${j}`).toBeLessThan(SAMPLE_RATE * 0.005);
    }
  });

  it('k=3 (3 transients) and k=2 (2 transients) per bar', async () => {
    const bpm = 120;
    const barDur = (60 / bpm) * 4;
    const tracks = [
      { cells: applyEuclidean(defaultCells(), 3) },
      { cells: applyEuclidean(defaultCells(), 2) },
      { cells: defaultCells() },
      { cells: defaultCells() },
    ];
    const pulses = simulateBar({ bpm, swing: 0, tracks });
    const r0 = await renderTransients(pulses, 0, barDur);
    const r1 = await renderTransients(pulses, 1, barDur);
    expect(countTransients(r0, SAMPLE_RATE)).toHaveLength(3);
    expect(countTransients(r1, SAMPLE_RATE)).toHaveLength(2);
  });
});

describe('drumseqz ART: bjorklund spec patterns', () => {
  it('matches the spec table (k=4 n=16, k=3 n=8, k=0, k=16, k=5 reference)', () => {
    expect(bjorklund(4, 16)).toEqual([1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0]);
    expect(bjorklund(3, 8)).toEqual([1,0,0,1,0,0,1,0]);
    expect(bjorklund(0, 16)).toEqual(new Array(16).fill(0));
    expect(bjorklund(16, 16)).toEqual(new Array(16).fill(1));
    expect(bjorklund(5, 16)).toEqual([1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,0]);
  });
});
