// packages/web/src/lib/ui/modules/sixstrum-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind SIX STRUM's derived readouts — the
// whole difference between this model and seven relabelled knobs.
//
// Each derived value is perturbed on the input a KNOB READBACK would be blind
// to, AND pinned in the other direction on an input it must NOT follow. Both
// legs ship permanently: a one-sided control passes on a readout that tracks
// everything.
//
// ⚠ Every leg is KNOB-DRIVEN. `ModuleShell.readoutValue` hands the registry a
// DURABLE-param reader (an engine reader polled from markup is not reactive),
// so a CV-port leg is unavailable BY DESIGN, not by oversight.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { faceReadoutValueFor, faceReadoutValueIds } from '$lib/ui/workflow/face-readout-values';
import {
  SS_DETUNE_MAX_CENTS,
  SS_DETUNE_PATTERN,
  SS_REF_MIDI,
  SS_TUNE_HZ,
  sixstrumBurstMs,
  sixstrumDampPartial,
  sixstrumFaceParams,
  sixstrumNoteName,
  sixstrumPickNotchPartial,
  sixstrumRingT60S,
  sixstrumRollMs,
  sixstrumStringHz,
  type SixstrumFaceParams,
} from './sixstrum-face-model';

/** The def defaults, resolved through the real fallback path. */
const DEFAULTS: SixstrumFaceParams = sixstrumFaceParams(() => undefined);

function withParams(over: Partial<SixstrumFaceParams>): (id: string) => number | undefined {
  const p = { ...DEFAULTS, ...over };
  return (id) => (p as unknown as Record<string, number>)[id];
}

/** Run a registered readout id over a param overlay — the EXACT path the
 *  faceplate uses, so a registry typo fails here rather than printing `—`. */
function readout(id: string, over: Partial<SixstrumFaceParams> = {}): string {
  const fn = faceReadoutValueFor(id);
  expect(fn, `${id} is not registered in face-readout-values.ts`).not.toBeNull();
  return fn!(withParams(over));
}

describe('sixstrum face model — the DSP-source pin', () => {
  // The four constants the model RE-TYPES because they are module-private in
  // the DSP and `export`-ing them would churn two ART `.sha` pins for zero
  // audio change. This is the only thing standing between the copies and drift.
  it('the re-typed private constants still match sixstrum-dsp.ts', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../../dsp/src/lib/sixstrum-dsp.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(new RegExp(`const SS_TUNE_HZ\\s*=\\s*${SS_TUNE_HZ}\\b`));
    expect(src).toMatch(new RegExp(`const SS_REF_MIDI\\s*=\\s*${SS_REF_MIDI}\\b`));
    expect(src).toMatch(new RegExp(`const SS_DETUNE_MAX_CENTS\\s*=\\s*${SS_DETUNE_MAX_CENTS}\\b`));
    const pat = src.match(/const SS_DETUNE_PATTERN\s*=\s*\[([^\]]+)\]/);
    expect(pat, 'SS_DETUNE_PATTERN not found in sixstrum-dsp.ts').not.toBeNull();
    const nums = pat![1]!.split(',').map((s) => Number(s.trim()));
    expect(nums, 'the detune pattern must parse to six weights').toHaveLength(6);
    expect(nums).toEqual([...SS_DETUNE_PATTERN]);
  });
});

describe('sixstrum face model — the numbers at the shipped defaults', () => {
  it('the six open strings are E2 A2 D3 G3 B3 E4', () => {
    const hz = sixstrumStringHz(DEFAULTS);
    expect(hz.map((v) => Number(v.toFixed(2)))).toEqual([
      82.24, 109.87, 146.76, 196.1, 247.24, 330.29,
    ]);
    expect(hz.map(sixstrumNoteName).join(' ')).toBe('E2 A2 D3 G3 B3 E4');
  });

  it('the shipped defaults print the face’s own figures', () => {
    expect(readout('sixstrum-ring-t60')).toBe('2.50 s');
    expect(readout('sixstrum-damp-partial')).toBe('partial 11.5');
    expect(readout('sixstrum-roll-ms')).toBe('12.6 ms · 2.5 ms/string');
    expect(readout('sixstrum-open-strings')).toBe('E2 A2 D3 G3 B3 E4');
    expect(readout('sixstrum-low-string-hz')).toBe('82 Hz');
    expect(readout('sixstrum-pick-notch')).toBe('partial 5.9');
    expect(readout('sixstrum-burst-ms')).toBe('12.2 ms');
  });

  it('every registered sixstrum readout is TOTAL — a fresh node, NaN, ±Infinity', () => {
    const ids = faceReadoutValueIds().filter((k) => k.startsWith('sixstrum-'));
    expect(ids.length, 'the sixstrum readouts must be registered').toBe(7);
    for (const id of ids) {
      const fn = faceReadoutValueFor(id)!;
      // A freshly spawned node: nothing touched, so the reader answers nothing.
      expect(fn(() => undefined), `${id} on a fresh node`).not.toBe('');
      for (const bad of [Number.NaN, Infinity, -Infinity, -999, 1e9]) {
        expect(typeof fn(() => bad), `${id} at ${bad}`).toBe('string');
        expect(fn(() => bad), `${id} at ${bad}`).not.toBe('');
      }
    }
  });
});

