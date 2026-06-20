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
  CV_MAKEUP,
  applyBipolar,
  applyEnvDepth,
  ENVDEPTH_DEFAULT,
  ENVDEPTH_MIN,
  ENVDEPTH_MAX,
} from '../../../../../dsp/src/lib/synesthesia-dsp';
import { buildCvBridgeMapping, mapCvBridgeValue } from '$lib/video/cv-bridge-map';
import { outlinesDef } from '$lib/video/modules/outlines';

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
    // Use a HALF-level red (0.5) so the CV-makeup-boosted env (×1.6 → ~0.8 at
    // steady state) stays BELOW the 0..1 clamp ceiling — otherwise a full-scale
    // (1.0) level pins both fast + slow at 1.0 and the lag is invisible. The
    // makeup is applied to the env OUTPUT (see CV_MAKEUP), so the steady value
    // is level·makeup, not level. The lag between fast (2 ms atk) and slow
    // (40 ms atk) is what we're proving here.
    const r = renderSynesthesiaVideo(
      [[0.5, 0, 0, 0.299]],
      { sr: SR, holdSamples: Math.round(SR * 0.1) },
    );
    const fast0 = r.envFast[0]!;
    const slow0 = r.envSlow[0]!;
    // Over 100 ms the fast (2 ms atk) saturates to ~0.5·1.6 = 0.8, while the
    // slow (40 ms atk) is still climbing — so it lags but is already well up.
    expect(fast0[fast0.length - 1]!).toBeGreaterThan(0.78);
    expect(slow0[slow0.length - 1]!).toBeGreaterThan(0.68);
    expect(slow0[slow0.length - 1]!).toBeLessThan(fast0[fast0.length - 1]!); // lags
    // 20 ms in, the fast (≈10 atk-τ) is far ahead of the slow (≈0.5 atk-τ).
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

// ───────────────── KICK → BASS CV re-tune (this PR's spine) ─────────────────
//
// The user-facing goal: "a strong kick drum should make [a downstream CV input,
// e.g. OUTLINES rotation] run the whole CV range." Before this PR, a full-
// amplitude kick only drove the bass envelope CV to ~0.64 (raw band amplitude,
// no makeup) → a downstream linear CV input swung barely a third of its range.
// The fix: a 2 ms fast attack + a per-band CV_MAKEUP gain on the env OUTPUT, so
// a strong kick lands the bass env CV at (near) full scale 1.0.
//
// Test material is DETERMINISTIC + license-free: a pitch-swept sine kick (95→48
// Hz body, ~2 ms attack, ~70 ms exp decay — a realistic electronic kick) laid
// out 4-on-the-floor at the three target genres' KNOWN BPMs.

/** A realistic deterministic kick: pitch-swept sine (95→48 Hz) with a fast
 *  attack + exp-decay amplitude. `amp` scales the whole hit. */
function realKick(buf: Float32Array, at: number, amp = 1.0, sr = SR): void {
  const len = Math.round(0.18 * sr);
  for (let i = 0; i < len && at + i < buf.length; i++) {
    const t = i / sr;
    const f = 48 + 47 * Math.exp(-t / 0.025); // 95 Hz → 48 Hz body sweep
    const a = (1 - Math.exp(-t / 0.002)) * Math.exp(-t / 0.07); // ~2 ms atk, ~70 ms decay
    buf[at + i]! += amp * a * Math.sin(2 * Math.PI * f * t);
  }
}

/** 4-on-the-floor kick pattern: one kick per beat at `bpm`, `beats` kicks. */
function kickFloor(bpm: number, beats: number, amp = 1.0): Float32Array {
  const spb = 60 / bpm;
  const buf = new Float32Array(Math.round((spb * beats + 0.5) * SR));
  for (let b = 0; b < beats; b++) realKick(buf, Math.round((0.05 + b * spb) * SR), amp);
  return buf;
}

function bufPeak(a: Float32Array): number {
  let p = 0;
  for (const v of a) if (v > p) p = v;
  return p;
}

