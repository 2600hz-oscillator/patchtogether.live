// art/scenarios/swolevco/mode-gating-and-face-readouts.test.ts
//
// THE FACEPLATE'S CENTRAL CLAIM, PINNED TO THE REAL DSP.
//
// `swolevco-face-model.test.ts` holds the readouts' negative controls as PURE
// arithmetic — fast, and blind to whether the arithmetic still describes the
// audio. This file closes that gap: it drives the SHIPPING
// `swolevcoDef.factory` under an OfflineAudioContext and asserts the two
// things the face is built on, against rendered samples.
//
//   1. AT THE SHIPPED DEFAULT `ratio = 1`, `mod_tune` AND `mod_fine` REACH
//      NOTHING — bit-exactly, on all three audio outputs. That is why they
//      rank 7 and 8 (dock-only) and why the LOCK readout exists. If a DSP
//      change ever makes them live at ratio > 0, this goes RED and the face's
//      ranking argument is stale rather than silently wrong.
//
//   2. THE `mod` READOUT PRINTS THE FREQUENCY THE MODULATOR ACTUALLY RUNS AT.
//      `swolevcoModHz` is checked against the rendered `mod_out`'s measured
//      frequency, not against a restatement of its own formula. This is the
//      leg that a pure unit test structurally cannot provide: the readout and
//      the DSP could agree with each other's bugs forever without it.
//
// ⚠ POSITIVE CONTROLS ARE PERMANENT LEGS, not authoring-time checks. A probe
// that reads `Δ = 0` because it is broken is indistinguishable from one that
// reads `Δ = 0` because the control is gated — so every inertness assertion
// here is paired with the SAME sweep at `ratio = 0`, where it must move.
//
// ⚠ FREQUENCY IS MEASURED BY INTERPOLATED ZERO-CROSSING, not by an FFT bin.
// A 4096-bin DFT at 48 kHz has 11.7 Hz of resolution, which cannot tell
// 261.626 Hz from 263.7 — and an unwindowed centroid is worse still: it reads
// this module's own pure-sine `mod_out` as 2904 Hz, because a
// frequency-weighted centroid is dominated by 1/f leakage sidelobes. The
// instrument's own positive control is the first assertion in this file.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { swolevcoDef, tuneFineToHz } from '../../../packages/web/src/lib/audio/modules/swolevco';
import {
  swolevcoFaceParams,
  swolevcoModHz,
} from '../../../packages/web/src/lib/ui/modules/swolevco-face-model';

const SR = 48000;

interface Rendered {
  out: Float32Array;
  mod_out: Float32Array;
  sum_out: Float32Array;
}

async function render(
  params: Record<string, number>,
  durationS = 0.5,
): Promise<Rendered> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 3,
    length: Math.round(SR * durationS),
    sampleRate: SR,
  });
  const node = {
    id: 'swolevco-1',
    type: 'swolevco',
    domain: 'audio' as const,
    position: { x: 0, y: 0 },
    params,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = await swolevcoDef.factory(ctx as any, node as any);
  const merger = ctx.createChannelMerger(3);
  const order = ['out', 'mod_out', 'sum_out'] as const;
  order.forEach((id, idx) => {
    const o = handle.outputs.get(id);
    if (o) o.node.connect(merger, o.output, idx);
  });
  merger.connect(ctx.destination);
  const r = await ctx.startRendering();
  return {
    out: r.getChannelData(0).slice(),
    mod_out: r.getChannelData(1).slice(),
    sum_out: r.getChannelData(2).slice(),
  };
}

/** `max|a − b|` over the whole render. A gated control reads EXACTLY 0. */
function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

/**
 * Frequency by POSITIVE-GOING zero crossings with linear interpolation,
 * measured over the tail half (past any start transient) and over a whole
 * number of crossings. Renderer-independent and far sharper than an FFT bin
 * for a clean periodic signal.
 */
function zeroCrossHz(b: Float32Array): number {
  const from = Math.floor(b.length / 2);
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = from + 1; i < b.length; i++) {
    if (b[i - 1]! < 0 && b[i]! >= 0) {
      const t = i - 1 + -b[i - 1]! / (b[i]! - b[i - 1]!);
      if (first < 0) first = t;
      else {
        last = t;
        count++;
      }
    }
  }
  return count < 1 ? NaN : (count * SR) / (last - first);
}

