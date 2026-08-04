// packages/dsp/src/lib/analog-delay-core.test.ts
//
// Behavioral proof for the OWN-CODE AnalogDelayCore (the COFEFVE DELAY
// engine). These assert the SPEC'd effect — echo at the delay time, a decaying
// feedback train, tempo sync, wow/flutter modulation, wet/dry split, ducking,
// drive, feedback stability, and the L==R bus-duplicate + determinism the ART
// profile relies on — NOT bit-exact numbers.

import { describe, it, expect } from 'vitest';
import {
  AnalogDelayCore,
  type AnalogDelaySettings,
  DelayChannel,
  SVF_DAMPING,
  SVF_F_MAX,
  SYNC_BEATS,
  TAPE_MAX,
} from './analog-delay-core';

const SR = 48000;

/** A full default settings object; override per test. */
function settings(over: Partial<AnalogDelaySettings> = {}): AnalogDelaySettings {
  return {
    delayTime: 0.2,
    tempoSync: 0,
    beatPeriodS: 0,
    lfoAmount: 0,
    lfoFrequency: 2,
    driftAmount: 0,
    driftSpeed: 1,
    feedback: 0.5,
    stereoOffset: 0,
    pan: 0,
    panMode: 0,
    duckAmount: 0,
    duckAttack: 10,
    duckRelease: 10,
    filterMode: 0,
    lowCut: 1,
    highCut: 0.001,
    driveGain: 0,
    driveMix: 1,
    driveCutoff: 1,
    driveIterations: 1,
    dryVolume: 1,
    wetVolume: 0.5,
    ...over,
  };
}

/** Render `seconds` of mono input (fed to both L+R) and return outL. */
function render(
  core: AnalogDelayCore,
  s: AnalogDelaySettings,
  seconds: number,
  inputFn: (n: number) => number,
): Float32Array {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = inputFn(i);
    core.processSample(s, v, v);
    out[i] = core.outL;
  }
  return out;
}

function peakIndex(buf: Float32Array, from = 0): number {
  let bi = from;
  let bv = -Infinity;
  for (let i = from; i < buf.length; i++) {
    const a = Math.abs(buf[i]!);
    if (a > bv) {
      bv = a;
      bi = i;
    }
  }
  return bi;
}

function energy(buf: Float32Array, from = 0, to = buf.length): number {
  let e = 0;
  for (let i = from; i < to; i++) e += buf[i]! * buf[i]!;
  return e;
}

describe('AnalogDelayCore — SYNC_BEATS table', () => {
  it('has a quarter note (index 6) == exactly 1 beat', () => {
    expect(SYNC_BEATS[6]).toBe(1);
    expect(SYNC_BEATS[0]).toBe(0); // Off sentinel
    expect(SYNC_BEATS.length).toBe(20);
  });
});

describe('AnalogDelayCore — echo timing + decay', () => {
  it('an impulse produces a wet echo near the configured delay time', () => {
    const core = new AnalogDelayCore(SR);
    const s = settings({ delayTime: 0.1, feedback: 0, dryVolume: 0, wetVolume: 1 });
    const out = render(core, s, 0.3, (n) => (n === 0 ? 1 : 0));
    const pk = peakIndex(out, 1);
    const expected = 0.1 * SR;
    // Cubic interp + the ~10 ms read-pointer easing smear the peak — a generous
    // window (the point is "a delayed echo near the configured time").
    expect(pk).toBeGreaterThan(expected * 0.5);
    expect(pk).toBeLessThan(expected * 1.6);
  });

  it('feedback yields a DECAYING train of repeats; more feedback = louder tail', () => {
    const s = (fb: number) =>
      settings({ delayTime: 0.05, feedback: fb, dryVolume: 0, wetVolume: 1 });
    const low = render(new AnalogDelayCore(SR), s(0.3), 0.4, (n) => (n === 0 ? 1 : 0));
    const high = render(new AnalogDelayCore(SR), s(0.75), 0.4, (n) => (n === 0 ? 1 : 0));
    const tailFrom = Math.round(0.2 * SR); // ~4 repeats in
    const eLow = energy(low, tailFrom);
    const eHigh = energy(high, tailFrom);
    expect(eLow).toBeGreaterThan(0); // there IS a decaying tail
    expect(eHigh).toBeGreaterThan(eLow); // higher feedback rings longer
    // And it decays within one render: late energy << early echo energy.
    const early = energy(high, Math.round(0.04 * SR), Math.round(0.12 * SR));
    const late = energy(high, Math.round(0.32 * SR), Math.round(0.4 * SR));
    expect(late).toBeLessThan(early);
  });
});

