// packages/web/src/lib/video/modules/fader.test.ts
//
// PCU for FADER's pure transition core (no GL) + the module def contract. The GL
// plumbing (fader.ts factory: 2-pass mix→out, SEND via read('outputTexture:send'))
// is exercised on the real GPU by the per-module-per-port sweep + fader.spec.ts.

import { describe, it, expect } from 'vitest';
import {
  TRANSITION_NAMES,
  TRANSITION_COUNT,
  coerceMode,
  mixRGB,
  hash21,
  transitionFactor,
  transitionAt,
  type TransitionMode,
  type RGB,
} from './fader-transitions';
import { faderDef } from './fader';

const MODES: TransitionMode[] = [0, 1, 2, 3, 4];

describe('fader — transition names + mode coercion', () => {
  it('exposes 5 named transitions in index order', () => {
    expect(TRANSITION_NAMES).toEqual(['fade', 'wipe', 'dissolve', 'star', 'checkerboard']);
    expect(TRANSITION_COUNT).toBe(5);
  });
  it('coerceMode clamps junk / out-of-range to a valid mode', () => {
    expect(coerceMode(0)).toBe(0);
    expect(coerceMode(4)).toBe(4);
    expect(coerceMode(2.4)).toBe(2);
    expect(coerceMode(-3)).toBe(0);
    expect(coerceMode(99)).toBe(4);
    expect(coerceMode(NaN)).toBe(0);
    expect(coerceMode('2' as unknown)).toBe(2);
  });
});

describe('fader — transitionFactor endpoints (every mode)', () => {
  it('t≤0 → 0 (full A) and t≥1 → 1 (full B) for ALL modes, anywhere on the frame', () => {
    for (const m of MODES) {
      for (const [ux, uy] of [[0, 0], [0.5, 0.5], [0.27, 0.83], [1, 1]] as const) {
        expect(transitionFactor(0, m, ux, uy), `mode ${m} t=0`).toBe(0);
        expect(transitionFactor(-0.5, m, ux, uy), `mode ${m} t<0`).toBe(0);
        expect(transitionFactor(1, m, ux, uy), `mode ${m} t=1`).toBe(1);
        expect(transitionFactor(2, m, ux, uy), `mode ${m} t>1`).toBe(1);
      }
    }
  });
});

describe('fader — per-shape behaviour', () => {
  it('FADE is uniform (factor == t everywhere)', () => {
    expect(transitionFactor(0.5, 0, 0.1, 0.9)).toBeCloseTo(0.5, 5);
    expect(transitionFactor(0.25, 0, 0.8, 0.2)).toBeCloseTo(0.25, 5);
  });

  it('WIPE reveals B left→right: left column flips before the right at the same t', () => {
    // at t=0.5: left (x=0.2) is past the edge → B (1); right (x=0.8) → A (0).
    expect(transitionFactor(0.5, 1, 0.2, 0.5)).toBe(1);
    expect(transitionFactor(0.5, 1, 0.8, 0.5)).toBe(0);
  });

  it('DISSOLVE is monotonic in t per cell (more B as t grows) + deterministic', () => {
    // hash21 is deterministic, so the same cell gives the same threshold.
    const n = hash21(Math.floor(0.42 * 120), Math.floor(0.42 * 120));
    expect(transitionFactor(Math.min(1, n + 0.02), 2, 0.42, 0.42)).toBe(1);
    expect(transitionFactor(Math.max(0, n - 0.02), 2, 0.42, 0.42)).toBe(0);
    expect(hash21(3, 7)).toBe(hash21(3, 7)); // stable
  });

  it('STAR fills from the centre outward (centre flips before a corner at small t)', () => {
    // At a small t the centre is already inside the iris (B) while a corner is
    // still outside it (A) — i.e. the star grows from the middle.
    expect(transitionFactor(0.05, 3, 0.5, 0.5)).toBe(1); // centre fills immediately
    expect(transitionFactor(0.05, 3, 0.0, 0.0)).toBe(0); // a corner is still A
    // and by t=1 even the corner is B (endpoint, covered above too)
    expect(transitionFactor(1, 3, 0.0, 0.0)).toBe(1);
  });

  it('CHECKERBOARD staggers neighbouring cells (even cells lead, odd lag)', () => {
    // at t=0.25: even cell phase = 0.5; odd cell phase = -0.5 → 0. Adjacent cells differ.
    const evenCell = transitionFactor(0.25, 4, 0.05, 0.05); // cx=0,cy=0 → even
    const oddCell = transitionFactor(0.25, 4, 0.20, 0.05);  // cx=1,cy=0 → odd
    expect(evenCell).toBeGreaterThan(oddCell);
    expect(oddCell).toBe(0);
  });
});

describe('fader — transitionAt blends colours', () => {
  const A: RGB = [255, 0, 0];
  const B: RGB = [0, 0, 255];
  it('FADE midpoint is the colour average', () => {
    expect(transitionAt(A, B, 0.5, 0, 0.5, 0.5)).toEqual(mixRGB(A, B, 0.5));
  });
  it('endpoints return the exact source colour', () => {
    expect(transitionAt(A, B, 0, 2, 0.3, 0.7)).toEqual(A);
    expect(transitionAt(A, B, 1, 3, 0.3, 0.7)).toEqual(B);
  });
});

describe('fader — module def contract', () => {
  it('is a lowercase-labelled video mixer: 3 video inputs (A/B/return) + 2 video outputs (out/send)', () => {
    expect(faderDef.type).toBe('fader');
    expect(faderDef.label).toBe('fader');
    expect(faderDef.label).toBe(faderDef.label.toLowerCase());
    expect(faderDef.domain).toBe('video');
    expect(faderDef.inputs).toEqual([
      { id: 'in_a', type: 'video' },
      { id: 'in_b', type: 'video' },
      { id: 'return', type: 'video' },
    ]);
    expect(faderDef.outputs).toEqual([
      { id: 'out', type: 'video' },
      { id: 'send', type: 'video' },
    ]);
  });
  it('declares the two faders + two transition params', () => {
    const ids = (faderDef.params ?? []).map((pp) => pp.id);
    expect(ids).toEqual(['fader', 'abTransition', 'dryWet', 'dwTransition']);
    for (const pp of faderDef.params ?? []) {
      expect(pp.label).toBeTruthy();
      expect(typeof pp.defaultValue).toBe('number');
    }
  });
});
