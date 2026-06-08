// packages/web/src/lib/audio/modules/synesthesia-dsp.test.ts
//
// Pure-math tests for the SYNESTHESIA DSP helpers in
// packages/dsp/src/lib/synesthesia-dsp.ts. This is the deterministic
// band-filtering / envelope / gate proof — no AudioWorklet, no browser.
//
// Lives under web/ (not packages/dsp) because vitest only runs
// `packages/web/src/**/*.test.ts`; the dsp lib is imported via a relative path,
// matching resofilter-dsp.test.ts.

import { describe, it, expect } from 'vitest';
import {
  combinedGain,
  makeBandSplitter,
  EnvFollower,
  GateDetector,
  OnsetDetector,
  MeterBallistics,
  renderSynesthesia,
  renderSynesthesiaVideo,
  videoChannelLevels,
  SYN_NUM_BANDS,
  ENV_FAST_MS,
  ENV_SLOW_MS,
  ENV_FAST_ATK_MS,
  ENV_FAST_REL_MS,
  ONSET_DEBOUNCE_MS,
  ONSET_PULSE_MS,
} from '../../../../../dsp/src/lib/synesthesia-dsp';

const SR = 48000;

function sine(freq: number, secs: number, amp = 0.8, sr = SR): Float32Array {
  const n = Math.round(secs * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** RMS over the second half of a buffer (skips filter settling). */
function rmsTail(buf: Float32Array): number {
  const start = Math.floor(buf.length / 2);
  let s = 0;
  for (let i = start; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / (buf.length - start));
}

function bandRmsForTone(freq: number): number[] {
  const { audio } = renderSynesthesia(sine(freq, 0.3), { sr: SR });
  return audio.map(rmsTail);
}

describe('synesthesia-dsp — combinedGain (master floor + band)', () => {
  it('master raises/lowers the floor; band adds on top; clamps at 0', () => {
    expect(combinedGain(1.0, 1.0)).toBeCloseTo(1.0); // unity master, min band
    expect(combinedGain(1.0, 2.0)).toBeCloseTo(2.0); // unity master, max band
    expect(combinedGain(0.5, 1.0)).toBeCloseTo(0.5); // floor down
    expect(combinedGain(1.5, 1.0)).toBeCloseTo(1.5); // floor up
    expect(combinedGain(1.5, 2.0)).toBeCloseTo(2.5); // both maxed
    expect(combinedGain(0.5, 2.0)).toBeCloseTo(1.5);
    expect(combinedGain(0.5, 0.0)).toBe(0); // clamp
  });
});

describe('synesthesia-dsp — band split maps each test tone to its band', () => {
  // MUSICAL bands: 65→b1(20-200), 400→b2(200-1k), 2000→b3(1k-4k), 8000→b4(4k+)
  const cases: Array<[number, number]> = [
    [65, 0],
    [400, 1],
    [2000, 2],
    [8000, 3],
  ];
  for (const [freq, target] of cases) {
    it(`${freq} Hz dominates band ${target + 1}`, () => {
      const rms = bandRmsForTone(freq);
      const sorted = [...rms].sort((a, b) => b - a);
      // target band is the strict argmax — i.e. the tone maps to its band.
      expect(rms[target]).toBe(sorted[0]);
      // and clearly wins, not a tie. Test tones sit well inside each band, so
      // the steep 24 dB/oct slopes keep the leader well ahead of neighbours.
      expect(rms[target]!).toBeGreaterThan(1.1 * (sorted[1] as number));
    });
  }

  it('mid-band tones are strongly isolated (≥ 12 dB above neighbours)', () => {
    // 100 Hz → bass (well inside 20–200); 500 Hz → low-mid (well inside 200–1k).
    for (const [freq, target] of [[100, 0], [500, 1]] as Array<[number, number]>) {
      const rms = bandRmsForTone(freq);
      const others = rms.filter((_, i) => i !== target);
      // 12 dB ≈ 4× in amplitude
      expect(rms[target]!).toBeGreaterThan(4 * Math.max(...others));
    }
  });
});

describe('synesthesia-dsp — two tones light the correct bands', () => {
  it('130 Hz + 8000 Hz energize bands 1 and 4, not 2 and 3', () => {
    const a = sine(130, 0.3, 0.5);
    const b = sine(8000, 0.3, 0.5);
    const mix = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) mix[i] = a[i]! + b[i]!;
    const rms = renderSynesthesia(mix, { sr: SR }).audio.map(rmsTail);
    // The two most-energized bands must be exactly band 1 and band 4.
    const top2 = rms
      .map((v, i) => [v, i] as [number, number])
      .sort((a, b) => b[0] - a[0])
      .slice(0, 2)
      .map((x) => x[1])
      .sort((a, b) => a - b);
    // (top2 == {0,3} already means both band 1 and band 4 strictly exceed
    // bands 2 and 3 — the meaningful "correct bands triggered" claim.)
    expect(top2).toEqual([0, 3]);
  });
});

describe('synesthesia-dsp — envelope followers', () => {
  it('fast follower decays to ~1/e after 50 ms; slow stays high', () => {
    const fast = new EnvFollower(SR, ENV_FAST_REL_MS, ENV_FAST_ATK_MS);
    const slow = new EnvFollower(SR, ENV_SLOW_MS, 40);
    // Charge both to ~1.0 (200 ms — long enough that even the 40 ms slow attack
    // fully saturates).
    for (let i = 0; i < SR * 0.2; i++) { fast.step(1); slow.step(1); }
    // Then 50 ms of silence.
    let ef = 0, es = 0;
    for (let i = 0; i < SR * (ENV_FAST_REL_MS / 1000); i++) { ef = fast.step(0); es = slow.step(0); }
    expect(ef).toBeGreaterThan(0.30);
    expect(ef).toBeLessThan(0.45); // ~e^-1 = 0.368 (release unchanged)
    expect(es).toBeGreaterThan(0.85); // slow barely moved in 50 ms
  });

  it('slow follower decays to ~1/e after 500 ms (release unchanged)', () => {
    const slow = new EnvFollower(SR, ENV_SLOW_MS, 40);
    for (let i = 0; i < SR * 0.2; i++) slow.step(1);
    let es = 0;
    for (let i = 0; i < SR * (ENV_SLOW_MS / 1000); i++) es = slow.step(0);
    expect(es).toBeGreaterThan(0.30);
    expect(es).toBeLessThan(0.45);
  });

  it('NEW attack stage: env RAMPS up over the attack time, not instantly', () => {
    // The pre-refactor follower had INSTANT attack (env jumped to |x| in one
    // sample), which strobes downstream video. With a real 5 ms attack the env
    // should still be climbing well below the target one sample in, reach ~1/e
    // of the way at exactly the attack time-constant, and approach the target
    // only after several time-constants.
    const fast = new EnvFollower(SR, ENV_FAST_REL_MS, ENV_FAST_ATK_MS);
    const e1 = fast.step(1); // one sample of a unit step
    expect(e1).toBeLessThan(0.1); // NOT instant — a real ramp (instant-attack=1)

    // After exactly one attack time-constant, a one-pole step response = 1−1/e.
    let env = e1;
    const atkSamples = Math.round((ENV_FAST_ATK_MS / 1000) * SR);
    for (let i = 1; i < atkSamples; i++) env = fast.step(1);
    expect(env).toBeGreaterThan(0.60); // 1 − 1/e ≈ 0.632
    expect(env).toBeLessThan(0.70);

    // Several time-constants later it's essentially at the target.
    for (let i = 0; i < atkSamples * 5; i++) env = fast.step(1);
    expect(env).toBeGreaterThan(0.98);
  });

  it('instant-attack legacy path (no attackMs arg) still jumps in one sample', () => {
    const inst = new EnvFollower(SR, ENV_FAST_MS); // no attack arg → instant
    expect(inst.step(1)).toBeCloseTo(1, 6);
  });
});

describe('synesthesia-dsp — gate detector (hysteresis)', () => {
  it('fires above thrHigh, releases below thrLow, holds in the dead-band', () => {
    const g = new GateDetector(0.05, 0.02);
    expect(g.step(0.01)).toBe(0);
    expect(g.step(0.06)).toBe(1); // crosses high
    expect(g.step(0.03)).toBe(1); // in dead-band — holds high
    expect(g.step(0.01)).toBe(0); // below low — releases
  });

  it('end-to-end: a band burst opens then closes the gate', () => {
    // 80 ms tone in band 1, then 800 ms silence.
    const tone = sine(65, 0.08, 0.8);
    const sil = new Float32Array(Math.round(0.8 * SR));
    const buf = new Float32Array(tone.length + sil.length);
    buf.set(tone, 0);
    const { gate } = renderSynesthesia(buf, { sr: SR });
    const g1 = gate[0]!;
    expect(Math.max(...g1.subarray(0, tone.length))).toBe(1); // opened during tone
    expect(g1[g1.length - 1]).toBe(0); // closed by the end
  });
});

describe('synesthesia-dsp — meter ballistics', () => {
  it('rises toward the signal level and stays within 0..1', () => {
    const m = new MeterBallistics(SR);
    let v = 0;
    for (let i = 0; i < SR * 0.2; i++) v = m.step(0.7);
    expect(v).toBeGreaterThan(0.6);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe('synesthesia-dsp — render shape', () => {
  it('returns 4 bands per output stream (incl. the new trig stream)', () => {
    const r = renderSynesthesia(sine(440, 0.02), { sr: SR });
    for (const stream of [r.audio, r.envSlow, r.envFast, r.gate, r.trig, r.level]) {
      expect(stream).toHaveLength(SYN_NUM_BANDS);
    }
  });
});

// ───────────────────────── per-band BEAT TRIGGER ─────────────────────────

/** Total trigger pulses (rising 0→1 edges) in a band's trig stream. */
function countTriggers(trig: Float32Array): number {
  let n = 0, prev = 0;
  for (let i = 0; i < trig.length; i++) {
    if (trig[i]! > 0.5 && prev <= 0.5) n++;
    prev = trig[i]!;
  }
  return n;
}

/** A short percussive burst: a band-1 tone (130 Hz) windowed by a fast
 *  exponential decay — a synthetic "kick". `at` = start sample. */
function kick(buf: Float32Array, at: number, freq = 130, lenS = 0.06, sr = SR): void {
  const len = Math.round(lenS * sr);
  for (let i = 0; i < len && at + i < buf.length; i++) {
    const env = Math.exp(-i / (0.012 * sr)); // ~12 ms decay
    buf[at + i]! += env * Math.sin((2 * Math.PI * freq * i) / sr);
  }
}

describe('synesthesia-dsp — OnsetDetector (per-band beat triggers)', () => {
  it('a single transient fires EXACTLY one trigger', () => {
    const det = new OnsetDetector(SR);
    const buf = new Float32Array(Math.round(0.5 * SR));
    kick(buf, Math.round(0.1 * SR));
    let fires = 0, prev = 0;
    for (let i = 0; i < buf.length; i++) {
      const t = det.step(buf[i]!);
      if (t > 0.5 && prev <= 0.5) fires++;
      prev = t;
    }
    expect(fires).toBe(1);
  });

  it('the trigger is a ~10 ms pulse (not a 1-sample spike)', () => {
    const det = new OnsetDetector(SR);
    const buf = new Float32Array(Math.round(0.3 * SR));
    kick(buf, Math.round(0.05 * SR));
    let high = 0;
    for (let i = 0; i < buf.length; i++) if (det.step(buf[i]!) > 0.5) high++;
    const expected = Math.round((ONSET_PULSE_MS / 1000) * SR);
    // exactly one pulse of ONSET_PULSE_MS width (within ±1 sample).
    expect(Math.abs(high - expected)).toBeLessThanOrEqual(1);
  });

  it('a SUSTAINED steady tone does NOT keep re-firing (adaptive threshold)', () => {
    // 1 s of a constant-amplitude tone: ONE onset at the leading edge, then the
    // adaptive threshold rises to meet the (now ~zero) flux → no further fires.
    const det = new OnsetDetector(SR);
    const tone = sine(130, 1.0, 0.8);
    let fires = 0, prev = 0;
    for (let i = 0; i < tone.length; i++) {
      const t = det.step(tone[i]!);
      if (t > 0.5 && prev <= 0.5) fires++;
      prev = t;
    }
    // At most a couple of fires near the very start (attack ripple), and
    // critically NOT a continuous stream — a free-running detector on a steady
    // tone would fire dozens of times. Allow ≤2; assert it's bounded.
    expect(fires).toBeLessThanOrEqual(2);
    expect(fires).toBeGreaterThanOrEqual(1); // the leading edge IS an onset
  });

  it('debounce blocks a second trigger within the inter-onset window', () => {
    const det = new OnsetDetector(SR);
    const buf = new Float32Array(Math.round(0.5 * SR));
    // Two kicks 40 ms apart — INSIDE the 80 ms debounce → only the first fires.
    kick(buf, Math.round(0.1 * SR));
    kick(buf, Math.round(0.1 * SR) + Math.round(0.04 * SR));
    expect(countTriggers(
      (() => { const o = new Float32Array(buf.length); for (let i = 0; i < buf.length; i++) o[i] = det.step(buf[i]!); return o; })(),
    )).toBe(1);
  });

  it('two transients SPACED beyond the debounce BOTH fire', () => {
    const det = new OnsetDetector(SR);
    const buf = new Float32Array(Math.round(0.8 * SR));
    // 250 ms apart — well beyond the 80 ms debounce → both fire.
    kick(buf, Math.round(0.1 * SR));
    kick(buf, Math.round(0.35 * SR));
    const out = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = det.step(buf[i]!);
    expect(countTriggers(out)).toBe(2);
    // sanity: the debounce window is shorter than the spacing.
    expect(ONSET_DEBOUNCE_MS).toBeLessThan(250);
  });

  it('a BASS transient fires band-1 trig via the full splitter chain', () => {
    // A kick at 130 Hz routed through renderSynesthesia → only BAND 1's trig
    // should fire (the worklet band energy drives the bass onset; FFT sub-bass
    // resolution would be too coarse — see OnsetDetector doc).
    const buf = new Float32Array(Math.round(0.5 * SR));
    kick(buf, Math.round(0.1 * SR), 130);
    const { trig } = renderSynesthesia(buf, { sr: SR });
    expect(countTriggers(trig[0]!)).toBe(1); // band 1 (bass) fires once
    // Higher bands see negligible energy from a clean 130 Hz kick → no fires.
    expect(countTriggers(trig[2]!)).toBe(0);
    expect(countTriggers(trig[3]!)).toBe(0);
  });

  it('a TREBLE transient fires band-4 trig, not band-1', () => {
    const buf = new Float32Array(Math.round(0.5 * SR));
    kick(buf, Math.round(0.1 * SR), 8000, 0.04); // high-freq hat-like tick
    const { trig } = renderSynesthesia(buf, { sr: SR });
    expect(countTriggers(trig[3]!)).toBe(1); // band 4 (treble) fires
    expect(countTriggers(trig[0]!)).toBe(0); // band 1 (bass) silent
  });
});

// ───────────────────────── VIDEO mode ─────────────────────────

/** Build a w·h RGBA buffer filled with a single colour (0..255 per channel). */
function solidFrame(r: number, g: number, b: number, w = 8, h = 8): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
  }
  return buf;
}

describe('synesthesia-dsp — videoChannelLevels (R/G/B/Luma extraction)', () => {
  it('solid RED → R≈1, G/B≈0, luma≈0.299', () => {
    const [r, g, b, l] = videoChannelLevels(solidFrame(255, 0, 0));
    expect(r).toBeCloseTo(1, 5);
    expect(g).toBeCloseTo(0, 5);
    expect(b).toBeCloseTo(0, 5);
    expect(l).toBeCloseTo(0.299, 3); // luma of pure red
  });

  it('solid GREEN → G≈1, R/B≈0, luma≈0.587', () => {
    const [r, g, b, l] = videoChannelLevels(solidFrame(0, 255, 0));
    expect(g).toBeCloseTo(1, 5);
    expect(r).toBeCloseTo(0, 5);
    expect(b).toBeCloseTo(0, 5);
    expect(l).toBeCloseTo(0.587, 3);
  });

  it('solid BLUE → B≈1, R/G≈0, luma≈0.114', () => {
    const [r, g, b, l] = videoChannelLevels(solidFrame(0, 0, 255));
    expect(b).toBeCloseTo(1, 5);
    expect(r).toBeCloseTo(0, 5);
    expect(g).toBeCloseTo(0, 5);
    expect(l).toBeCloseTo(0.114, 3);
  });

  it('solid WHITE → R=G=B=1 AND luma=1 (the white-redlines-luma rule)', () => {
    const [r, g, b, l] = videoChannelLevels(solidFrame(255, 255, 255));
    expect(r).toBeCloseTo(1, 5);
    expect(g).toBeCloseTo(1, 5);
    expect(b).toBeCloseTo(1, 5);
    expect(l).toBeCloseTo(1, 5); // white maxes luma too
  });

  it('solid BLACK → all ≈0', () => {
    const [r, g, b, l] = videoChannelLevels(solidFrame(0, 0, 0));
    expect(r).toBe(0);
    expect(g).toBe(0);
    expect(b).toBe(0);
    expect(l).toBe(0);
  });

  it('mid-gray → R=G=B=0.5, luma=0.5 (coeffs sum to 1)', () => {
    const [r, g, b, l] = videoChannelLevels(solidFrame(128, 128, 128));
    expect(r).toBeCloseTo(128 / 255, 5);
    expect(l).toBeCloseTo(128 / 255, 5);
    expect(g).toBeCloseTo(r, 5);
    expect(b).toBeCloseTo(r, 5);
  });

  it('empty buffer → [0,0,0,0] (no divide-by-zero)', () => {
    expect(videoChannelLevels(new Uint8ClampedArray(0))).toEqual([0, 0, 0, 0]);
  });
});

describe('synesthesia-dsp — VIDEO mode gain scaling matches audio mode', () => {
  it('band-audio output = level · combinedGain(master, gain), per channel', () => {
    const levels = [1, 0.5, 0.25, 0.8] as const;
    const master = 1.2;
    const gains: [number, number, number, number] = [1, 1.5, 2, 1.25];
    // One frame, hold a single sample so we read the instantaneous scaled value.
    const r = renderSynesthesiaVideo([levels], { sr: SR, master, gains, holdSamples: 1 });
    for (let c = 0; c < SYN_NUM_BANDS; c++) {
      const expected = levels[c]! * combinedGain(master, gains[c]!);
      expect(r.audio[c]![0]).toBeCloseTo(expected, 6);
    }
  });

  it('uses the SAME combinedGain clamp law (master 0.5 + min gain → 0.5×)', () => {
    const r = renderSynesthesiaVideo([[1, 1, 1, 1]], { sr: SR, master: 0.5, gains: [1, 1, 1, 1], holdSamples: 1 });
    for (let c = 0; c < SYN_NUM_BANDS; c++) expect(r.audio[c]![0]).toBeCloseTo(0.5, 6);
  });
});

describe('synesthesia-dsp — VIDEO mode drives envelope/gate followers from levels', () => {
  it('a held high RED level opens the gate; sustained low keeps it closed', () => {
    // ~120 ms of solid red (R=1, others 0), then ~600 ms of black.
    const hold = Math.round(SR * 0.12);
    const sil = Math.round(SR * 0.6);
    const onFrames = Array.from({ length: 1 }, () => [1, 0, 0, 0.299] as const);
    const offFrames = Array.from({ length: 1 }, () => [0, 0, 0, 0] as const);
    const r = renderSynesthesiaVideo(
      [...onFrames.map((f) => f)],
      { sr: SR, holdSamples: hold },
    );
    // R channel (index 0) gate opens while red is held.
    expect(Math.max(...r.gate[0]!)).toBe(1);
    // The G/B channels never opened (they stayed at 0).
    expect(Math.max(...r.gate[1]!)).toBe(0);
    expect(Math.max(...r.gate[2]!)).toBe(0);

    // Now red then black: gate closes by the end.
    const r2 = renderSynesthesiaVideo(
      [[1, 0, 0, 0.299], [0, 0, 0, 0]],
      { sr: SR, holdSamples: Math.max(hold, sil) },
    );
    const g0 = r2.gate[0]!;
    expect(Math.max(...g0)).toBe(1); // opened during the red hold
    expect(g0[g0.length - 1]).toBe(0); // closed after black
  });

  it('envelope follower rises with the held level (fast tracks, slow lags)', () => {
    const r = renderSynesthesiaVideo(
      [[1, 0, 0, 0.299]],
      { sr: SR, holdSamples: Math.round(SR * 0.1) },
    );
    const fast0 = r.envFast[0]!;
    const slow0 = r.envSlow[0]!;
    // Both have a REAL attack now: over 100 ms the fast (5 ms atk) saturates
    // to ~1, while the slow (40 ms atk) is still climbing — so it lags but is
    // already well up. Early on the fast leads the slow (the lag is visible).
    expect(fast0[fast0.length - 1]!).toBeGreaterThan(0.98);
    expect(slow0[slow0.length - 1]!).toBeGreaterThan(0.85);
    expect(slow0[slow0.length - 1]!).toBeLessThan(fast0[fast0.length - 1]!); // lags
    // 20 ms in, the fast (≈4 atk-τ) is far ahead of the slow (≈0.5 atk-τ).
    const at20ms = Math.round(SR * 0.02);
    expect(fast0[at20ms]!).toBeGreaterThan(slow0[at20ms]!);
  });

  it('meter level tracks the held channel level (white → all four meters high)', () => {
    const r = renderSynesthesiaVideo(
      [[1, 1, 1, 1]],
      { sr: SR, holdSamples: Math.round(SR * 0.3) },
    );
    for (let c = 0; c < SYN_NUM_BANDS; c++) {
      const m = r.level[c]!;
      expect(m[m.length - 1]!).toBeGreaterThan(0.6);
    }
  });
});