describe('AnalogDelayCore — tempo sync', () => {
  it('tempoSync = 1/4 locks the echo to one beat period (beatPeriodS), not the TIME fallback', () => {
    const core = new AnalogDelayCore(SR);
    const beatS = 0.12;
    const s = settings({
      tempoSync: 6, // quarter note = 1 beat
      beatPeriodS: beatS,
      feedback: 0,
      dryVolume: 0,
      wetVolume: 1,
      delayTime: 0.5, // free-running fallback — must be IGNORED
    });
    const out = render(core, s, 0.5, (n) => (n === 0 ? 1 : 0));
    const pk = peakIndex(out, 1);
    const expected = beatS * SR;
    expect(pk).toBeGreaterThan(expected * 0.5);
    expect(pk).toBeLessThan(expected * 1.6);
    expect(pk).toBeLessThan(0.5 * SR * 0.8); // definitely not the 0.5 s fallback
  });

  it('tempoSync Off ignores beatPeriodS and uses the free-running TIME', () => {
    const core = new AnalogDelayCore(SR);
    const s = settings({
      tempoSync: 0,
      beatPeriodS: 0.4, // present but must be ignored
      delayTime: 0.1,
      feedback: 0,
      dryVolume: 0,
      wetVolume: 1,
    });
    const out = render(core, s, 0.3, (n) => (n === 0 ? 1 : 0));
    const pk = peakIndex(out, 1);
    const expected = 0.1 * SR;
    expect(pk).toBeGreaterThan(expected * 0.5);
    expect(pk).toBeLessThan(expected * 1.6);
  });
});

describe('AnalogDelayCore — wow/flutter modulation', () => {
  it('a nonzero LFO amount audibly changes the wet output vs no modulation', () => {
    const tone = (n: number) => Math.sin((2 * Math.PI * 220 * n) / SR) * 0.7;
    const flat = render(
      new AnalogDelayCore(SR),
      settings({ delayTime: 0.05, feedback: 0.4, dryVolume: 0, wetVolume: 1, lfoAmount: 0 }),
      0.4,
      tone,
    );
    const wobbled = render(
      new AnalogDelayCore(SR),
      settings({
        delayTime: 0.05,
        feedback: 0.4,
        dryVolume: 0,
        wetVolume: 1,
        lfoAmount: 0.3,
        lfoFrequency: 6,
      }),
      0.4,
      tone,
    );
    let diff = 0;
    const from = Math.round(0.1 * SR);
    for (let i = from; i < flat.length; i++) diff += Math.abs(flat[i]! - wobbled[i]!);
    expect(diff).toBeGreaterThan(0); // the LFO warps the read time
  });

  it('DRIFT is deterministic — same seed → bit-identical renders', () => {
    const s = settings({ delayTime: 0.05, feedback: 0.4, driftAmount: 0.04, driftSpeed: 5, dryVolume: 0, wetVolume: 1 });
    const tone = (n: number) => Math.sin((2 * Math.PI * 180 * n) / SR) * 0.6;
    const a = render(new AnalogDelayCore(SR), s, 0.3, tone);
    const b = render(new AnalogDelayCore(SR), s, 0.3, tone);
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    expect(maxDiff).toBe(0);
  });
});