describe('synesthesia-dsp — kick → BASS CV re-tune', () => {
  // The three target genres + their canonical BPMs (kick on every beat).
  const GENRES: Array<[string, number]> = [
    ['DnB', 174],
    ['industrial', 130],
    ['psytrance', 145],
  ];

  for (const [name, bpm] of GENRES) {
    it(`${name} (${bpm} BPM): a full-amplitude kick drives the bass env CV to ~full scale`, () => {
      const { envFast } = renderSynesthesia(kickFloor(bpm, 8, 1.0), { sr: SR });
      const bass = envFast[0]!;
      // (b) reaches ≥ 0.9 of full range on a strong kick.
      expect(bufPeak(bass)).toBeGreaterThanOrEqual(0.9);
    });

    it(`${name} (${bpm} BPM): the bass env decays back near zero BETWEEN kicks`, () => {
      const buf = kickFloor(bpm, 8, 1.0);
      const { envFast } = renderSynesthesia(buf, { sr: SR });
      const bass = envFast[0]!;
      // (c) decays between kicks: sample the env JUST before the 4th kick — it
      // must have fallen well back down (a clear rhythmic trough, not a smear).
      const spb = 60 / bpm;
      const justBefore4th = Math.round((0.05 + 3 * spb - 0.005) * SR);
      expect(bass[justBefore4th]!).toBeLessThan(0.25);
    });
  }

  it('each kick produces a SHARP rise locked to the transient (~≤12 ms to 90%)', () => {
    // (a) sharp rise locked to each kick. Measure the first kick's attack: time
    // from onset to 90% of the first peak. The 2 ms fast attack + the band-
    // limited kick rise should reach 90% within ~12 ms (was ~19 ms at 5 ms atk).
    const onset = Math.round(0.05 * SR);
    const { envFast } = renderSynesthesia(kickFloor(174, 4, 1.0), { sr: SR });
    const bass = envFast[0]!;
    let firstPeak = 0, peakIdx = onset;
    for (let i = onset; i < onset + Math.round(0.2 * SR); i++) {
      if (bass[i]! > firstPeak) { firstPeak = bass[i]!; peakIdx = i; }
    }
    let i90 = peakIdx;
    for (let i = onset; i <= peakIdx; i++) if (bass[i]! >= 0.9 * firstPeak) { i90 = i; break; }
    const atkMs = ((i90 - onset) / SR) * 1000;
    expect(atkMs).toBeLessThanOrEqual(12);
  });

  it('preserves DYNAMICS: a soft kick stays clearly below a strong kick (not crushed)', () => {
    const soft = bufPeak(renderSynesthesia(kickFloor(140, 4, 0.45), { sr: SR }).envFast[0]!);
    const strong = bufPeak(renderSynesthesia(kickFloor(140, 4, 1.0), { sr: SR }).envFast[0]!);
    expect(strong).toBeGreaterThanOrEqual(0.9); // strong → full scale
    expect(soft).toBeLessThan(0.7); // soft is clearly lower (dynamics intact)
    expect(strong - soft).toBeGreaterThan(0.25); // a real, audible difference
  });

  it('the bass band carries the kick — NOT the mid/treble bands', () => {
    // The kick energy lands in band 1 (bass), not the upper bands — so a kick
    // modulates the BASS CV, not the others. (Confirms the band window includes
    // the ~48–95 Hz kick fundamental.)
    const { envFast } = renderSynesthesia(kickFloor(150, 6, 1.0), { sr: SR });
    const peaks = envFast.map(bufPeak);
    expect(peaks[0]!).toBe(Math.max(...peaks)); // bass is the strongest band
    expect(peaks[0]!).toBeGreaterThan(2 * Math.max(peaks[2]!, peaks[3]!));
  });

  it('CV_MAKEUP is the documented bass-emphasised set + applied to the env', () => {
    // Guards the constant so a future edit can't silently zero the makeup
    // (which would re-introduce the weak-bass bug).
    expect(CV_MAKEUP).toEqual([1.6, 1.6, 1.6, 1.5]);
    // And prove the env OUTPUT actually carries it: a sub-clamp sustained bass
    // tone settles at (raw env)·makeup, i.e. clearly above the raw env.
    const tone = sine(90, 0.4, 0.35); // low amp so raw env stays well under clamp
    const { envFast } = renderSynesthesia(tone, { sr: SR });
    expect(rmsTail(envFast[0]!)).toBeGreaterThan(0.2); // boosted, not the ~0.13 raw
  });
});

