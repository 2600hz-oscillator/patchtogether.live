// packages/web/src/lib/audio/modules/timelorde-wizard.test.ts
//
// Unit tests for the pure TIMELORDE wizard helpers: the bitmap → dots
// projection, the beat-pulse math, and the gate → on/off interpretation.

import { describe, it, expect } from 'vitest';
import {
  WIZARD_BITMAP,
  bitmapSize,
  bitmapToDots,
  beatPulse,
  gateLevelToWizardOn,
} from './timelorde-wizard';
import { GATE_HI } from '$lib/audio/gate-trigger';

describe('timelorde-wizard: bitmap → dots', () => {
  it('reports the grid size from the bitmap', () => {
    const { cols, rows } = bitmapSize();
    expect(rows).toBe(WIZARD_BITMAP.length);
    expect(cols).toBeGreaterThan(0);
    // Every authored row is the same width as the reported cols (square-ish).
    for (const line of WIZARD_BITMAP) expect(line.length).toBeLessThanOrEqual(cols);
  });

  it('drops OFF cells and keeps only lit dots', () => {
    const dots = bitmapToDots(['.#.', '...', '.*.']);
    expect(dots).toHaveLength(2);
    expect(dots[0]).toEqual({ col: 1, row: 0, role: 'hat' });
    expect(dots[1]).toEqual({ col: 1, row: 2, role: 'skin' });
  });

  it('maps each legend character to its palette role', () => {
    const dots = bitmapToDots(['#*@x']); // x = unknown → body
    expect(dots.map((d) => d.role)).toEqual(['hat', 'skin', 'staff', 'body']);
  });

  it('treats space the same as . (OFF)', () => {
    const dots = bitmapToDots([' # ']);
    expect(dots).toHaveLength(1);
    expect(dots[0]!.col).toBe(1);
  });

  it('the placeholder wizard has a recognisable amount of art (not empty/full)', () => {
    const dots = bitmapToDots();
    const { cols, rows } = bitmapSize();
    const total = cols * rows;
    // Some dots, but far from a solid block — it's a figure, not a square.
    expect(dots.length).toBeGreaterThan(20);
    expect(dots.length).toBeLessThan(total * 0.8);
    // The staff orb (@ dots) exists — the "magic" accent is present.
    expect(dots.some((d) => d.role === 'staff')).toBe(true);
    // A face (skin) exists.
    expect(dots.some((d) => d.role === 'skin')).toBe(true);
  });

  it('round-trips a custom (owner-swapped) bitmap unchanged', () => {
    // The owner replaces WIZARD_BITMAP; bitmapToDots must flow it through.
    const custom = ['@@', '..'];
    const dots = bitmapToDots(custom);
    expect(dots).toEqual([
      { col: 0, row: 0, role: 'staff' },
      { col: 1, row: 0, role: 'staff' },
    ]);
  });
});

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

describe('timelorde-wizard: gateLevelToWizardOn', () => {
  it('HIGH (>= GATE_HI) turns the wizard ON', () => {
    expect(gateLevelToWizardOn(1)).toBe(true);
    expect(gateLevelToWizardOn(GATE_HI)).toBe(true); // boundary is ON
    expect(gateLevelToWizardOn(0.9)).toBe(true);
  });

  it('LOW (< GATE_HI) turns the wizard OFF', () => {
    expect(gateLevelToWizardOn(0)).toBe(false);
    expect(gateLevelToWizardOn(GATE_HI - 0.001)).toBe(false);
    expect(gateLevelToWizardOn(-0.2)).toBe(false);
  });
});