describe('AnalogDelayCore — wet/dry split', () => {
  it('dry-only (wet=0) passes the input through with NO delayed echo', () => {
    const core = new AnalogDelayCore(SR);
    const s = settings({ delayTime: 0.1, feedback: 0.6, dryVolume: 1, wetVolume: 0 });
    const out = render(core, s, 0.3, (n) => (n === 0 ? 1 : 0));
    // The only energy is the dry impulse at t=0; the echo window is silent.
    expect(Math.abs(out[0]!)).toBeGreaterThan(0.5);
    const echoWin = energy(out, Math.round(0.09 * SR), Math.round(0.11 * SR));
    expect(echoWin).toBeLessThan(1e-9);
  });

  it('wet-only (dry=0) has NO t=0 dry spike but DOES have the delayed echo', () => {
    const core = new AnalogDelayCore(SR);
    const s = settings({ delayTime: 0.1, feedback: 0, dryVolume: 0, wetVolume: 1 });
    const out = render(core, s, 0.3, (n) => (n === 0 ? 1 : 0));
    expect(Math.abs(out[0]!)).toBeLessThan(1e-6); // no dry passthrough
    const echoWin = energy(out, Math.round(0.08 * SR), Math.round(0.12 * SR));
    expect(echoWin).toBeGreaterThan(0);
  });
});

describe('AnalogDelayCore — ducking', () => {
  it('ducking attenuates the wet while dry signal is loud', () => {
    const tone = (n: number) => Math.sin((2 * Math.PI * 220 * n) / SR) * 0.8;
    const base: Partial<AnalogDelaySettings> = {
      delayTime: 0.05,
      feedback: 0.5,
      dryVolume: 0, // measure wet only
      wetVolume: 1,
      duckAttack: 5,
      duckRelease: 5,
    };
    const unducked = render(new AnalogDelayCore(SR), settings({ ...base, duckAmount: 0 }), 0.5, tone);
    const ducked = render(new AnalogDelayCore(SR), settings({ ...base, duckAmount: 10 }), 0.5, tone);
    const from = Math.round(0.2 * SR);
    const rms = (b: Float32Array) => Math.sqrt(energy(b, from) / (b.length - from));
    expect(rms(ducked)).toBeLessThan(rms(unducked) * 0.85);
  });
});

describe('AnalogDelayCore — drive', () => {
  it('drive saturation changes the wet signal; drive=0 is a clean bypass', () => {
    const tone = (n: number) => Math.sin((2 * Math.PI * 110 * n) / SR) * 0.9;
    const base: Partial<AnalogDelaySettings> = {
      delayTime: 0.05,
      feedback: 0.4,
      dryVolume: 0,
      wetVolume: 1,
      driveMix: 1,
      driveCutoff: 1,
      driveIterations: 4,
    };
    const clean = render(new AnalogDelayCore(SR), settings({ ...base, driveGain: 0 }), 0.5, tone);
    const driven = render(new AnalogDelayCore(SR), settings({ ...base, driveGain: 6 }), 0.5, tone);
    let diff = 0;
    const from = Math.round(0.2 * SR);
    for (let i = from; i < clean.length; i++) diff += Math.abs(clean[i]! - driven[i]!);
    expect(diff).toBeGreaterThan(0);
  });
});

describe('AnalogDelayCore — feedback stability', () => {
  it('stays finite + bounded at very high feedback', () => {
    const core = new AnalogDelayCore(SR);
    const s = settings({ delayTime: 0.03, feedback: 0.95, driveGain: 0.2, dryVolume: 1, wetVolume: 0.6, lowCut: 0.75 });
    const out = render(core, s, 1.0, (n) => (n < SR * 0.1 ? Math.sin((2 * Math.PI * 200 * n) / SR) * 0.5 : 0));
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true);
      peak = Math.max(peak, Math.abs(out[i]!));
    }
    expect(peak).toBeLessThan(8); // bounded — the loop does not run away
  });
});