// ───────── END-TO-END: kick → bass CV → OUTLINES "rotation" full sweep ───────
//
// The user's exact scenario: SYNESTHESIA's bass CV → OUTLINES (formerly CIRCLES)
// "rotation" CV input should traverse (near) the full range on a strong kick.
// This drives the value through the REAL production routing: the actual
// `outlinesDef` rotation PortDef (cvScale {mode:'linear'}) + param def + the
// REAL cv→video bridge math (buildCvBridgeMapping / mapCvBridgeValue, the same
// helpers engine.ts.tickCvBridges calls per frame) — fed the REAL
// renderSynesthesia bass env CV. No WebGL needed (the bridge value math is pure;
// the GL only paints the result). So this is a true end-to-end of the CV path
// from a kick to the OUTLINES rotation param the spin reads.
//
// NOTE on the math: the SYNESTHESIA env CV is UNIPOLAR (0..1). scaleCv(linear)
// centres the sweep on the knob (a bipolar ±1 source sweeps ±halfSpan). A
// unipolar 0..1 source therefore reaches from `knob` up to `knob + halfSpan`.
// The rotation knob ships CENTRED (ROT_CENTER = 0.5 — see OUTLINES DEFAULTS), so
// a full bass env (≈1.0) reaches 0.5 + 0.5 = 1.0 (the top) and idle sits back at
// 0.5 — the whole upper half of the range swings on the kick.

describe('synesthesia-dsp — kick → OUTLINES rotation end-to-end (real bridge)', () => {
  // The REAL OUTLINES rotation input PortDef (carries the cvScale hint) + param.
  const rotInput = outlinesDef.inputs?.find((p) => p.id === 'rotation');
  const rotParam = outlinesDef.params?.find((p) => p.id === 'rotation');

  /** Map a SYNESTHESIA env CV sample → the OUTLINES rotation param value through
   *  the REAL cv-bridge, at the given knob position. */
  function rotationFor(envSample: number, knob: number): number {
    const mapping = buildCvBridgeMapping(rotInput, 'rotation', outlinesDef.params, { rotation: knob });
    return mapCvBridgeValue(mapping, envSample);
  }

  it('OUTLINES rotation declares the linear cvScale hint the bridge needs', () => {
    // Sanity: if this hint ever drops, the bridge falls back to gate semantics
    // and the kick→rotation sweep silently dies (the OUTLINES #787 bug class).
    expect(rotInput?.cvScale?.mode).toBe('linear');
    expect(rotParam).toMatchObject({ min: 0, max: 1 });
  });

  it('a strong kick sweeps rotation across (near) the full reachable range', () => {
    const { envFast } = renderSynesthesia(kickFloor(174, 8, 1.2), { sr: SR });
    const bass = envFast[0]!;
    // Default centre knob (ROT_CENTER = 0.5), driven through the REAL bridge.
    let rotPeak = 0.5;
    for (const env of bass) {
      const r = rotationFor(env, /*knob*/ 0.5);
      if (r > rotPeak) rotPeak = r;
    }
    expect(rotPeak).toBeGreaterThanOrEqual(0.99); // pinned at the top of the range

    // The rhythm reads out: between kicks rotation falls back to the knob centre.
    const spb = 60 / 174;
    const idle = bass[Math.round((0.05 + 3 * spb - 0.005) * SR)]!;
    const rotIdle = rotationFor(idle, 0.5);
    expect(rotIdle).toBeLessThan(0.62); // back near centre → a kick-locked swing
    expect(rotPeak - rotIdle).toBeGreaterThan(0.38); // the FULL reachable upper swing
  });

  it('the default centre knob swings the FULL UPPER HALF at every target BPM', () => {
    for (const bpm of [174, 130, 145]) {
      const { envFast } = renderSynesthesia(kickFloor(bpm, 8, 1.0), { sr: SR });
      let rotPeak = 0.5;
      for (const env of envFast[0]!) {
        const r = rotationFor(env, 0.5);
        if (r > rotPeak) rotPeak = r;
      }
      expect(rotPeak, `bpm ${bpm}`).toBeGreaterThanOrEqual(0.95); // centre → (near) full top
    }
  });

  it('FAILS-SAFE: WITHOUT the cv makeup, the same kick barely moves rotation', () => {
    // Negative guard: emulate the pre-retune env (raw band amplitude, no makeup)
    // by dividing the boosted bass env back down by CV_MAKEUP[0]. The same kick
    // then only nudges rotation a fraction of the way — the weak-bass bug.
    const { envFast } = renderSynesthesia(kickFloor(174, 8, 1.0), { sr: SR });
    let rawPeak = 0;
    for (const env of envFast[0]!) {
      const raw = env / CV_MAKEUP[0]; // undo the makeup → pre-retune env
      if (raw > rawPeak) rawPeak = raw;
    }
    const rotPeakOld = rotationFor(rawPeak, 0.5);
    expect(rotPeakOld).toBeLessThan(0.85); // pre-retune: rotation never neared the top
    // And the retune is a real improvement at the SAME kick.
    const rotPeakNew = rotationFor(Math.min(1, rawPeak * CV_MAKEUP[0]), 0.5);
    expect(rotPeakNew - rotPeakOld).toBeGreaterThan(0.12);
  });
});

