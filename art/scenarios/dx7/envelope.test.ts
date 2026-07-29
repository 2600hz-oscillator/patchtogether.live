// art/scenarios/dx7/envelope.test.ts
//
// The DX7 OPERATOR ENVELOPE, at the audio tier.
//
// RE-AUTHORED for the authentic envelope law (PR 0b). The previous version of
// this file asserted three things that were all still true of the WRONG
// engine — "release goes down", "a fast attack peaks early", "a slow attack
// does not" — and so it stayed green through an envelope that started at
// silence, had no sustain at all, and used a time-constant law unrelated to
// the hardware's. What it never asked was the question that matters: *what
// does a held note do?*
//
// The four behaviours the law actually claims (see the mirrored block in
// packages/web/src/lib/audio/dx7-syx.ts for the msfa + hexter provenance):
//
//   1. The envelope IDLES AND ENDS at L4 — L4 is the start level, not just
//      the release target.
//   2. It HOLDS AT L3 for as long as the gate is high. This is the sustain,
//      and it is the change with the widest audible reach: before it, every
//      patch decayed to L4 under a held gate.
//   3. The release, entered only on gate-off, targets L4.
//   4. Rates are LINEAR IN dB at hexter's hardware-measured speeds; the
//      attack is ~8x faster than a decay at the same rate byte.
//
// These are asserted against the RENDER path (dx7-render.ts) because that is
// what ART reads; the worklet is held to the same law by the textual +
// behavioural mirror gate in dx7-envelope-mirror.test.ts.

import { describe, it, expect } from 'vitest';
import { renderDx7Note, rms } from '../../../packages/web/src/lib/audio/dx7-render';
import { findBuiltinPatch } from '../../../packages/web/src/lib/audio/dx7-banks';
import {
  dx7DetuneFactor,
  dx7FixedHz,
  dx7LevelToAmp,
  dx7LevelToDb,
  dx7RateToDbPerSec,
} from '../../../packages/web/src/lib/audio/dx7-syx';
import type { DX7Voice } from '../../../packages/web/src/lib/audio/dx7-syx';

const SAMPLE_RATE = 48000;

/**
 * A patch whose output is ONE bare sine, so the rendered waveform's envelope
 * IS the operator envelope. Algorithm 1's carriers are op1 + op3; every
 * operator except op1 is silenced, feedback is 0, so nothing modulates and
 * nothing else reaches the bus.
 */
function probeVoice(opts: {
  r: [number, number, number, number];
  l: [number, number, number, number];
  level?: number;
  fixed?: boolean;
  coarse?: number;
  fine?: number;
}): DX7Voice {
  const silent = {
    r: [99, 99, 99, 99] as [number, number, number, number],
    l: [0, 0, 0, 0] as [number, number, number, number],
    ratio: 1,
    level: 0,
    detune: 7,
    detuneFactor: dx7DetuneFactor(7),
    velocitySens: 0,
    fixedMode: false,
    fixedHz: dx7FixedHz(0, 0),
  };
  const coarse = opts.coarse ?? 1;
  const fine = opts.fine ?? 0;
  return {
    name: 'EG PROBE',
    algorithm: 1,
    feedback: 0,
    operators: [
      {
        ...silent,
        r: opts.r,
        l: opts.l,
        ratio: (coarse === 0 ? 0.5 : coarse) * (1 + fine / 100),
        level: opts.level ?? 99,
        fixedMode: opts.fixed ?? false,
        fixedHz: dx7FixedHz(coarse, fine),
      },
      { ...silent }, { ...silent }, { ...silent }, { ...silent }, { ...silent },
    ],
    pitchEg: { r: [99, 99, 99, 99], l: [50, 50, 50, 50] },
    lfo: { speed: 0, delay: 0, pmd: 0, amd: 0, sync: false, waveform: 0, pitchModSens: 0 },
    transpose: 24,
  };
}

/** Peak |sample| over a window, in seconds. The renderer applies a fixed 0.4
 *  headroom trim, so this is `envelope * outputAmp * 0.4`. */
