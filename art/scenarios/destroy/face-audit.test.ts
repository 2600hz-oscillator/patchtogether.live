// art/scenarios/destroy/face-audit.test.ts
//
// THE ADVERSARIAL AUDIT FOR DESTROY, and the permanent anchor under its
// faceplate (queue Q18).
//
// Everything here is measured against the REAL SHIPPED FAUST WASM through
// `art/setup/faust-offline.ts` — `packages/dsp/dist/destroy.wasm`, the exact
// bytes the browser loads, driven by `FaustMonoOfflineProcessor` with no
// AudioContext. There is no pure-TS mirror of this module to drift from.
//
// WHAT THIS FILE IS FOR, beyond regression. Every number the faceplate prints
// is a claim about the MODULE, and `destroy-face-model.test.ts` can only ever
// prove they are claims about the model's arithmetic. Four things are joined
// here:
//
//   1. #1716 — THE HOLD IS `round(DECIMATE)` SAMPLES, asserted at every integer
//      position 1..64 AND at the half-step boundaries CV lands on, against
//      `destroyHoldSamples` rather than against a table typed in this file.
//      The pre-fix TRUNCATING law is kept as a permanent negative control, so
//      the gate cannot go green on a regression to it.
//   2. THE CRUSH FLOOR the face prints is where the artefact actually sits,
//      across bit depth AND wet, within a stated tolerance in dB.
//   3. THE DEAD ZONE is a CLIFF and not a fade — the claim `mute` makes.
//   4. THE GLYPH CHOICE IS A MEASUREMENT: a level meter is invariant to this
//      module's primary control, so the face declares a trace.
//
// ⚠ AND IT CARRIES THE INSTRUMENT'S OWN NEGATIVE CONTROLS, PERMANENTLY, because
// this module has already produced two confident clean WRONG answers (#1716):
//
//   · A BIT-EQUALITY census says "decimation does nothing" — plateau 1 at every
//     DECIMATE. `wet` is `si.smoo`-ed too and its smoother never closes, so a
//     residual dry sine ~89.8 dB down rides on every held plateau and breaks
//     equality without moving the plateau. NEVER compare this module's output
//     samples for equality; the census here is tolerance-based.
//   · A DISTINCT-LEVEL census on a 1000 Hz source says "bit reduction does
//     nothing" — the same count at 16, 12 and 8 bits. 1000 Hz is EXACTLY 48
//     samples per period at 48 kHz, so the source itself only ever takes 25
//     distinct magnitudes and cannot see a quantiser finer than ~5 bits. The
//     rich source below is C4 (183.47 samples/period, not an integer).
//
// Both are asserted to STILL RETURN THEIR WRONG ANSWER, so the controls cannot
// quietly stop being controls.
//
// DETERMINISM IS PROVEN, NOT ASSUMED (#1680): the first test renders the same
// scene twice at four corners and asserts bit-identity.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../setup/capture';
import { C4_HZ, seededNoise, vcoTestSignal } from '../../setup/drivers';
import { renderFaustOffline } from '../../setup/faust-offline';
import {
  DESTROY_REFERENCE_SR,
  destroyBitFloorDb,
  destroyEffectiveSrHz,
  destroyHoldSamples,
  destroyMuteDb,
} from '$lib/ui/modules/destroy-face-model';

const SR = SAMPLE_RATE;
const DUR_S = 1.5;
/** The SETTLED window. Every param is `si.smoo`-ed, so the first second is the
 *  smoother arriving, not the module working. */
const TAIL_S = 1.2;
const N = Math.round(SR * DUR_S);
const S0 = Math.round(TAIL_S * SR);

/** The face model states its numbers at 48 kHz and so does this harness. If
 *  they ever disagree every assertion below is measuring the wrong module. */
const SR_AGREES = SR === DESTROY_REFERENCE_SR;

/** RICH source: C4 is 183.47 samples/period — NOT an integer, so it visits
 *  thousands of distinct values and can see a 16-bit grid. */