// ───────────────────── BIPOLAR output mode ─────────────────────
//
// The user wants a STRONG KICK to traverse the WHOLE destination CV range, not
// just the upper half. The env CV is unipolar [0,1]; through the cv→video
// bridge's KNOB-CENTERED scaleCv, a [0,1] source with the destination knob at
// centre only sweeps the UPPER HALF. SYNESTHESIA's new BIPOLAR mode remaps the
// env CV outputs 0..1 → -1..+1 (silence → -1, strong kick → +1) so ±1 sweeps
// the FULL [min,max] range regardless of knob position. Default OFF preserves
// the existing behaviour. The remap is on the env CV OUTPUT only — gate/onset/
// meter are unaffected (proven below).

describe('synesthesia-dsp — applyBipolar (pure remap)', () => {
  it('OFF: pass-through (silence→0, full→1, mid→0.5)', () => {
    expect(applyBipolar(0, false)).toBe(0);
    expect(applyBipolar(0.5, false)).toBe(0.5);
    expect(applyBipolar(1, false)).toBe(1);
  });
  it('ON: 0..1 → -1..+1 (silence→-1, mid→0, full→+1)', () => {
    expect(applyBipolar(0, true)).toBe(-1);
    expect(applyBipolar(0.5, true)).toBe(0);
    expect(applyBipolar(1, true)).toBe(1);
  });
});

/** Min + max of a buffer (for range assertions). */
function bufRange(a: Float32Array): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const v of a) { if (v < min) min = v; if (v > max) max = v; }
  return { min, max };
}