function peakBetween(buf: Float32Array, fromS: number, toS: number): number {
  const a = Math.max(0, Math.round(fromS * SAMPLE_RATE));
  const b = Math.min(buf.length, Math.round(toS * SAMPLE_RATE));
  let p = 0;
  for (let i = a; i < b; i++) p = Math.max(p, Math.abs(buf[i]!));
  return p;
}

/** The peak amplitude the probe patch renders when its envelope sits at
 *  `level` — i.e. what to expect from a hold or an idle. */
function expectedPeak(level: number, opLevel = 99): number {
  return dx7LevelToAmp(level) * dx7LevelToAmp(opLevel) * 0.4;
}

describe('DX7 ART: envelope — L4 idle', () => {
  it('a patch with L4 > 0 is ALREADY SOUNDING at sample 0', () => {
    // Rates 0 everywhere: nothing can move perceptibly inside 20 ms, so any
    // output at all in that window came from the idle level, not the attack.
    const buf = renderDx7Note(probeVoice({ r: [0, 0, 0, 0], l: [99, 99, 99, 70] }), {
      midi: 60, durationS: 0.02, sampleRate: SAMPLE_RATE, holdGate: true,
    });
    const p = peakBetween(buf, 0, 0.02);
    expect(p, 'idles at L4 = 70').toBeGreaterThan(expectedPeak(70) * 0.9);
    expect(p).toBeLessThan(expectedPeak(70) * 1.15);
  });

  it('a patch with L4 = 0 starts from silence (the overwhelmingly common case)', () => {
    const buf = renderDx7Note(probeVoice({ r: [0, 0, 0, 0], l: [99, 99, 99, 0] }), {
      midi: 60, durationS: 0.02, sampleRate: SAMPLE_RATE, holdGate: true,
    });
    // Rate 0 from the floor is ~0.23 dB/s, so 20 ms of attack is inaudible.
    expect(peakBetween(buf, 0, 0.02)).toBeLessThan(expectedPeak(35));
  });
});

describe('DX7 ART: envelope — the L3 HOLD (the sustain)', () => {
  // Fast rates: segments 0..2 complete in a few ms, so everything after that
  // is the hold. Before PR 0b this patch fell all the way to L4 = 0 and the
  // "sustain" was silence.
  const HELD = probeVoice({ r: [99, 99, 99, 40], l: [99, 90, 70, 0] });

  it('holds at L3 for as long as the gate is high — 4 seconds of it', () => {
    const buf = renderDx7Note(HELD, {
      midi: 60, durationS: 4, sampleRate: SAMPLE_RATE, holdGate: true,
    });
    const want = expectedPeak(70);
    for (const t of [0.05, 0.5, 1, 2, 3, 3.9]) {
      const p = peakBetween(buf, t, t + 0.02);
      expect(p, `held level at ${t}s`).toBeGreaterThan(want * 0.97);
      expect(p, `held level at ${t}s`).toBeLessThan(want * 1.03);
    }
  });

  it('the hold does not drift: last 100 ms RMS equals first-second RMS', () => {
    const buf = renderDx7Note(HELD, {
      midi: 60, durationS: 4, sampleRate: SAMPLE_RATE, holdGate: true,
    });
    const early = rms(buf.subarray(Math.round(0.9 * SAMPLE_RATE), Math.round(1.0 * SAMPLE_RATE)));
    const late = rms(buf.subarray(buf.length - Math.round(0.1 * SAMPLE_RATE)));
    expect(late / early, 'late/early RMS over a 3-second hold').toBeCloseTo(1, 2);
  });

  it('L3 sets the held level (60 vs 90 differ by exactly 22.5 dB)', () => {
    const at = (l3: number) => peakBetween(
      renderDx7Note(probeVoice({ r: [99, 99, 99, 40], l: [99, 99, l3, 0] }), {
        midi: 60, durationS: 1, sampleRate: SAMPLE_RATE, holdGate: true,
      }),
      0.5, 0.6,
    );
    const db = 20 * Math.log10(at(90) / at(60));
    expect(db, 'L3 90 vs 60').toBeCloseTo(dx7LevelToDb(90) - dx7LevelToDb(60), 1);
  });
});