describe('AnalogDelayCore — bus-duplicate + determinism', () => {
  it('with stereoOffset 0 + static pan 0, outL == outR sample-for-sample', () => {
    const core = new AnalogDelayCore(SR);
    const s = settings({ stereoOffset: 0, pan: 0, panMode: 0, driftAmount: 0.03, feedback: 0.6 });
    const n = Math.round(SR * 0.4);
    for (let i = 0; i < n; i++) {
      const v = i < SR * 0.06 ? Math.sin((2 * Math.PI * 261.6 * i) / SR) * 0.6 : 0;
      core.processSample(s, v, v);
      expect(core.outL).toBe(core.outR);
    }
  });

  it('two fresh cores render bit-identically (no hidden global state)', () => {
    const s = settings({ feedback: 0.7, driveGain: 3, driftAmount: 0.02, lfoAmount: 0.2 });
    const tone = (n: number) => (n < SR * 0.06 ? Math.sin((2 * Math.PI * 300 * n) / SR) * 0.5 : 0);
    const a = render(new AnalogDelayCore(SR), s, 0.5, tone);
    const b = render(new AnalogDelayCore(SR), s, 0.5, tone);
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    expect(maxDiff).toBe(0);
  });
});

// ── 2026-08-03: TWO defects, one divergent filter and one that never healed ──
//
// COFEFVE's FILTER MODE "State-var" (mode 3) diverged, and once it had, the
// module's WET path was dead for the LIFE of the node — a fresh spawn was the
// only way back. They are SEPARATE bugs and each needs its own fix: patching
// only the clamp leaves every already-diverged node dead, patching only the
// recovery leaves it diverging.
//
// MEASURED BEFORE (220 Hz @ 0.5, feedback 0.5, DRIVE 0 so its tanh — the only
// thing masking this at the shipping default — is out of the way):
//
//   lowCut 0.87 (f 1.0796)  peak 9.8700e-1     stable
//   lowCut 0.90 (f 1.2932)  peak 6.6636e+12    divergent
//   lowCut 0.95 (f 1.4000)  peak 8.7127e+37    divergent, |x|>10 by 0.401 s
//   lowCut 1.00 (f 1.4000)  peak 8.7127e+37    divergent
//
//   after returning to a SAFE patch on that same node:
//     wet-only RMS 0.0000e+0   (a FRESH node on the identical patch: 5.6507e-1)
//     dry-only RMS 3.5355e-1   — dry kept passing, which is why it looked fine
//
// THE MECHANISM, end to end, because each link is its own guard now:
//   the SVF's f exceeded 2 − damping → svfLow/svfBand grew without bound →
//   the float64 value stayed finite at 8.7e37 and PASSED `write`'s isFinite
//   scrub, then NARROWED TO FLOAT32 ON THE STORE and landed in the tape as
//   ±Infinity (float32 max ≈ 3.4e38) → reading it back made the in-loop tone
//   filter NaN → `fb` NaN → `write(input + NaN)` scrubbed the WHOLE SUM to 0,
//   so the dry input never entered the tape again → wet read back exactly 0.0
//   forever. A separate, SVF-independent route reaches the same end state: one
//   non-finite INPUT sample pins `duckEnv` at NaN, and `0 * Infinity` is NaN
//   so even DUCK AMOUNT 0 does not save it.
//
// WHY NOTHING CAUGHT IT: `AnalogDelayCore — feedback stability` above drives
// feedback 0.95 for a full second and asserts finite+bounded — with
// `filterMode: 0`, the default. It could not reach mode 3 at all. And every
// test in this file, and both ART profiles, render a FRESH core: no assertion
// anywhere observed a node ACROSS a patch change, which is the only place
// "state that never recovers" is visible.