describe('synesthesia-dsp — BIPOLAR env CV mode (renderSynesthesia)', () => {
  it('OFF (default): env CV outputs stay UNIPOLAR in [0,1] (unchanged behaviour)', () => {
    const buf = kickFloor(174, 8, 1.0);
    const off = renderSynesthesia(buf, { sr: SR }); // bipolar omitted → default OFF
    for (const stream of [off.envSlow, off.envFast]) {
      for (let b = 0; b < SYN_NUM_BANDS; b++) {
        const { min, max } = bufRange(stream[b]!);
        expect(min, `band ${b} min`).toBeGreaterThanOrEqual(0);
        expect(max, `band ${b} max`).toBeLessThanOrEqual(1);
      }
    }
    // And explicitly bipolar:false equals the default.
    const explicit = renderSynesthesia(buf, { sr: SR, bipolar: false });
    expect(explicit.envFast[0]![1000]).toBe(off.envFast[0]![1000]);
  });

  it('ON: env CV outputs are BIPOLAR in [-1,+1]; silence≈-1, strong kick≈+1', () => {
    const buf = kickFloor(174, 8, 1.2);
    const bi = renderSynesthesia(buf, { sr: SR, bipolar: true });
    const uni = renderSynesthesia(buf, { sr: SR }); // reference unipolar
    const biBass = bi.envFast[0]!;
    const uniBass = uni.envFast[0]!;
    const { min, max } = bufRange(biBass);
    // Whole stream stays within the bipolar range.
    expect(min).toBeGreaterThanOrEqual(-1);
    expect(max).toBeLessThanOrEqual(1);
    // A strong kick reaches near +1 (it pinned near unipolar 1.0 → 2·1−1 = +1).
    expect(max).toBeGreaterThanOrEqual(0.9);
    // Silence between/before kicks sits near -1 (unipolar ~0 → 2·0−1 = -1).
    const spb = 60 / 174;
    const idle = Math.round((0.05 + 3 * spb - 0.005) * SR);
    expect(biBass[idle]!).toBeLessThan(-0.5);
    // The bipolar value is EXACTLY the documented remap of the unipolar value.
    for (const i of [0, 500, idle, 5000]) {
      expect(biBass[i]!).toBeCloseTo(2 * uniBass[i]! - 1, 6);
    }
  });

  it('ON: only env CV is remapped — gate / trig / band-audio stay UNIPOLAR', () => {
    const buf = kickFloor(150, 6, 1.0);
    const bi = renderSynesthesia(buf, { sr: SR, bipolar: true });
    const uni = renderSynesthesia(buf, { sr: SR });
    // gate + trig are 0/1 pulses regardless of polarity (read the RAW env).
    for (const stream of [bi.gate, bi.trig]) {
      for (let b = 0; b < SYN_NUM_BANDS; b++) {
        const { min, max } = bufRange(stream[b]!);
        expect(min).toBeGreaterThanOrEqual(0);
        expect(max).toBeLessThanOrEqual(1);
      }
    }
    // gate + trig + band-audio are byte-for-byte identical to unipolar mode
    // (proves the bipolar flag never touches the detectors / audio path).
    for (let b = 0; b < SYN_NUM_BANDS; b++) {
      expect(Array.from(bi.gate[b]!)).toEqual(Array.from(uni.gate[b]!));
      expect(Array.from(bi.trig[b]!)).toEqual(Array.from(uni.trig[b]!));
      expect(Array.from(bi.audio[b]!)).toEqual(Array.from(uni.audio[b]!));
    }
  });
});

describe('synesthesia-dsp — BIPOLAR env CV mode (VIDEO copy)', () => {
  it('OFF→[0,1], ON→[-1,+1] on a held RED frame (env CV only)', () => {
    const frame = [[1, 0, 0, 0.299]] as const;
    const hold = Math.round(SR * 0.2);
    const off = renderSynesthesiaVideo([...frame], { sr: SR, holdSamples: hold });
    const on = renderSynesthesiaVideo([...frame], { sr: SR, holdSamples: hold, bipolar: true });
    // R channel (idx 0) saturates → unipolar ~1, bipolar ~+1.
    expect(bufRange(off.envFast[0]!).max).toBeLessThanOrEqual(1);
    expect(bufRange(on.envFast[0]!).max).toBeGreaterThanOrEqual(0.9);
    // The DARK channels (G/B, idx 1/2) sit at unipolar 0 → bipolar -1.
    expect(on.envFast[1]![hold - 1]!).toBeCloseTo(-1, 5);
    expect(off.envFast[1]![hold - 1]!).toBeCloseTo(0, 5);
    // gate unaffected: R opened, G stayed closed, in BOTH modes.
    expect(Math.max(...on.gate[0]!)).toBe(1);
    expect(Math.max(...on.gate[1]!)).toBe(0);
  });
});