const richSine = vcoTestSignal({ totalS: DUR_S, shape: 'sine', freqHz: C4_HZ, amp: 0.5 });
/** The source that CANNOT see the quantiser — kept as an instrument control. */
const aliasedSine = vcoTestSignal({ totalS: DUR_S, shape: 'sine', freqHz: 1000, amp: 0.5 });
const noise = seededNoise(DUR_S);

async function render(
  params: { decimate: number; bits: number; wet: number },
  input: Float32Array,
): Promise<Float32Array> {
  const out = await renderFaustOffline({
    name: 'destroy',
    totalSamples: N,
    inputs: [input],
    params,
    outputs: ['audio'],
  });
  return out.audio!;
}

/**
 * Plateau lengths over the settled tail, TOLERANCE-based.
 *
 * ⚠ The tolerance is not a fudge, it is the fix for the −89.8 dB dry leak: two
 * samples inside one held plateau differ by up to ~2 × 3.2e-5, so 1e-4 is one
 * order of magnitude clear of the leak and four orders under the smallest
 * quantiser step this file exercises.
 */
function plateaus(buf: Float32Array, tol = 1e-4): number[] {
  const runs: number[] = [];
  let run = 1;
  for (let i = S0 + 1; i < buf.length; i++) {
    if (Math.abs(buf[i]! - buf[i - 1]!) <= tol) run++;
    else {
      runs.push(run);
      run = 1;
    }
  }
  runs.push(run);
  return runs;
}

/** The most common plateau length — the hold, immune to the two partial runs at
 *  the window edges. */
