// packages/web/src/lib/audio/modules/timelorde-wizard.test.ts
//
// Unit tests for the pure TIMELORDE helpers: the beat-pulse math, the
// colour-targeted beat boost (the owl's YELLOW EYES + BLUE BORDER pulse, the
// brown body does NOT), the gate → on/off interpretation, and the big-display
// mode decision (owl ↔ live video).

import { describe, it, expect } from 'vitest';
import {
  beatPulse,
  rgbToHsv,
  colorBandMembership,
  beatBoostMembership,
  boostBeatColor,
  applyBeatBoost,
  beatBoostOverlayCoverage,
  buildBeatBoostOverlay,
  beatBoostOverlayAlpha,
  DEFAULT_BOOST_AMOUNT,
  YELLOW_BAND,
  BLUE_BAND,
  gateLevelToWizardOn,
  wizardDisplayMode,
} from './timelorde-wizard';
import { GATE_HI } from '$lib/audio/gate-trigger';

// Representative colours sampled from the owner's owl painting.
const EYE_YELLOW: [number, number, number] = [192, 170, 90]; // a bright eye pixel
const BORDER_BLUE: [number, number, number] = [34, 55, 110]; // a border pixel
const BODY_BROWN: [number, number, number] = [157, 110, 70]; // tan/brown plumage (hue ~24°)
const DARK_GROUND: [number, number, number] = [10, 10, 12]; // near-black ground