// ───── END-TO-END: BIPOLAR kick → OUTLINES rotation FULL-RANGE traversal ─────
//
// The user's exact need: with BIPOLAR on + a CENTERED OUTLINES rotation knob, a
// strong kick should traverse the WHOLE [min,max] rotation range — not just the
// upper half a unipolar source reaches. Drives the REAL outlinesDef rotation
// PortDef + param + the REAL cv-bridge math (buildCvBridgeMapping /
// mapCvBridgeValue), fed the REAL renderSynesthesia bipolar bass env CV.

describe('synesthesia-dsp — BIPOLAR kick → OUTLINES rotation FULL-RANGE (real bridge)', () => {
  const rotInput = outlinesDef.inputs?.find((p) => p.id === 'rotation');

  function rotationFor(envSample: number, knob: number): number {
    const mapping = buildCvBridgeMapping(rotInput, 'rotation', outlinesDef.params, { rotation: knob });
    return mapCvBridgeValue(mapping, envSample);
  }

  it('UNIPOLAR (default) at the centre knob only reaches the UPPER half', () => {
    // The documented baseline: a [0,1] kick centred at 0.5 swings [0.5, 1.0].
    const { envFast } = renderSynesthesia(kickFloor(174, 8, 1.2), { sr: SR });
    let lo = Infinity, hi = -Infinity;
    for (const env of envFast[0]!) {
      const r = rotationFor(env, 0.5);
      if (r < lo) lo = r; if (r > hi) hi = r;
    }
    expect(hi).toBeGreaterThanOrEqual(0.99); // reaches the top…
    expect(lo).toBeGreaterThanOrEqual(0.49); // …but never the BOTTOM (stuck ≥ centre)
  });

  it('BIPOLAR at the centre knob traverses (near) the FULL [min,max] range', () => {
    const { envFast } = renderSynesthesia(kickFloor(174, 8, 1.2), { sr: SR, bipolar: true });
    let lo = Infinity, hi = -Infinity;
    for (const env of envFast[0]!) {
      const r = rotationFor(env, /*centre knob*/ 0.5);
      if (r < lo) lo = r; if (r > hi) hi = r;
    }
    // A strong kick (bipolar +1) pins rotation at the TOP of the range…
    expect(hi).toBeGreaterThanOrEqual(0.99);
    // …and silence (bipolar -1) pulls it to the BOTTOM — the WHOLE range now,
    // not just the upper half. (rotation param is [0,1] — see the #792 test.)
    expect(lo).toBeLessThanOrEqual(0.01);
    // Full traversal: spans ≥ 98% of the param's [0,1] range on a kick.
    expect(hi - lo).toBeGreaterThanOrEqual(0.98);
  });

  it('BIPOLAR sweeps the FULL range at every target BPM (centre knob)', () => {
    for (const bpm of [174, 130, 145]) {
      const { envFast } = renderSynesthesia(kickFloor(bpm, 8, 1.0), { sr: SR, bipolar: true });
      let lo = Infinity, hi = -Infinity;
      for (const env of envFast[0]!) {
        const r = rotationFor(env, 0.5);
        if (r < lo) lo = r; if (r > hi) hi = r;
      }
      expect(hi - lo, `bpm ${bpm} full sweep`).toBeGreaterThanOrEqual(0.9);
    }
  });
});

// ───────────────────── per-band ENV-OUTPUT DEPTH ─────────────────────
//
// The owner's ask: ONE knob per (copy, band) = 8 total, each scaling UP or DOWN
// the OUTPUT level of that band's TWO envelopes (env_slow + env_fast). It lets a
// SYNESTHESIA envelope reach full modulation depth AT THE SOURCE (replacing the
// scrapped per-cable/edge depth idea). Range 0..2, default 1.0 (= unchanged).
// Applied to the env CV OUTPUT ONLY — gate / trig / band-audio / VU are untouched.