function modalHold(buf: Float32Array, tol = 1e-4): number {
  const m = new Map<number, number>();
  for (const r of plateaus(buf, tol)) m.set(r, (m.get(r) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/** Distinct QUANTISATION-GRID cells visited over the tail. Exact — the
 *  quantiser's output lands on the grid and the dry leak displaces it by
 *  ~3e-5, far under half a step for every depth exercised here. */
function gridCells(buf: Float32Array, bits: number): number {
  const levels = Math.pow(2, bits - 1);
  const seen = new Set<number>();
  for (let i = S0; i < buf.length; i++) seen.add(Math.round(buf[i]! * levels));
  return seen.size;
}

function rms(buf: Float32Array): number {
  let a = 0;
  for (let i = S0; i < buf.length; i++) a += buf[i]! * buf[i]!;
  return Math.sqrt(a / (buf.length - S0));
}

/** RMS of (output − dry) over the tail: how far from clean, in linear units. */
function errRms(out: Float32Array, dry: Float32Array): number {
  let a = 0;
  for (let i = S0; i < out.length; i++) {
    const d = out[i]! - dry[i]!;
    a += d * d;
  }
  return Math.sqrt(a / (out.length - S0));
}

const db = (x: number): number => 20 * Math.log10(x);

/** Single-bin magnitude, for the alias legs. */
function goertzel(buf: Float32Array, freqHz: number): number {
  const n = buf.length - S0;
  const w = (2 * Math.PI * freqHz) / SR;
  const c = 2 * Math.cos(w);
  let q1 = 0;
  let q2 = 0;
  for (let i = S0; i < buf.length; i++) {
    const q0 = c * q1 - q2 + buf[i]!;
    q2 = q1;
    q1 = q0;
  }
  const re = q1 - q2 * Math.cos(w);
  const im = q2 * Math.sin(w);
  return (2 / n) * Math.sqrt(re * re + im * im);
}

/** Spectral centroid over a 1024-sample window of the tail, in Hz. */
function centroidHz(buf: Float32Array): number {
  const n = 1024;
  let num = 0;
  let den = 0;
  for (let k = 1; k < n / 2; k++) {
    const w = (2 * Math.PI * k) / n;
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      const v = buf[S0 + t]!;
      re += v * Math.cos(w * t);
      im -= v * Math.sin(w * t);
    }
    const mag = Math.hypot(re, im);
    num += mag * ((k * SR) / n);
    den += mag;
  }
  return den > 0 ? num / den : 0;
}

describe('ART destroy / face audit — the harness and its own controls', () => {
  it('the harness rate matches the rate the faceplate states its numbers at', () => {
    expect(SR_AGREES, `harness SR ${SR} vs DESTROY_REFERENCE_SR ${DESTROY_REFERENCE_SR}`)
      .toBe(true);
  });

  it('renders BIT-IDENTICALLY twice at four corners (#1680)', async () => {
    for (const p of [
      { decimate: 1, bits: 16, wet: 1 },
      { decimate: 8, bits: 3, wet: 1 },
      { decimate: 64, bits: 1, wet: 0.5 },
      { decimate: 32, bits: 8, wet: 0.25 },
    ]) {
      const a = await render(p, noise);
      const b = await render(p, noise);
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i]! - b[i]!));
      expect(diff, `re-render delta (linear) at ${JSON.stringify(p)}`).toBe(0);
    }
  });

  it('CONTROL 1 — a BIT-EQUALITY census still reports "decimation does nothing"', async () => {
    // The −89.8 dB dry leak, kept as a permanent trap. If this ever starts
    // AGREEING with the tolerance census, the leak has been closed and the
    // header's warning has to be rewritten rather than quietly inherited.
    const out = await render({ decimate: 16, bits: 16, wet: 1 }, richSine);
    expect(modalHold(out, 0), 'bit-exact plateau at DECIMATE 16').toBe(1);
    expect(modalHold(out, 1e-4), 'tolerance plateau at DECIMATE 16').toBe(16);
  });

  it('CONTROL 2 — the residual dry path at WET 1 is the reason for CONTROL 1', async () => {
    // BITS 1 with a source under the dead zone quantises to EXACTLY zero, so
    // whatever is left at the jack is dry that `(1 − wet)` never closed.
    const amp = 0.4; // < 2^-1, i.e. inside the 1-bit dead zone
    const src = vcoTestSignal({ totalS: DUR_S, shape: 'sine', freqHz: C4_HZ, amp });
    const out = await render({ decimate: 1, bits: 1, wet: 1 }, src);
    const leakDb = db(rms(out) / rms(src));
    expect(leakDb, `residual dry at WET 1 = ${leakDb.toFixed(2)} dB re dry`).toBeLessThan(-80);
    expect(leakDb, `residual dry at WET 1 = ${leakDb.toFixed(2)} dB re dry`).toBeGreaterThan(-100);
  });

  it('CONTROL 3 — a 1000 Hz source still reports "bit reduction does nothing"', async () => {
    // 1000 Hz is exactly 48 samples/period at 48 kHz: 25 distinct magnitudes,
    // whatever the quantiser does. The rich source sees the grid; this one
    // cannot, and the pair is what makes the census below trustworthy.
    const blind = await Promise.all(
      [16, 12, 8].map((b) => render({ decimate: 1, bits: b, wet: 1 }, aliasedSine)),
    );
    const counts = blind.map((o, i) => gridCells(o, [16, 12, 8][i]!));
    expect(new Set(counts).size, `phase-limited source counts: ${counts.join(', ')}`).toBe(1);

    const sighted = await Promise.all(
      [16, 12, 8].map((b) => render({ decimate: 1, bits: b, wet: 1 }, richSine)),
    );
    const rich = sighted.map((o, i) => gridCells(o, [16, 12, 8][i]!));
    expect(new Set(rich).size, `rich source counts: ${rich.join(', ')}`).toBe(3);
  });
});