describe('DX7 ART: envelope — release', () => {
  it('release targets L4, not zero: an L4 > 0 patch keeps ringing', () => {
    const buf = renderDx7Note(probeVoice({ r: [99, 99, 99, 99], l: [99, 99, 99, 55] }), {
      midi: 60, durationS: 1, sampleRate: SAMPLE_RATE, holdGate: false, // gate off at 0.5 s
    });
    const p = peakBetween(buf, 0.9, 1.0);
    expect(p, 'settles on L4 = 55').toBeGreaterThan(expectedPeak(55) * 0.9);
    expect(p).toBeLessThan(expectedPeak(55) * 1.15);
  });

  it('release to L4 = 0 reaches true silence', () => {
    const buf = renderDx7Note(probeVoice({ r: [99, 99, 99, 99], l: [99, 99, 99, 0] }), {
      midi: 60, durationS: 1, sampleRate: SAMPLE_RATE, holdGate: false,
    });
    expect(peakBetween(buf, 0.9, 1.0)).toBe(0);
  });

  it('release segment drives the envelope toward 0 (STRINGS 1)', () => {
    const patch = findBuiltinPatch('STRINGS 1')!;
    const buf = renderDx7Note(patch, {
      midi: 60, durationS: 1.5, sampleRate: SAMPLE_RATE, holdGate: false,
    });
    const releaseStart = Math.round(0.75 * SAMPLE_RATE);
    const earlyRelease = buf.subarray(releaseStart, releaseStart + Math.round(0.05 * SAMPLE_RATE));
    const lateRelease = buf.subarray(buf.length - Math.round(0.1 * SAMPLE_RATE));
    expect(rms(lateRelease), 'late release RMS < early release RMS').toBeLessThan(rms(earlyRelease));
  });
});

describe('DX7 ART: envelope — the rate law reaches the audio', () => {
  it('a rate-50 full-scale decay takes hexter\'s measured 1.24 s', () => {
    // L1 = 99 held (rate 99 attack), then R2 = 50 down to L2 = 0. The
    // hardware-measured full-scale decay at rate 50 is 1.240 s.
    const buf = renderDx7Note(probeVoice({ r: [99, 50, 99, 99], l: [99, 0, 0, 0] }), {
      midi: 60, durationS: 2, sampleRate: SAMPLE_RATE, holdGate: true,
    });
    // Find the last sample above the -60 dB point of the peak; the decay is
    // linear in dB, so time-to-(-60 dB) is 60/74.25 of the full-scale time.
    const peak = peakBetween(buf, 0, 0.02);
    const thresh = peak * Math.pow(10, -60 / 20);
    let last = 0;
    for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]!) > thresh) last = i;
    const measuredS = last / SAMPLE_RATE;
    const predictedS = (60 / -dx7LevelToDb(0)) * (-dx7LevelToDb(0) / dx7RateToDbPerSec(50));
    expect(measuredS, `-60 dB at ${measuredS}s, predicted ${predictedS}s`)
      .toBeGreaterThan(predictedS * 0.95);
    expect(measuredS).toBeLessThan(predictedS * 1.05);
  });

  it('MARIMBA (rate-99 attack) peaks within 30 ms', () => {
    const buf = renderDx7Note(findBuiltinPatch('MARIMBA')!, {
      midi: 60, durationS: 0.2, sampleRate: SAMPLE_RATE, holdGate: true,
    });
    let peakIdx = 0;
    let peakVal = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i]!);
      if (v > peakVal) { peakVal = v; peakIdx = i; }
    }
    expect((peakIdx / SAMPLE_RATE) * 1000, 'MARIMBA peak in the first 30 ms').toBeLessThan(30);
  });

  it('STRINGS 1 (rate-25 attack) takes SECONDS, not milliseconds, to open up', () => {
    // R1 = 25 → hexter measures a 2.477 s full attack, so the patch is still
    // far from its top a quarter of a second in.
    //
    // Asserted as a 2-second-vs-quarter-second level ratio, NOT as monotone
    // per-window RMS: STRINGS is four detuned carriers on algorithm 22 with a
    // modulator (op6, R1 = 30) whose envelope opens on its own schedule, so
    // broadband RMS genuinely dips around 1 s as FM energy redistributes
    // across the spectrum before the carriers finish rising. Both facts are
    // real FM behaviour; only the second is a stable assertion.
    const buf = renderDx7Note(findBuiltinPatch('STRINGS 1')!, {
      midi: 60, durationS: 2, sampleRate: SAMPLE_RATE, holdGate: true,
    });
    const q = Math.round(0.125 * SAMPLE_RATE);
    const quarterSecond = rms(buf.subarray(q, 2 * q));
    const twoSeconds = rms(buf.subarray(buf.length - q));
    expect(twoSeconds / quarterSecond, 'level at 2 s vs at 0.25 s').toBeGreaterThan(3);

    // And the classic assertion: it has NOT peaked in the first 20 ms.
    let peakIdx = 0;
    let peakVal = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i]!);
      if (v > peakVal) { peakVal = v; peakIdx = i; }
    }
    expect((peakIdx / SAMPLE_RATE) * 1000, 'STRINGS still growing at 20 ms').toBeGreaterThan(20);
  });
});