function peakOf(b: Float32Array): number {
  let p = 0;
  for (let i = 0; i < b.length; i++) p = Math.max(p, Math.abs(b[i]!));
  return p;
}

describe('SWOLEVCO ART: the instrument, before anything measured with it', () => {
  it('POSITIVE CONTROL — mod_out at the defaults is a 261.626 Hz sine, and the probe says so', async () => {
    // The module hands us a known truth for free: at `ratio = 1`, `tune = 0`,
    // the modulator is C4. An instrument that cannot recover it cannot be
    // trusted on anything below.
    const { mod_out } = await render({}, 4);
    expect(zeroCrossHz(mod_out)).toBeCloseTo(261.626, 2);
    expect(peakOf(mod_out)).toBeGreaterThan(0.99);
  }, 120000);

  it('NEGATIVE CONTROL — the probe MOVES when the frequency does', async () => {
    const up = await render({ tune: 12 }, 4);
    const down = await render({ tune: -12 }, 4);
    expect(zeroCrossHz(up.mod_out)).toBeCloseTo(523.252, 2);
    expect(zeroCrossHz(down.mod_out)).toBeCloseTo(130.813, 2);
  }, 180000);
});

describe('SWOLEVCO ART: M.TUNE / M.FINE are BIT-EXACTLY inert at the shipped default', () => {
  // The finding the faceplate is built on. `ratio` defaults to 1, so the
  // modulator's free-run leg is gated off and these two dials reach nothing.
  it('sweeping mod_tune across its FULL range moves no sample on any output', async () => {
    const ref = await render({});
    for (const mod_tune of [-36, -18, 18, 36]) {
      const r = await render({ mod_tune });
      for (const port of ['out', 'mod_out', 'sum_out'] as const) {
        expect(
          maxAbsDiff(r[port], ref[port]),
          `mod_tune=${mod_tune} must not move ${port} at the default ratio=1`,
        ).toBe(0);
      }
    }
  }, 300000);

  it('sweeping mod_fine across its FULL range moves no sample on any output', async () => {
    const ref = await render({});
    for (const mod_fine of [-100, -50, 50, 100]) {
      const r = await render({ mod_fine });
      for (const port of ['out', 'mod_out', 'sum_out'] as const) {
        expect(
          maxAbsDiff(r[port], ref[port]),
          `mod_fine=${mod_fine} must not move ${port} at the default ratio=1`,
        ).toBe(0);
      }
    }
  }, 300000);

  it('POSITIVE CONTROL — the SAME sweep at ratio = 0 moves the modulator over six octaves', async () => {
    // Without this leg, "Δ = 0" is indistinguishable from a broken probe. At
    // ratio = 0 the free-run leg is the ONLY leg, so mod_tune is the whole
    // pitch: −36 st → 32.7 Hz, +36 st → 2093 Hz.
    const seen: number[] = [];
    for (const mod_tune of [-36, 0, 36]) {
      const r = await render({ ratio: 0, mod_tune }, 4);
      seen.push(zeroCrossHz(r.mod_out));
    }
    expect(seen[0]).toBeCloseTo(32.703, 1);
    expect(seen[1]).toBeCloseTo(261.626, 1);
    expect(seen[2]).toBeCloseTo(2093.005, 1);
    expect(seen[2]! / seen[0]!).toBeCloseTo(64, 0); // exactly six octaves
  }, 300000);

  it('and mod_fine is live there too — a full ±100 ¢ is a semitone either way', async () => {
    const flat = await render({ ratio: 0, mod_fine: -100 }, 4);
    const sharp = await render({ ratio: 0, mod_fine: 100 }, 4);
    expect(zeroCrossHz(flat.mod_out)).toBeCloseTo(tuneFineToHz(0, -100), 1);
    expect(zeroCrossHz(sharp.mod_out)).toBeCloseTo(tuneFineToHz(0, 100), 1);
  }, 300000);
});