describe('synesthesia-dsp — applyEnvDepth (pure scale)', () => {
  it('default 1.0 = pass-through; 0 = silenced; 2 = doubled', () => {
    expect(ENVDEPTH_DEFAULT).toBe(1);
    expect(ENVDEPTH_MIN).toBe(0);
    expect(ENVDEPTH_MAX).toBe(2);
    expect(applyEnvDepth(0.6, 1)).toBeCloseTo(0.6, 6); // unity
    expect(applyEnvDepth(0.6, 0)).toBe(0); // cut
    expect(applyEnvDepth(0.6, 2)).toBeCloseTo(1.2, 6); // doubled (pre-clamp)
    expect(applyEnvDepth(0.6, 0.5)).toBeCloseTo(0.3, 6); // half
  });
});

describe('synesthesia-dsp — per-band ENV-OUTPUT depth (renderSynesthesia, AUDIO)', () => {
  // A sub-clamp bass tone so depth-scaling is visible without pinning the clamp.
  const lowTone = (): Float32Array => sine(90, 0.4, 0.35);

  it('default (envDepth=[1,1,1,1]) is BIT-IDENTICAL to omitting it', () => {
    const buf = lowTone();
    const base = renderSynesthesia(buf, { sr: SR });
    const explicit = renderSynesthesia(buf, { sr: SR, envDepth: [1, 1, 1, 1] });
    for (const k of ['envSlow', 'envFast', 'gate', 'trig', 'audio'] as const) {
      for (let b = 0; b < SYN_NUM_BANDS; b++) {
        expect(Array.from(explicit[k][b]!), `${k} band ${b}`).toEqual(Array.from(base[k][b]!));
      }
    }
  });

  it('depth=0 SILENCES that band\'s BOTH env CV outputs (slow + fast)', () => {
    const buf = lowTone(); // band-1 (bass) tone
    const r = renderSynesthesia(buf, { sr: SR, envDepth: [0, 1, 1, 1] });
    // Band 1's env CV outputs are flat zero…
    expect(rmsTail(r.envFast[0]!)).toBe(0);
    expect(rmsTail(r.envSlow[0]!)).toBe(0);
    expect(Math.max(...r.envFast[0]!)).toBe(0);
    expect(Math.max(...r.envSlow[0]!)).toBe(0);
  });

  it('depth=2 DOUBLES that band\'s env CV outputs (clamped at the 0..1 ceiling)', () => {
    const buf = lowTone();
    const unity = renderSynesthesia(buf, { sr: SR, envDepth: [1, 1, 1, 1] });
    const doubled = renderSynesthesia(buf, { sr: SR, envDepth: [2, 1, 1, 1] });
    // The sub-clamp unity bass env (~0.2 RMS) doubles toward ~0.4 (still < 1).
    const u = rmsTail(unity.envFast[0]!);
    const d = rmsTail(doubled.envFast[0]!);
    expect(u).toBeGreaterThan(0); // unity carried energy
    expect(d).toBeGreaterThan(1.8 * u); // ≈2× (slight clamp loss at peaks)
    expect(d).toBeLessThan(2.05 * u);
    // Per-sample: never exceeds the 0..1 CV ceiling.
    expect(Math.max(...doubled.envFast[0]!)).toBeLessThanOrEqual(1);
    // The SLOW env doubles too (the knob scales BOTH).
    expect(rmsTail(doubled.envSlow[0]!)).toBeGreaterThan(1.8 * rmsTail(unity.envSlow[0]!));
  });

  it('per-band: scaling band 1 does NOT touch the other bands\' env outputs', () => {
    // Mix a bass (130) + treble (8000) tone, cut ONLY band 1's depth.
    const a = sine(130, 0.3, 0.5);
    const b = sine(8000, 0.3, 0.5);
    const mix = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) mix[i] = a[i]! + b[i]!;
    const base = renderSynesthesia(mix, { sr: SR });
    const cut1 = renderSynesthesia(mix, { sr: SR, envDepth: [0, 1, 1, 1] });
    expect(rmsTail(cut1.envFast[0]!)).toBe(0); // band 1 silenced
    // Band 4 (treble) is untouched — identical to baseline.
    expect(Array.from(cut1.envFast[3]!)).toEqual(Array.from(base.envFast[3]!));
    expect(Array.from(cut1.envSlow[3]!)).toEqual(Array.from(base.envSlow[3]!));
  });

  it('depth only scales the ENV CV — gate / trig / band-audio are unchanged', () => {
    const buf = kickFloor(150, 6, 1.0);
    const base = renderSynesthesia(buf, { sr: SR });
    const scaled = renderSynesthesia(buf, { sr: SR, envDepth: [0, 0.5, 2, 1.5] });
    for (let b = 0; b < SYN_NUM_BANDS; b++) {
      expect(Array.from(scaled.gate[b]!), `gate ${b}`).toEqual(Array.from(base.gate[b]!));
      expect(Array.from(scaled.trig[b]!), `trig ${b}`).toEqual(Array.from(base.trig[b]!));
      expect(Array.from(scaled.audio[b]!), `audio ${b}`).toEqual(Array.from(base.audio[b]!));
    }
  });

  it('composes with BIPOLAR: depth=0 → silent rail (-1), depth=2 → +1 on a kick', () => {
    const buf = kickFloor(174, 8, 1.2);
    // depth 0, bipolar on → unipolar 0 → bipolar -1 (the silent rail).
    const cut = renderSynesthesia(buf, { sr: SR, bipolar: true, envDepth: [0, 1, 1, 1] });
    for (const v of cut.envFast[0]!) expect(v).toBeCloseTo(-1, 6);
    // depth 2, bipolar on → a strong kick still pins +1 (clamped unipolar 1).
    const boost = renderSynesthesia(buf, { sr: SR, bipolar: true, envDepth: [2, 1, 1, 1] });
    let max = -Infinity;
    for (const v of boost.envFast[0]!) if (v > max) max = v;
    expect(max).toBeGreaterThanOrEqual(0.9);
    expect(max).toBeLessThanOrEqual(1);
  });
});

