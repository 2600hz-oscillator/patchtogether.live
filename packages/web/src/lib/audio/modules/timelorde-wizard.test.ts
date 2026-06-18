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
  boostBeatColor,
  applyBeatBoost,
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