describe('AnalogDelayCore — MODE 3 (State-var) stability', () => {
  it('the clamp sits UNDER the Chamberlin stability bound (2 − damping)', () => {
    // The relation, asserted directly, so the two constants cannot drift apart
    // and a future damping change cannot silently re-open the divergence.
    expect(
      SVF_F_MAX,
      `SVF_F_MAX ${SVF_F_MAX} must be < 2 − SVF_DAMPING (${2 - SVF_DAMPING})`,
    ).toBeLessThan(2 - SVF_DAMPING);
    expect(SVF_F_MAX, 'a useful cap, not a degenerate one').toBeGreaterThan(0.5);
  });

  it('stays bounded at EVERY LOW CUT position, DRIVE bypassed', () => {
    // The whole travel, middle included — the previous 1.4 clamp was already
    // above the bound by lowCut ≈ 0.867, well below where 1.4 ever bit, so an
    // endpoints-only sweep would have found the divergence but attributed it
    // to the wrong cause. driveGain 0 removes the tanh that masks this at the
    // shipping default.
    const tone = (n: number) => Math.sin((2 * Math.PI * 220 * n) / SR) * 0.5;
    const peaks: number[] = [];
    for (const lowCut of [0.1, 0.3, 0.5, 0.7, 0.8, 0.85, 0.87, 0.9, 0.95, 1.0]) {
      const out = render(
        new AnalogDelayCore(SR),
        settings({ filterMode: 3, lowCut, driveGain: 0, feedback: 0.5, dryVolume: 1, wetVolume: 0.5 }),
        1.0,
        tone,
      );
      let peak = 0;
      for (const v of out) peak = Math.max(peak, Math.abs(v));
      peaks.push(peak);
      expect(
        peak,
        `LOW CUT ${lowCut}: peak ${peak.toExponential(4)} (linear, full-scale ≈ 1) — ` +
          `before 2026-08-03 this read 6.6636e+12 at 0.90 and 8.7127e+37 at 0.95/1.00`,
      ).toBeLessThan(2);
      expect(out.every(Number.isFinite), `LOW CUT ${lowCut}: non-finite sample`).toBe(true);
    }
    // Negative control ON THE METRIC: a peak scan that had stopped looking
    // would report 0 everywhere and satisfy every clause above. The filter
    // must still be PASSING signal at each position.
    for (let i = 0; i < peaks.length; i++) {
      expect(peaks[i]!, `peak ${peaks[i]!.toExponential(4)} — the render must not be silent`).toBeGreaterThan(0.1);
    }
  });
});