describe('synesthesia-dsp — per-band ENV-OUTPUT depth (VIDEO mode)', () => {
  it('depth=0 silences the channel\'s env CV; default is unchanged; 2× doubles', () => {
    // R level chosen so even at 2× the env (R·makeup·2 = 0.25·1.6·2 = 0.8) stays
    // UNDER the 0..1 clamp ceiling — so the doubling is visible, not clipped.
    const frame = [[0.25, 0, 0, 0.075]] as const; // sub-clamp R level
    const hold = Math.round(SR * 0.2);
    const base = renderSynesthesiaVideo([...frame], { sr: SR, holdSamples: hold });
    const cut = renderSynesthesiaVideo([...frame], { sr: SR, holdSamples: hold, envDepth: [0, 1, 1, 1] });
    const dbl = renderSynesthesiaVideo([...frame], { sr: SR, holdSamples: hold, envDepth: [2, 1, 1, 1] });
    // R channel (idx 0): cut → 0, doubled → ~2× the baseline (still sub-clamp).
    expect(base.envFast[0]![hold - 1]!).toBeGreaterThan(0);
    expect(cut.envFast[0]![hold - 1]!).toBe(0);
    expect(cut.envSlow[0]![hold - 1]!).toBe(0);
    expect(dbl.envFast[0]![hold - 1]!).toBeCloseTo(2 * base.envFast[0]![hold - 1]!, 4);
    // The default (omitted) equals envDepth [1,1,1,1].
    const explicit = renderSynesthesiaVideo([...frame], { sr: SR, holdSamples: hold, envDepth: [1, 1, 1, 1] });
    expect(explicit.envFast[0]![hold - 1]!).toBe(base.envFast[0]![hold - 1]!);
    // gate unaffected by depth (R opened in all three).
    expect(Math.max(...base.gate[0]!)).toBe(1);
    expect(Math.max(...cut.gate[0]!)).toBe(1);
  });
});