describe('sixstrum face model — NEGATIVE CONTROLS (both directions)', () => {
  // ── `rings for` — the face's central claim ────────────────────────────────
  it('RING’s t60 collapses when MATERIAL caps the loop gain — a RING readback cannot', () => {
    // Uncapped: the derivation AGREES with the dial. Asserting this too is what
    // stops the test only proving that the two DISAGREE.
    expect(sixstrumRingT60S({ ...DEFAULTS, ring: 10 })).toBeCloseTo(10, 3);
    // Capped: the same dial, a different answer.
    expect(sixstrumRingT60S({ ...DEFAULTS, ring: 10, material: 0 })).toBeCloseTo(0.7749, 3);
    expect(readout('sixstrum-ring-t60', { ring: 10, material: 0 })).toBe('775 ms');
  });

  it('at MATERIAL 0 the printed ring is FROZEN across the whole RING sweep', () => {
    // The OTHER direction: a derivation that still tracked the knob here would
    // be wrong in a way the first leg cannot see.
    const seen = new Set(
      [1, 2, 5, 10].map((ring) => readout('sixstrum-ring-t60', { ring, material: 0 })),
    );
    expect([...seen], 'the loop-gain cap, not RING, owns this corner').toEqual(['775 ms']);
  });

  it('the cap is PITCH-dependent — the high string chokes harder still', () => {
    // string 6 (E4) at the same knobs: 0.1945 s, not 0.7749.
    const hi = sixstrumRingT60S({ ...DEFAULTS, ring: 10, material: 0, register: 24 });
    expect(hi).toBeLessThan(0.5);
  });

  // ── `damps above` — a partial index, and REGISTER must not move it ────────
  it('MATERIAL moves the damping partial; REGISTER does not', () => {
    expect(sixstrumDampPartial({ ...DEFAULTS, material: 0 })).toBeCloseTo(1.414, 3);
    expect(sixstrumDampPartial({ ...DEFAULTS, material: 0.55 })).toBeCloseTo(11.511, 3);
    expect(sixstrumDampPartial({ ...DEFAULTS, material: 1 })).toBeCloseTo(64, 6);
    // The whole reason it is published as an INDEX rather than Hz.
    expect(readout('sixstrum-damp-partial', { register: 24 })).toBe(
      readout('sixstrum-damp-partial'),
    );
  });

  // ── `roll` — STRUM moves it, DIR only permutes the order ─────────────────
  it('STRUM SPREAD moves the roll; the window scales linearly', () => {
    expect(sixstrumRollMs({ ...DEFAULTS, strumSpread: 0 })).toEqual({
      windowMs: 0,
      perStringMs: 0,
    });
    expect(readout('sixstrum-roll-ms', { strumSpread: 0 })).toBe('block chord');
    expect(sixstrumRollMs({ ...DEFAULTS, strumSpread: 1 }).windowMs).toBeCloseTo(45, 6);
  });

  // ── `open strings` / `low string` — SPREAD is invisible to a knob readback ─
  it('SPREAD detunes the outer strings while TUNING and REGISTER sit still', () => {
    expect(sixstrumStringHz({ ...DEFAULTS, spread: 0.25 })[0]).toBeCloseTo(82.24, 2);
    expect(sixstrumStringHz({ ...DEFAULTS, spread: 1 })[0]).toBeCloseTo(81.743, 3);
  });

  // ── `burst` — measured in PERIODS, so the ms halves every octave up ───────
  it('REGISTER halves the burst ms while PICK GRAIN still reads 1.00', () => {
    expect(sixstrumBurstMs(DEFAULTS)).toBeCloseTo(12.16, 2);
    expect(sixstrumBurstMs({ ...DEFAULTS, register: 12 })).toBeCloseTo(6.08, 2);
    expect(readout('sixstrum-burst-ms', { register: 12 })).toBe('6.1 ms');
  });

  // ── `pick notch` — POS moves it, REGISTER must not ───────────────────────
  it('PICK POS moves the comb notch; REGISTER does not', () => {
    expect(sixstrumPickNotchPartial({ ...DEFAULTS, pickPos: 0.5 })).toBeCloseTo(2, 6);
    expect(readout('sixstrum-pick-notch', { register: -24 })).toBe(
      readout('sixstrum-pick-notch'),
    );
  });
});

describe('sixstrum face model — the shipped BASS recall is CLAMPED (a DEFECT pin)', () => {
  // ⚠ NOT AN APPROVAL. The BASS preset (tuning 1, register −12, spread 0.15)
  // puts strings 1-3 under KARPLUS_F0_MIN = 30 Hz, so `karplusF0`'s clamp
  // collapses three of six onto ONE pitch: the shipped bass voice is a
  // three-note unison plus three notes. Pinned so it is VISIBLE; this test goes
  // red the day the preset is fixed, which is the intent.
  it('BASS collapses strings 1-3 onto the 30 Hz floor', () => {
    const bass: SixstrumFaceParams = {
      ...DEFAULTS,
      tuning: 1,
      register: -12,
      spread: 0.15,
    };
    const hz = sixstrumStringHz(bass);
    expect(hz.slice(0, 3)).toEqual([30, 30, 30]);
    expect(hz.slice(3).map((v) => Number(v.toFixed(2)))).toEqual([36.72, 49.04, 65.49]);
  });
});