describe('AnalogDelayCore — a NaN excursion must not poison the node forever', () => {
  const tone = (n: number) => Math.sin((2 * Math.PI * 220 * n) / SR) * 0.5;
  const wetOnly = settings({ filterMode: 0, lowCut: 0.75, driveGain: 0.1, dryVolume: 0, wetVolume: 1 });
  const rmsFrom = (b: Float32Array, from: number): number => {
    let s = 0;
    for (let i = from; i < b.length; i++) s += b[i]! * b[i]!;
    return Math.sqrt(s / (b.length - from));
  };

  it('recovers the WET path after being driven through the old divergent patch', () => {
    // The end-to-end statement of the user-visible bug: park the module on the
    // patch that used to blow up, put every knob back somewhere sane, and it
    // must play again. Before the fix this measured EXACTLY 0.000e+0.
    const core = new AnalogDelayCore(SR);
    render(core, settings({ filterMode: 3, lowCut: 1.0, driveGain: 0, feedback: 0.5 }), 1.0, tone);
    const after = render(core, wetOnly, 2.0, tone);
    const fresh = render(new AnalogDelayCore(SR), wetOnly, 2.0, tone);

    const rAfter = rmsFrom(after, SR);
    const rFresh = rmsFrom(fresh, SR);
    // ABSOLUTE leg — the negative control on the metric. "poisoned ≈ fresh" on
    // its own would be satisfied by a broken RMS that returned 0 for both.
    expect(
      rAfter,
      `recovered wet RMS ${rAfter.toExponential(4)} (linear) — was EXACTLY 0.000e+0 before 2026-08-03, ` +
        `while a fresh node on the identical patch read ${rFresh.toExponential(4)}`,
    ).toBeGreaterThan(0.1);
    // RELATIVE leg — recovered to within 10 % of never having been poisoned.
    expect(rAfter / rFresh, `recovered/fresh = ${(rAfter / rFresh).toFixed(4)}`).toBeGreaterThan(0.9);
  });

  it('recovers the WET path after ONE non-finite INPUT sample (no SVF involved)', () => {
    // The second, independent route into the same dead state — reachable from
    // any upstream module that emits Inf/NaN, on the DEFAULT filter mode, with
    // DUCK AMOUNT at 0. This one is what also bricked charlottes-echos, which
    // pins filterMode 0 and can never reach the SVF at all.
    const core = new AnalogDelayCore(SR);
    render(core, settings(), 0.2, (n) => (n === 100 ? Number.POSITIVE_INFINITY : tone(n)));
    const after = render(core, wetOnly, 2.0, tone);
    const fresh = render(new AnalogDelayCore(SR), wetOnly, 2.0, tone);

    const rAfter = rmsFrom(after, SR);
    const rFresh = rmsFrom(fresh, SR);
    expect(
      rAfter,
      `recovered wet RMS ${rAfter.toExponential(4)} after a single Infinity input ` +
        `(was EXACTLY 0.000e+0; fresh node reads ${rFresh.toExponential(4)})`,
    ).toBeGreaterThan(0.1);
    expect(rAfter / rFresh, `recovered/fresh = ${(rAfter / rFresh).toFixed(4)}`).toBeGreaterThan(0.9);
  });

  it('a NaN sample latches for AT MOST a few samples, not for the node lifetime', () => {
    // Bound the outage as well as prove it ends: the whole point is that the
    // recovery is immediate, not "eventually, after the tape rolls over".
    const core = new AnalogDelayCore(SR);
    render(core, settings(), 0.05, (n) => (n === 50 ? Number.NaN : tone(n)));
    const after = render(core, settings({ dryVolume: 0, wetVolume: 1 }), 0.02, tone);
    expect(after.every(Number.isFinite), 'output must be finite immediately after').toBe(true);
  });
});