describe('timelorde-wizard: beatPulse', () => {
  const BPM = 120; // → 500 ms per beat
  const BEAT_MS = 60_000 / BPM;

  it('is 0 (idle) when the transport is stopped', () => {
    expect(beatPulse({ bpm: BPM, running: false, nowMs: 0, anchorMs: 0 })).toBe(0);
    // Even mid-beat: stopped means idle.
    expect(beatPulse({ bpm: BPM, running: false, nowMs: 123, anchorMs: 0 })).toBe(0);
  });

  it('is 0 for a non-positive BPM (avoids divide-by-zero)', () => {
    expect(beatPulse({ bpm: 0, running: true, nowMs: 10, anchorMs: 0 })).toBe(0);
    expect(beatPulse({ bpm: -5, running: true, nowMs: 10, anchorMs: 0 })).toBe(0);
  });

  it('flashes to full brightness exactly on the beat (phase 0)', () => {
    expect(beatPulse({ bpm: BPM, running: true, nowMs: 0, anchorMs: 0 })).toBe(1);
    // One full beat later → back on the beat → full again.
    expect(beatPulse({ bpm: BPM, running: true, nowMs: BEAT_MS, anchorMs: 0 })).toBeCloseTo(1, 5);
    // Two beats later, too.
    expect(beatPulse({ bpm: BPM, running: true, nowMs: 2 * BEAT_MS, anchorMs: 0 })).toBeCloseTo(1, 5);
  });

  it('decays linearly across the decay window then sits at 0 until the next beat', () => {
    const decayFraction = 0.6;
    const opts = { bpm: BPM, running: true, anchorMs: 0, decayFraction };
    // Halfway through the decay window → half brightness.
    const halfDecayMs = BEAT_MS * decayFraction * 0.5;
    expect(beatPulse({ ...opts, nowMs: halfDecayMs })).toBeCloseTo(0.5, 5);
    // Exactly at the end of the decay window → 0.
    const endDecayMs = BEAT_MS * decayFraction;
    expect(beatPulse({ ...opts, nowMs: endDecayMs })).toBe(0);
    // Past the decay window but before the next beat → still 0 (idle gap).
    expect(beatPulse({ ...opts, nowMs: BEAT_MS * 0.9 })).toBe(0);
  });

  it('measures phase from the start anchor (downbeat lands after a start)', () => {
    const anchorMs = 1000;
    // Right at the anchor → full flash.
    expect(beatPulse({ bpm: BPM, running: true, nowMs: anchorMs, anchorMs })).toBe(1);
    // One beat after the anchor → full flash again.
    expect(
      beatPulse({ bpm: BPM, running: true, nowMs: anchorMs + BEAT_MS, anchorMs }),
    ).toBeCloseTo(1, 5);
  });

  it('scales the pulse rate with BPM (faster tempo = more flashes/sec)', () => {
    // At 240 BPM the beat is 250 ms; at 250 ms a 120-BPM clock would be
    // mid-beat (phase 0.5) but a 240-BPM clock is exactly on the beat.
    expect(beatPulse({ bpm: 240, running: true, nowMs: 250, anchorMs: 0 })).toBeCloseTo(1, 5);
  });

  it('always returns a value within [0, 1]', () => {
    for (let t = 0; t < 2000; t += 7) {
      const v = beatPulse({ bpm: 137, running: true, nowMs: t, anchorMs: 13 });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('timelorde-wizard: rgbToHsv', () => {
  it('maps the primaries to their canonical hues', () => {
    expect(rgbToHsv(255, 0, 0).h).toBeCloseTo(0, 1);
    expect(rgbToHsv(0, 255, 0).h).toBeCloseTo(120, 1);
    expect(rgbToHsv(0, 0, 255).h).toBeCloseTo(240, 1);
    expect(rgbToHsv(255, 255, 0).h).toBeCloseTo(60, 1); // yellow
  });

  it('reports 0 saturation for greys and 0 value for black', () => {
    expect(rgbToHsv(128, 128, 128).s).toBe(0);
    expect(rgbToHsv(0, 0, 0).v).toBe(0);
  });
});

describe('timelorde-wizard: colorBandMembership (eyes vs border vs body)', () => {
  it('the YELLOW band claims the eye pixel, not the brown body', () => {
    expect(colorBandMembership(...EYE_YELLOW, YELLOW_BAND)).toBeGreaterThan(0.5);
    // The tan/brown body sits below the yellow hue floor → no membership.
    expect(colorBandMembership(...BODY_BROWN, YELLOW_BAND)).toBe(0);
  });

  it('the BLUE band claims the border pixel, not the eyes or the body', () => {
    expect(colorBandMembership(...BORDER_BLUE, BLUE_BAND)).toBeGreaterThan(0.5);
    expect(colorBandMembership(...EYE_YELLOW, BLUE_BAND)).toBe(0);
    expect(colorBandMembership(...BODY_BROWN, BLUE_BAND)).toBe(0);
  });

  it('the dark ground belongs to NEITHER band (too dark / unstable hue)', () => {
    expect(colorBandMembership(...DARK_GROUND, YELLOW_BAND)).toBe(0);
    expect(colorBandMembership(...DARK_GROUND, BLUE_BAND)).toBe(0);
  });
});

describe('timelorde-wizard: boostBeatColor (only eyes + border pulse)', () => {
  it('brightens a YELLOW eye pixel when the beat pulses', () => {
    const [r, g, b] = boostBeatColor(...EYE_YELLOW, 1);
    expect(r).toBeGreaterThan(EYE_YELLOW[0]);
    expect(g).toBeGreaterThan(EYE_YELLOW[1]);
    expect(b).toBeGreaterThan(EYE_YELLOW[2]);
  });

  it('brightens a BLUE border pixel when the beat pulses', () => {
    const [r, g, b] = boostBeatColor(...BORDER_BLUE, 1);
    expect(r).toBeGreaterThan(BORDER_BLUE[0]);
    expect(g).toBeGreaterThan(BORDER_BLUE[1]);
    expect(b).toBeGreaterThan(BORDER_BLUE[2]);
  });

  it('leaves the brown BODY and the dark GROUND unchanged at any pulse', () => {
    expect(boostBeatColor(...BODY_BROWN, 1)).toEqual(BODY_BROWN);
    expect(boostBeatColor(...DARK_GROUND, 1)).toEqual(DARK_GROUND);
  });

  it('does nothing at pulse 0 — the idle frame is the bare owl (VRT determinism)', () => {
    expect(boostBeatColor(...EYE_YELLOW, 0)).toEqual(EYE_YELLOW);
    expect(boostBeatColor(...BORDER_BLUE, 0)).toEqual(BORDER_BLUE);
  });

  it('boosts more as the pulse rises (monotone glow)', () => {
    const half = boostBeatColor(...EYE_YELLOW, 0.5)[0];
    const full = boostBeatColor(...EYE_YELLOW, 1)[0];
    expect(half).toBeGreaterThan(EYE_YELLOW[0]);
    expect(full).toBeGreaterThan(half);
  });

  it('never overshoots 255 (lerp toward white is bounded)', () => {
    for (const p of [0.25, 0.5, 0.75, 1]) {
      for (const [r, g, b] of [EYE_YELLOW, BORDER_BLUE]) {
        const out = boostBeatColor(r, g, b, p, 5 /* absurd amount */);
        for (const c of out) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(255);
        }
      }
    }
  });
});

describe('timelorde-wizard: applyBeatBoost (whole-frame, in place)', () => {
  /** Build a tiny RGBA buffer from a list of [r,g,b] pixels (alpha 255). */
  function frame(pixels: Array<[number, number, number]>): Uint8ClampedArray {
    const data = new Uint8ClampedArray(pixels.length * 4);
    pixels.forEach(([r, g, b], i) => {
      data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
    });
    return data;
  }

  it('boosts eyes + border pixels, leaves body + ground + alpha untouched', () => {
    const data = frame([EYE_YELLOW, BORDER_BLUE, BODY_BROWN, DARK_GROUND]);
    applyBeatBoost(data, 1);
    // eyes (idx 0) brighter
    expect(data[0]).toBeGreaterThan(EYE_YELLOW[0]);
    // border (idx 1) brighter
    expect(data[4]).toBeGreaterThan(BORDER_BLUE[0]);
    // body (idx 2) UNCHANGED
    expect([data[8], data[9], data[10]]).toEqual(BODY_BROWN);
    // ground (idx 3) UNCHANGED
    expect([data[12], data[13], data[14]]).toEqual(DARK_GROUND);
    // alpha channels all preserved
    expect([data[3], data[7], data[11], data[15]]).toEqual([255, 255, 255, 255]);
  });

  it('is a no-op at pulse 0 (idle frame == the bare owl)', () => {
    const data = frame([EYE_YELLOW, BORDER_BLUE]);
    const before = Uint8ClampedArray.from(data);
    applyBeatBoost(data, 0);
    expect(data).toEqual(before);
  });

  it('returns the same buffer for chaining', () => {
    const data = frame([EYE_YELLOW]);
    expect(applyBeatBoost(data, 0.5)).toBe(data);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The boost as an OVERLAY — parity with the per-pixel reference
// ─────────────────────────────────────────────────────────────────────────
//
// `applyBeatBoost`/`boostBeatColor` are the REFERENCE ORACLE here: the producer
// no longer runs them per frame, it draws a baked white-with-alpha overlay at
// `globalAlpha = pulse·amount` instead (timelorde-wizard.ts §2b). These legs
// prove NUMERICALLY that the overlay lands on the same bytes, so the frame the
// user sees did not change when the readback left.
//
// ⚠ WHAT THIS MODELS AND WHAT IT CANNOT SEE. `sourceOverWhite` below is the
// arithmetic a canvas performs for an opaque-white premultiplied source of
// coverage `a8`, scaled by paint alpha `α`, over an opaque destination `c`,
// with ONE rounding at the 8-bit store — the float compositor Chromium's GPU
// raster and highp CPU pipelines implement. It is not the browser. The
// real-compositor measurement — the same overlay drawn by a real Chromium
// canvas against the same reference on the real owl — is
// `e2e/tests/timelorde-owl-overlay-parity.spec.ts`; this file is the exhaustive
// grid that e2e cannot afford.

/** The source-over model: what an opaque-white pixel of 8-bit coverage `a8`,
 *  drawn at paint alpha `alpha`, lands as over an opaque channel `c`.
 *  out = 255·k + c·(1 − k) with k = (a8/255)·alpha, rounded once to 8 bits. */
function sourceOverWhite(c: number, a8: number, alpha: number): number {
  return Math.round(c + (255 - c) * (a8 / 255) * alpha);
}

/** HSV → RGB (0..255 ints), for synthesising colours AT the band edges. */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((q) => Math.round((q + m) * 255)) as [number, number, number];
}

describe('timelorde-wizard: the beat boost as an OVERLAY (parity with boostBeatColor)', () => {
  it('beatBoostMembership is the max of the two bands — the one classifier both forms share', () => {
    for (const px of [EYE_YELLOW, BORDER_BLUE, BODY_BROWN, DARK_GROUND]) {
      expect(beatBoostMembership(...px)).toBe(
        Math.max(colorBandMembership(...px, YELLOW_BAND), colorBandMembership(...px, BLUE_BAND)),
      );
    }
    expect(beatBoostMembership(...EYE_YELLOW)).toBeGreaterThan(0.5);
    expect(beatBoostMembership(...BORDER_BLUE)).toBeGreaterThan(0.5);
    expect(beatBoostMembership(...BODY_BROWN)).toBe(0);
    expect(beatBoostMembership(...DARK_GROUND)).toBe(0);
  });

  it('the overlay is WHITE everywhere with alpha = quantised membership', () => {
    const src = new Uint8ClampedArray(4 * 4);
    [EYE_YELLOW, BORDER_BLUE, BODY_BROWN, DARK_GROUND].forEach(([r, g, b], i) => {
      src[i * 4] = r; src[i * 4 + 1] = g; src[i * 4 + 2] = b; src[i * 4 + 3] = 255;
    });
    const out = buildBeatBoostOverlay(src);
    for (let i = 0; i < 4; i++) {
      expect([out[i * 4], out[i * 4 + 1], out[i * 4 + 2]]).toEqual([255, 255, 255]);
    }
    expect(out[3]).toBe(beatBoostOverlayCoverage(beatBoostMembership(...EYE_YELLOW)));
    expect(out[7]).toBe(beatBoostOverlayCoverage(beatBoostMembership(...BORDER_BLUE)));
    expect(out[11], 'the body is NOT in the overlay').toBe(0);
    expect(out[15], 'the ground is NOT in the overlay').toBe(0);
    // Writes into a caller-supplied buffer (the producer hands in
    // `createImageData().data`) and returns it for chaining.
    const dst = new Uint8ClampedArray(src.length);
    expect(buildBeatBoostOverlay(src, dst)).toBe(dst);
    expect(dst).toEqual(out);
  });

  it('the per-frame scalar is pulse·amount, and 0 at pulse 0 (the bare-owl frame)', () => {
    expect(beatBoostOverlayAlpha(0)).toBe(0);
    expect(beatBoostOverlayAlpha(-1)).toBe(0);
    expect(beatBoostOverlayAlpha(1)).toBeCloseTo(DEFAULT_BOOST_AMOUNT, 10);
    expect(beatBoostOverlayAlpha(0.5)).toBeCloseTo(0.5 * DEFAULT_BOOST_AMOUNT, 10);
    expect(beatBoostOverlayAlpha(1, 0)).toBe(0);
    expect(beatBoostOverlayAlpha(5, 5), 'clamped to 1').toBe(1);
  });

  it('⚠ THE PARITY GRID: overlay composite == boostBeatColor within ±1 per channel, everywhere', () => {
    // Every colour on a 32³ grid, plus colours synthesised AT every band edge
    // and feather point (in HSV, at and around the sat/val floors), at pulses
    // spanning the decay including its ends. The overlay's only departure from
    // the reference is the 8-bit quantisation of membership, so the deviation
    // is bounded by (255 − c)·0.5/255·amount < 0.5 before the shared rounding —
    // ±1 after it. The MAXIMUM is asserted, not a mean: a single pixel off by
    // two is a picture that changed.
    const colours: Array<[number, number, number]> = [];
    for (let r = 0; r < 256; r += 8)
      for (let g = 0; g < 256; g += 8)
        for (let b = 0; b < 256; b += 8) colours.push([r, g, b]);
    for (const band of [YELLOW_BAND, BLUE_BAND]) {
      const hues = [
        band.hueLo - band.feather - 0.5, band.hueLo - band.feather, band.hueLo - band.feather + 0.5,
        band.hueLo - band.feather / 2, band.hueLo - 0.5, band.hueLo, band.hueLo + 0.5,
        (band.hueLo + band.hueHi) / 2,
        band.hueHi - 0.5, band.hueHi, band.hueHi + 0.5, band.hueHi + band.feather / 2,
        band.hueHi + band.feather - 0.5, band.hueHi + band.feather, band.hueHi + band.feather + 0.5,
      ];
      const sats = [band.satMin - 0.01, band.satMin, band.satMin + 0.01, 0.5, 0.75, 1];
      const vals = [band.valMin - 0.01, band.valMin, band.valMin + 0.01, 0.5, 0.75, 1];
      for (const h of hues) for (const s of sats) for (const v of vals) colours.push(hsvToRgb(h, s, v));
    }
    const pulses = [0, 0.01, 0.05, 0.1, 0.2, 0.25, 1 / 3, 0.4, 0.5, 0.6, 2 / 3, 0.75, 0.9, 0.99, 1];

    let maxDev = 0;
    let where = '';
    let exact = 0;
    let total = 0;
    let members = 0;
    for (const [r, g, b] of colours) {
      const a8 = beatBoostOverlayCoverage(beatBoostMembership(r, g, b));
      if (a8 > 0) members++;
      for (const pulse of pulses) {
        const alpha = beatBoostOverlayAlpha(pulse);
        const ref = boostBeatColor(r, g, b, pulse);
        const got = [r, g, b].map((c) => sourceOverWhite(c, a8, alpha));
        for (let ch = 0; ch < 3; ch++) {
          const dev = Math.abs(got[ch]! - ref[ch]!);
          total++;
          if (dev === 0) exact++;
          if (dev > maxDev) {
            maxDev = dev;
            where = `rgb(${r},${g},${b}) pulse=${pulse} ch${ch}: overlay ${got[ch]} vs reference ${ref[ch]} (a8=${a8})`;
          }
        }
      }
    }
    expect(members, 'the grid actually reaches the bands (instrument check)').toBeGreaterThan(1000);
    expect(exact, 'and most values are EXACT, not merely within tolerance').toBeGreaterThan(total * 0.95);
    expect(maxDev, `max per-channel deviation ${maxDev} at ${where}`).toBeLessThanOrEqual(1);
  });

  it('a whole frame: applyBeatBoost vs the overlay composite, ±1 everywhere, EXACT at pulse 0', () => {
    // The buffer form, on a deterministic pseudo-random raster seeded so the
    // failure (if any) is reproducible, with the four reference pixels mixed
    // in. `pulse = 0` is the reduced-motion / stopped-transport frame the VRT
    // baseline captures: the overlay is not drawn at all then, so the frame is
    // the bare owl BYTE FOR BYTE.
    const N = 4096;
    const src = new Uint8ClampedArray(N * 4);
    let seed = 0x9e3779b9;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) >>> 24);
    for (let i = 0; i < N; i++) {
      src[i * 4] = rnd(); src[i * 4 + 1] = rnd(); src[i * 4 + 2] = rnd(); src[i * 4 + 3] = 255;
    }
    [EYE_YELLOW, BORDER_BLUE, BODY_BROWN, DARK_GROUND].forEach(([r, g, b], i) => {
      src[i * 4] = r; src[i * 4 + 1] = g; src[i * 4 + 2] = b;
    });
    const overlay = buildBeatBoostOverlay(src);

    for (const pulse of [0.5, 1, 0.1]) {
      const ref = applyBeatBoost(Uint8ClampedArray.from(src), pulse);
      const alpha = beatBoostOverlayAlpha(pulse);
      let maxDev = 0;
      for (let i = 0; i < src.length; i += 4) {
        for (let ch = 0; ch < 3; ch++) {
          const got = sourceOverWhite(src[i + ch]!, overlay[i + 3]!, alpha);
          maxDev = Math.max(maxDev, Math.abs(got - ref[i + ch]!));
        }
        expect(ref[i + 3], 'alpha untouched by either form').toBe(255);
      }
      expect(maxDev, `pulse ${pulse}`).toBeLessThanOrEqual(1);
    }

    expect(beatBoostOverlayAlpha(0), 'pulse 0 draws nothing').toBe(0);
    expect(applyBeatBoost(Uint8ClampedArray.from(src), 0)).toEqual(src);
  });

  it('states the domain: the two forms are identical only for pulse·amount ≤ 1', () => {
    // `boostBeatColor` clamps k PER PIXEL; the overlay clamps the SCALAR and
    // lets membership scale it. They part ways only when the scalar exceeds 1
    // — an `amount` the module never ships (DEFAULT_BOOST_AMOUNT = 0.6). The
    // parity claim above is made for the shipped amount; this leg records the
    // boundary so a future amount > 1 is a parity question, not a surprise.
    expect(DEFAULT_BOOST_AMOUNT).toBeLessThanOrEqual(1);
    const feathered: [number, number, number] = hsvToRgb(YELLOW_BAND.hueLo - YELLOW_BAND.feather / 2, 0.8, 0.8);
    const m = beatBoostMembership(...feathered);
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan(1);
    // amount 5, pulse 1: reference clamps k to 1 (white); the overlay reaches 1·m.
    const ref = boostBeatColor(...feathered, 1, 5);
    const a8 = beatBoostOverlayCoverage(m);
    const got = feathered.map((c) => sourceOverWhite(c, a8, beatBoostOverlayAlpha(1, 5)));
    expect(ref).toEqual([255, 255, 255]);
    expect(got[0]).toBeLessThan(255);
  });
});

describe('timelorde-wizard: gateLevelToWizardOn', () => {
  it('HIGH (>= GATE_HI) turns the owl ON', () => {
    expect(gateLevelToWizardOn(1)).toBe(true);
    expect(gateLevelToWizardOn(GATE_HI)).toBe(true); // boundary is ON
    expect(gateLevelToWizardOn(0.9)).toBe(true);
  });

  it('LOW (< GATE_HI) turns the owl OFF', () => {
    expect(gateLevelToWizardOn(0)).toBe(false);
    expect(gateLevelToWizardOn(GATE_HI - 0.001)).toBe(false);
    expect(gateLevelToWizardOn(-0.2)).toBe(false);
  });
});

describe('timelorde-wizard: wizardDisplayMode', () => {
  it('shows the LIVE VIDEO feed whenever video_in is patched — even if the owl is on', () => {
    expect(wizardDisplayMode({ hasVideoIn: true, wizardOn: true })).toBe('video');
    expect(wizardDisplayMode({ hasVideoIn: true, wizardOn: false })).toBe('video');
  });

  it('falls back to the OWL when nothing is patched + the owl is on', () => {
    expect(wizardDisplayMode({ hasVideoIn: false, wizardOn: true })).toBe('wizard');
  });

  it('shows the OFF placeholder when nothing is patched + the owl is off', () => {
    expect(wizardDisplayMode({ hasVideoIn: false, wizardOn: false })).toBe('off');
  });

  it('preserves the prior owl↔off behaviour exactly when no video is patched', () => {
    // With no video cable, the mode is governed solely by wizardOn — the
    // pre-video-jack behaviour, unchanged.
    for (const wizardOn of [true, false]) {
      const mode = wizardDisplayMode({ hasVideoIn: false, wizardOn });
      expect(mode).toBe(wizardOn ? 'wizard' : 'off');
      expect(mode).not.toBe('video');
    }
  });
});