describe('ART destroy / face audit — #1716, the hold length', () => {
  it('holds EXACTLY round(DECIMATE) samples at every integer position 1..64', async () => {
    const offenders: string[] = [];
    for (let d = 1; d <= 64; d++) {
      const out = await render({ decimate: d, bits: 16, wet: 1 }, richSine);
      const hold = modalHold(out);
      const want = destroyHoldSamples(d);
      if (hold !== want) offenders.push(`DECIMATE ${d}: measured hold ${hold} samples, model ${want}`);
      // THE PRE-FIX LAW, as a permanent negative control: `int(d)` on the value
      // the stalled smoother presents reads one step LOW everywhere.
      const truncated = Math.trunc(d - 4.8e-4);
      if (d > 1 && hold === truncated) {
        offenders.push(`DECIMATE ${d}: hold ${hold} MATCHES the pre-#1716 truncating law`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  }, 60_000);

  it('DECIMATE 2 is a real halving, not the no-op it shipped as', async () => {
    // The headline of #1716, isolated: before the fix this measured a hold of 1
    // — `ba.period(1)`, i.e. no decimation at all.
    const out = await render({ decimate: 2, bits: 16, wet: 1 }, richSine);
    expect(modalHold(out), 'hold samples at DECIMATE 2').toBe(2);
    expect(
      SR / modalHold(out),
      'effective sample rate at DECIMATE 2 (Hz)',
    ).toBeCloseTo(destroyEffectiveSrHz({ decimate: 2, bits: 16, wet: 1 }), 6);
  });

  it('rounds at the half-step boundaries a CV lands on', async () => {
    for (const d of [1.4, 1.6, 2.49, 2.51, 8.49]) {
      const out = await render({ decimate: d, bits: 16, wet: 1 }, richSine);
      expect(modalHold(out), `hold samples at DECIMATE ${d}`).toBe(destroyHoldSamples(d));
    }
  }, 30_000);

  it('the `rate` readout is the rate the module actually leaves behind', async () => {
    const offenders: string[] = [];
    for (const d of [1, 2, 4, 8, 16, 32, 64]) {
      const out = await render({ decimate: d, bits: 16, wet: 1 }, richSine);
      const measured = SR / modalHold(out);
      const printed = destroyEffectiveSrHz({ decimate: d, bits: 16, wet: 1 });
      if (Math.abs(measured - printed) > 1e-6) {
        offenders.push(`DECIMATE ${d}: measured ${measured.toFixed(1)} Hz, face prints ${printed.toFixed(1)} Hz`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  }, 30_000);
});

describe('ART destroy / face audit — the decimator is a REAL sample-rate reduction', () => {
  it('material above the fold comes back down as a different, LOUDER pitch', async () => {
    // The fold is `rate / 2`. There is no anti-alias filter, so a tone above it
    // does not roll off — it reflects. This is what makes `rate` an actionable
    // number rather than a curiosity.
    const tone = vcoTestSignal({ totalS: DUR_S, shape: 'sine', freqHz: 5000, amp: 0.5 });

    // ABOVE the fold: DECIMATE 8 → 6000 Hz effective, fold 3000 Hz.
    const above = await render({ decimate: 8, bits: 16, wet: 1 }, tone);
    const fund = goertzel(above, 5000);
    const alias = goertzel(above, 1000); // |6000 − 5000|
    expect(
      db(alias) - db(fund),
      `alias 1000 Hz vs fundamental 5000 Hz at DECIMATE 8: ` +
        `alias ${alias.toFixed(4)}, fund ${fund.toFixed(4)} (dB re each other)`,
    ).toBeGreaterThan(6);

    // NEGATIVE CONTROL — BELOW the fold the fundamental is still the LARGEST
    // component. DECIMATE 4 → 12000 Hz effective, fold 6000 Hz, 5000 Hz under
    // it.
    //
    // ⚠ THE CONTROL IS "WHICH ONE WINS", NOT "IS THE MIRROR BIN EMPTY", and
    // the first draft of this test got that wrong and was RED. A zero-order
    // hold is not an ideal reconstructor: it emits IMAGES at k·effSR ± f
    // whatever you feed it, sinc-attenuated but present, so the 7000 Hz mirror
    // of a below-fold 5000 Hz tone measures 0.273 — a perfectly correct number
    // that reads exactly like an aliasing failure. What crossing the fold
    // actually changes is the ORDERING: below it the note you played is the
    // loudest thing at the jack; above it a note you did not play is.
    const below = await render({ decimate: 4, bits: 16, wet: 1 }, tone);
    const belowFund = goertzel(below, 5000);
    const belowImage = goertzel(below, 7000); // |12000 − 5000|
    expect(
      belowFund,
      `a 5000 Hz tone under the DECIMATE 4 fold (6000 Hz): fundamental ` +
        `${belowFund.toFixed(4)} vs its 7000 Hz image ${belowImage.toFixed(4)}`,
    ).toBeGreaterThan(belowImage);
    // …and it is still most of what went in (the ZOH sinc takes some of it).
    expect(belowFund, 'the below-fold fundamental survives').toBeGreaterThan(0.3);
  });
});

describe('ART destroy / face audit — the quantiser, and the two dB edges the face prints', () => {
  it('the `floor` readout matches the measured crush artefact within 0.2 dB', async () => {
    // Across bit depth AND wet, on broadband so the quantiser is fully
    // exercised. The closed form is `20log10(wet · step / sqrt(12))`.
    const offenders: string[] = [];
    for (const bits of [16, 12, 8, 6, 4, 3, 2, 1]) {
      const out = await render({ decimate: 1, bits, wet: 1 }, noise);
      const measured = db(errRms(out, noise));
      const printed = destroyBitFloorDb({ decimate: 1, bits, wet: 1 });
      if (Math.abs(measured - printed) > 0.2) {
        offenders.push(
          `BITS ${bits}: measured ${measured.toFixed(2)} dBFS, face prints ${printed.toFixed(2)} dBFS`,
        );
      }
    }
    for (const wet of [1, 0.75, 0.5, 0.25, 0.1]) {
      const out = await render({ decimate: 1, bits: 4, wet }, noise);
      const measured = db(errRms(out, noise));
      const printed = destroyBitFloorDb({ decimate: 1, bits: 4, wet });
      if (Math.abs(measured - printed) > 0.2) {
        offenders.push(
          `WET ${wet} at BITS 4: measured ${measured.toFixed(2)} dBFS, face prints ${printed.toFixed(2)} dBFS`,
        );
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  }, 30_000);

  it('`floor` is the BIT stage only, and the face says so by printing `rate` beside it', async () => {
    // ⚠ STATED AS A LIMIT RATHER THAN LEFT IMPLICIT (the #1744 class). A
    // sample-and-hold error is a function of the INPUT's slew, so no pure
    // function of the params can print the decimator's contribution — and at
    // high DECIMATE that contribution is ENORMOUS next to the quantiser's.
    const out = await render({ decimate: 64, bits: 16, wet: 1 }, noise);
    const total = db(errRms(out, noise));
    const bitStage = destroyBitFloorDb({ decimate: 64, bits: 16, wet: 1 });
    expect(
      total,
      `total error at DECIMATE 64 / BITS 16 = ${total.toFixed(2)} dBFS, ` +
        `bit stage alone = ${bitStage.toFixed(2)} dBFS`,
    ).toBeGreaterThan(bitStage + 60);
  });

  it('the `mute` readout is a CLIFF: 1.2x over it is loud, 0.98x of it is gone', async () => {
    const offenders: string[] = [];
    for (const bits of [1, 2, 4, 8]) {
      const threshold = Math.pow(10, destroyMuteDb(bits) / 20);
      const srcOver = vcoTestSignal({ totalS: DUR_S, shape: 'sine', freqHz: C4_HZ, amp: threshold * 1.2 });
      const srcUnder = vcoTestSignal({ totalS: DUR_S, shape: 'sine', freqHz: C4_HZ, amp: threshold * 0.98 });
      const over = await render({ decimate: 1, bits, wet: 1 }, srcOver);
      const under = await render({ decimate: 1, bits, wet: 1 }, srcUnder);
      const overDb = db(rms(over));
      const underDb = db(rms(under));
      // Over the threshold the quantiser passes a full step; 2 % under it the
      // output collapses to the dry leak. The gap measures 94-95 dB at every
      // depth here; 40 dB is a floor on it, not a transcription of it.
      if (overDb - underDb < 40) {
        offenders.push(
          `BITS ${bits} (mute ${destroyMuteDb(bits).toFixed(1)} dBFS): ` +
            `1.2x → ${overDb.toFixed(1)} dBFS, 0.98x → ${underDb.toFixed(1)} dBFS`,
        );
      }
      // NEGATIVE CONTROL on the metric — it must be able to read a signal that
      // SURVIVES, and the reference is the SOURCE, not an absolute level.
      //
      // ⚠ AN ABSOLUTE FLOOR IS THE WRONG CONTROL HERE and the first draft used
      // one (`overDb > -30`) and was RED at BITS 8. The threshold IS the bit
      // depth: at 8 bits it sits at -48.2 dBFS, so the surviving leg is a
      // -46.4 dBFS signal and "quiet" is the correct answer, not a failure.
      const srcOverDb = db(rms(srcOver));
      if (overDb < srcOverDb - 6) {
        offenders.push(
          `BITS ${bits}: the over-threshold leg lost the signal — ` +
            `source ${srcOverDb.toFixed(1)} dBFS → out ${overDb.toFixed(1)} dBFS`,
        );
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  }, 30_000);
});

describe('ART destroy / face audit — the two claims the FACE STRUCTURE rests on', () => {
  it('the level census is a function of BITS ALONE — the queue-spec JOIN DISPROVED', async () => {
    // §Q18 predicted "the number of distinct output levels is a function of
    // BITS and DECIMATE together (a held sample is quantised once)". Measured,
    // decimation RE-USES grid cells rather than removing them. Asserted at the
    // low depths where the grid is small enough for a 0.3 s window to fill it,
    // so the result is a property of the cascade and not of the window.
    for (const bits of [4, 3, 2]) {
      const counts: number[] = [];
      for (const decimate of [1, 2, 4, 8, 16, 64]) {
        counts.push(gridCells(await render({ decimate, bits, wet: 1 }, richSine), bits));
      }
      expect(
        new Set(counts).size,
        `BITS ${bits}: level census across DECIMATE 1..64 = ${counts.join(', ')}`,
      ).toBe(1);
    }
  }, 30_000);

  it('a LEVEL METER is blind to DECIMATE — which is why the glyph is a trace', async () => {
    // The glyph argument, as a measurement rather than a house style. Same
    // travel, two metrics: RMS says nothing, error-vs-dry says 99 dB.
    const ends = await Promise.all(
      [1, 64].map((decimate) => render({ decimate, bits: 16, wet: 1 }, noise)),
    );
    const levelSpread = Math.abs(db(rms(ends[0]!)) - db(rms(ends[1]!)));
    const errorSpread = Math.abs(db(errRms(ends[0]!, noise)) - db(errRms(ends[1]!, noise)));
    expect(
      levelSpread,
      `output RMS across the whole DECIMATE travel = ${levelSpread.toFixed(2)} dB`,
    ).toBeLessThan(1);
    expect(
      errorSpread,
      `error-vs-dry across the same travel = ${errorSpread.toFixed(2)} dB`,
    ).toBeGreaterThan(80);
    // …and the same pair on a sine, where the meter is bit-exactly still.
    const sineEnds = await Promise.all(
      [1, 64].map((decimate) => render({ decimate, bits: 16, wet: 1 }, richSine)),
    );
    expect(
      Math.abs(db(rms(sineEnds[0]!)) - db(rms(sineEnds[1]!))),
      'output RMS across the DECIMATE travel on a sine (dB)',
    ).toBeLessThan(0.05);
  });

  it('DECIMATE is the TIMBRAL axis and BITS is not — the rank, on one metric', async () => {
    // Rank 1 vs rank 2, measured on broadband where a centroid means something.
    const clean = centroidHz(noise);
    const decimated = centroidHz(await render({ decimate: 64, bits: 16, wet: 1 }, noise));
    const crushed = centroidHz(await render({ decimate: 1, bits: 1, wet: 1 }, noise));
    const decMove = Math.abs(clean - decimated);
    const bitMove = Math.abs(clean - crushed);
    expect(
      decMove,
      `centroid: clean ${clean.toFixed(0)} Hz → DECIMATE 64 ${decimated.toFixed(0)} Hz ` +
        `(${decMove.toFixed(0)} Hz) vs BITS 1 ${crushed.toFixed(0)} Hz (${bitMove.toFixed(0)} Hz)`,
    ).toBeGreaterThan(bitMove * 5);
  }, 30_000);
});