describe('DX7 ART: FIXED-frequency operators', () => {
  /**
   * Measure the rendered pitch from FIRST to LAST rising zero crossing, so a
   * partial cycle at either end of the window cannot bias the result (a plain
   * crossings/duration count is quantised to 1/window ≈ 2.5 Hz and reads
   * 97.5 Hz for a true 100).
   */
  function measuredHz(buf: Float32Array, fromS: number, toS: number): number {
    const from = Math.round(fromS * SAMPLE_RATE);
    const to = Math.round(toS * SAMPLE_RATE);
    let first = -1;
    let last = -1;
    let n = 0;
    for (let i = from + 1; i < to; i++) {
      if (buf[i - 1]! < 0 && buf[i]! >= 0) {
        if (first < 0) first = i;
        last = i;
        n++;
      }
    }
    expect(n, 'need at least two cycles to measure').toBeGreaterThan(1);
    return ((n - 1) * SAMPLE_RATE) / (last - first);
  }

  it('a fixed operator ignores the note pitch entirely', () => {
    // coarse 2, fine 0 → 100 Hz, whatever key is played.
    expect(dx7FixedHz(2, 0)).toBeCloseTo(100, 9);
    const v = probeVoice({ r: [99, 99, 99, 40], l: [99, 99, 99, 0], fixed: true, coarse: 2 });
    const at = (midi: number) => measuredHz(
      renderDx7Note(v, { midi, durationS: 0.5, sampleRate: SAMPLE_RATE, holdGate: true }),
      0.1, 0.5,
    );
    expect(at(60), 'C4 → 100 Hz').toBeCloseTo(100, 1);
    expect(at(84), 'C6 → still 100 Hz').toBeCloseTo(100, 1);
    expect(at(36), 'C2 → still 100 Hz').toBeCloseTo(100, 1);
  });

  it('fine sweeps the decade: coarse 2 / fine 30 is 199.5 Hz', () => {
    expect(dx7FixedHz(2, 30)).toBeCloseTo(199.526, 3);
    const v = probeVoice({
      r: [99, 99, 99, 40], l: [99, 99, 99, 0], fixed: true, coarse: 2, fine: 30,
    });
    const buf = renderDx7Note(v, {
      midi: 48, durationS: 0.5, sampleRate: SAMPLE_RATE, holdGate: true,
    });
    expect(measuredHz(buf, 0.1, 0.5)).toBeCloseTo(199.526, 1);
  });

  it('coarse wraps every 4: coarse 6 is the same 100 Hz as coarse 2', () => {
    const at = (coarse: number) => measuredHz(
      renderDx7Note(
        probeVoice({ r: [99, 99, 99, 40], l: [99, 99, 99, 0], fixed: true, coarse }),
        { midi: 60, durationS: 0.5, sampleRate: SAMPLE_RATE, holdGate: true },
      ),
      0.1, 0.5,
    );
    expect(at(6)).toBeCloseTo(at(2), 1);
  });
});