describe('AnalogDelayCore — the recursive states re-seed instead of latching', () => {
  // Direct unit coverage of each guard, on the one class that exposes them.
  // These are what make the recovery a PROPERTY rather than a happy accident
  // of the two end-to-end renders above.
  const s = settings({ filterMode: 3, lowCut: 0.8, driveGain: 2 });

  it('ToneFilter returns to finite output after a non-finite sample', () => {
    const ch = new DelayChannel(4096);
    for (let i = 0; i < 100; i++) ch.tone.step(0.5, s, SR);
    const poisoned = ch.tone.step(Number.POSITIVE_INFINITY, s, SR);
    expect(Number.isFinite(poisoned), 'the poisoned sample itself is scrubbed').toBe(true);
    let last = 0;
    for (let i = 0; i < 200; i++) last = ch.tone.step(0.5, s, SR);
    expect(Number.isFinite(last), `ToneFilter still non-finite: ${last}`).toBe(true);
    expect(Math.abs(last), `ToneFilter output ${last} must be passing signal again`).toBeGreaterThan(1e-6);
  });

  it('DriveStage returns to finite output after a non-finite sample', () => {
    const ch = new DelayChannel(4096);
    for (let i = 0; i < 100; i++) ch.drive.step(0.5, s, SR);
    ch.drive.step(Number.NaN, s, SR);
    let last = 0;
    for (let i = 0; i < 200; i++) last = ch.drive.step(0.5, s, SR);
    expect(Number.isFinite(last), `DriveStage still non-finite: ${last}`).toBe(true);
    expect(Math.abs(last), `DriveStage output ${last} must be passing signal again`).toBeGreaterThan(1e-6);
  });

  it('the tape cannot hold ±Infinity even from a FINITE float64 write', () => {
    // The blind spot in the old scrub: `Number.isFinite(5e38)` is true, and the
    // float32 store then makes it Infinity. Nothing was wrong with the check —
    // it was reading the value BEFORE the narrowing that broke it.
    expect(Number.isFinite(5e38), 'the value passes an isFinite check…').toBe(true);
    expect(Number.isFinite(new Float32Array([5e38])[0]!), '…and is Infinity once stored as float32').toBe(false);
    const ch = new DelayChannel(4096);
    ch.write(5e38);
    const ZEROS = 10;
    for (let i = 0; i < ZEROS; i++) ch.write(0);
    // Read back EXACTLY the poisoned cell. This tap distance is load-bearing:
    // an earlier draft read at 8 and landed on a zero three cells away, so the
    // assertion passed while never once touching the value under test — and it
    // only showed up because the negative-control run stayed green. Control
    // leg below pins the aim so that cannot recur silently.
    const back = ch.readTap(ZEROS + 1, 1);
    expect(Number.isFinite(back), `read back ${back} — the tape must never hand out Infinity`).toBe(true);
    expect(Math.abs(back), `read back ${back} must be bounded by TAPE_MAX`).toBeLessThanOrEqual(TAPE_MAX);
    // CONTROL ON THE AIM: the same tap distance on a line holding a KNOWN
    // ordinary value must read that value back. If this stops finding 0.25 the
    // probe is pointed somewhere else and the clause above proves nothing.
    const aim = new DelayChannel(4096);
    aim.write(0.25);
    for (let i = 0; i < ZEROS; i++) aim.write(0);
    expect(aim.readTap(ZEROS + 1, 1), 'the probe must be reading the cell it thinks it is').toBeCloseTo(0.25, 6);
  });

  it('a non-finite read TARGET does not permanently mistune the line', () => {
    // `smoothedDelay` is the fourth recursive state. Poisoning it used to floor
    // every later read at the 1-sample clamp — a silently wrong delay time with
    // no non-finite sample anywhere to give it away.
    const ch = new DelayChannel(48000);
    for (let i = 0; i < 5000; i++) ch.write(i === 0 ? 1 : 0);
    // Control on the PROBE first: reading 5000 samples back must find the
    // impulse, so a later miss means the line moved and not that the probe
    // was pointed at the wrong place. easeCoeff 1 = no smoothing, so the read
    // position is exactly the target.
    const good = ch.readTap(5000, 1);
    expect(good, `control read ${good} — the probe must find the impulse`).toBeGreaterThan(0.5);
    ch.readTap(Number.NaN, 1);
    const back = ch.readTap(5000, 1);
    expect(
      back,
      `tap after a NaN target read back ${back} — expected the impulse (≈1). ` +
        `Without the guard smoothedDelay latches NaN, the caller's clamp floors ` +
        `every later read at 1 sample, and this reads 0 forever.`,
    ).toBeGreaterThan(0.5);
  });

  it('NEGATIVE CONTROL: every guard is a no-op on the finite path', () => {
    // The guards must not be able to change ordinary audio — this is the whole
    // argument that the ART `.f32` goldens do not move. Two renders that never
    // see a non-finite value must be BIT-identical to each other, and the
    // core must still be doing real work (the second clause is the control on
    // the control: comparing silence to silence proves nothing).
    const cfg = settings({ filterMode: 3, lowCut: 0.9, driveGain: 3, feedback: 0.7, driftAmount: 0.02, lfoAmount: 0.2 });
    const t = (n: number) => (n < SR * 0.06 ? Math.sin((2 * Math.PI * 300 * n) / SR) * 0.5 : 0);
    const a = render(new AnalogDelayCore(SR), cfg, 0.5, t);
    const b = render(new AnalogDelayCore(SR), cfg, 0.5, t);
    let maxDiff = 0;
    let peak = 0;
    for (let i = 0; i < a.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
      peak = Math.max(peak, Math.abs(a[i]!));
    }
    expect(maxDiff, 'two identical finite renders must be bit-identical').toBe(0);
    expect(peak, `render peak ${peak.toExponential(4)} — must not be comparing silence to silence`).toBeGreaterThan(0.1);
  });
});