describe('SWOLEVCO ART: the `mod` READOUT prints the frequency the DSP actually runs at', () => {
  // The leg a pure unit test cannot give: `swolevcoModHz` is compared against
  // MEASURED audio, so the readout and the factory cannot drift into agreeing
  // with each other's bugs.
  //
  // ⚠ The ratios below all sit OUTSIDE the LUT crossover band. The factory's
  // two legs cross over one LUT cell rather than switching instantaneously, so
  // for `ratio` in roughly (0, 0.005) the modulator is a BLEND of both and the
  // readout reports only the locked leg — documented on `swolevcoModHz`, under
  // 0.07 % of the fader's travel, and reachable by CV rather than by hand.
  const CASES: readonly { params: Record<string, number>; why: string }[] = [
    { params: {}, why: 'the shipped default — ratio-locked 1:1 at C4' },
    { params: { ratio: 2 }, why: 'an octave above the primary' },
    { params: { ratio: 0.5 }, why: 'an octave below' },
    { params: { ratio: 0.05 }, why: 'sub-audio, where the readout says so' },
    { params: { ratio: 1, tune: 12 }, why: 'locked mode TRACKS the primary pitch' },
    { params: { ratio: 1, fine: 100 }, why: '…including FINE, which no modulator dial shows' },
    { params: { ratio: 0, mod_tune: 7 }, why: 'free-run — the other branch entirely' },
    { params: { ratio: 0, mod_tune: -12, mod_fine: 50 }, why: 'free-run, both dials live' },
  ];

  for (const { params, why } of CASES) {
    it(`${JSON.stringify(params)} — ${why}`, async () => {
      const r = await render(params, 4);
      const measured = zeroCrossHz(r.mod_out);
      const printed = swolevcoModHz(
        swolevcoFaceParams((id) => params[id]),
      );
      expect(Number.isFinite(measured), 'the probe must find a frequency').toBe(true);
      // 0.1 % — the zero-crossing estimator's own noise floor over a 2 s tail,
      // not a tolerance for the readout being approximately right.
      expect(Math.abs(measured - printed) / printed).toBeLessThan(0.001);
    }, 120000);
  }
});

describe('SWOLEVCO ART: two claims the banked spec carried that DO NOT reproduce', () => {
  // Both failed the same way — a statistics window shorter than the period of
  // the thing being measured. Pinned here so they cannot be re-derived from
  // the stale document and re-asserted as findings.
  it('low RATIO is a full-scale SUB-AUDIO SINE, not a DC rail on an audio jack', async () => {
    // The claim was "+0.574 of DC on mod_out at ratio = 1e-3". At ratio 0.005
    // the modulator is 1.3082 Hz (period 0.76 s); a 0.25 s window sees a third
    // of a cycle and calls it DC.
    const r = await render({ ratio: 0.005 }, 4);
    expect(zeroCrossHz(r.mod_out)).toBeCloseTo(tuneFineToHz(0, 0) * 0.005, 2);
    expect(peakOf(r.mod_out), 'it swings full scale — it is not stuck').toBeGreaterThan(0.99);

    const half = Math.floor(r.mod_out.length / 2);
    let sum = 0;
    for (let i = half; i < r.mod_out.length; i++) sum += r.mod_out[i]!;
    const dcOverTwoSeconds = sum / (r.mod_out.length - half);
    expect(Math.abs(dcOverTwoSeconds), 'DC over a window LONGER than the period').toBeLessThan(0.1);
  }, 120000);

  it('at RATIO = 1 the modulator is EXACTLY at the primary frequency — there is no beat', async () => {
    // The claim was a 15.2 dB `sum_out` swing with TUNE caused by "a residual
    // frequency/phase difference". The swing is real; the mechanism is not.
    // The two oscillators are frequency-identical, so what varies with pitch is
    // a static PHASE relationship, not a drift.
    for (const tune of [0, -7.2, 12]) {
      const r = await render({ tune, symmetry: 0 }, 4);
      const primary = zeroCrossHz(r.out);
      const modulator = zeroCrossHz(r.mod_out);
      expect(Math.abs(modulator - primary), `tune=${tune}: detune in Hz`).toBeLessThan(1e-3);
    }
  }, 300000);
});
