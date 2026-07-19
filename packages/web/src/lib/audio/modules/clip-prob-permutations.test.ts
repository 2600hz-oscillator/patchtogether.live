// packages/web/src/lib/audio/modules/clip-prob-permutations.test.ts
//
// The HEART of the clip-default probability coverage (owner-requested EXTENSIVE
// permutation table). Iterates every combination of a note's own `prob` × the
// clip's `defaultProb` and, for EACH cell, pins the full contract:
//
//   note.prob     ∈ { unset, 0, 0.25, 0.5, 0.975, 1 }
//   clip.defaultProb ∈ { unset, 0, 0.5, 1 }
//
//   → noteEffProb        (note.prob ?? clip.defaultProb ?? 1)
//   → probSource         ('note' | 'clip' | 'none')
//   → launchpad LED bucket + brightness  (noteProbRgb → white / purple / orange)
//   → card cell bucket   + brightness     (noteProbCellFill → white / purple / orange)
//   → playback firing under a SEEDED mulberry32 (notesFiringAt):
//        p ≥ 1 ALWAYS fires · p = 0 NEVER fires · mid-p lands in a statistical
//        band · a per-note override BEATS the clip default.
//
// Precedence + colour source are the two things that could silently regress, so
// this table asserts them together for every cell — the launchpad, the card, and
// the dice-roll all read the SAME `noteEffProb` / `probSource` truth.

import { describe, it, expect } from 'vitest';
import { mulberry32 } from '$lib/sync/prng';
import {
  defaultNoteClip,
  noteEffProb,
  probSource,
  probColorBucket,
  notesFiringAt,
  type NoteClipRecord,
  type NoteEvent,
  type ProbSource,
  type ProbColorBucket,
} from './clip-types';
import { noteProbRgb, type Rgb } from '$lib/control/launchpad/launchpad-map';
import { noteProbCellFill } from '$lib/ui/modules/clipplayer-prob-color';

// ── The two permutation axes ──────────────────────────────────────────────
const NOTE_PROBS: (number | undefined)[] = [undefined, 0, 0.25, 0.5, 0.975, 1];
const CLIP_DEFAULTS: (number | undefined)[] = [undefined, 0, 0.5, 1];

/** Build a one-note clip with the given per-note prob + clip default (both keys
 *  OMITTED when undefined — the byte-identical legacy shape). Note at step 0,
 *  midi 60. */
function cell(noteProb: number | undefined, clipDefault: number | undefined): NoteClipRecord {
  const ev: NoteEvent = { step: 0, midi: 60, velocity: 100, lengthSteps: 1 };
  if (noteProb !== undefined) ev.prob = noteProb;
  const clip: NoteClipRecord = { ...defaultNoteClip(), steps: [ev] };
  if (clipDefault !== undefined) clip.defaultProb = clipDefault;
  return clip;
}
function noteOf(clip: NoteClipRecord): NoteEvent {
  return clip.steps[0]!;
}

// ── Expected-value oracle (independent of the implementation) ──────────────
function expectedEff(noteProb: number | undefined, clipDefault: number | undefined): number {
  if (noteProb !== undefined) return noteProb; // own prob wins (incl. 0)
  if (clipDefault !== undefined) return clipDefault; // else clip default
  return 1; // else always fires
}
function expectedSource(noteProb: number | undefined, clipDefault: number | undefined): ProbSource {
  if (noteProb !== undefined) return 'note';
  if (clipDefault !== undefined) return 'clip';
  return 'none';
}
function expectedBucket(noteProb: number | undefined, clipDefault: number | undefined): ProbColorBucket {
  if (expectedEff(noteProb, clipDefault) >= 1) return 'white';
  return expectedSource(noteProb, clipDefault) === 'note' ? 'purple' : 'orange';
}

// ── Bucket classifiers for the two surfaces (from the emitted colour) ──────
/** Classify a launchpad LED triple into white / purple / orange by its dominant
 *  channel: white = r==g==b; purple = blue is max (RGB_PROB_PURPLE ramp);
 *  orange = red is max (RGB_PROB_ORANGE ramp, blue floored to 0). */
function ledBucket(rgb: Rgb): ProbColorBucket {
  const [r, g, b] = rgb;
  if (r === g && g === b) return 'white';
  if (b > r && b > g) return 'purple';
  if (r > g && r > b) return 'orange';
  throw new Error(`unclassifiable LED ${JSON.stringify(rgb)}`);
}
/** Perceptual luma of an LED triple (for the brightness-monotonicity checks). */
function luma(rgb: Rgb): number {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}
/** Classify a card `hsl(...)` fill by hue: hue 0 (0% sat) = white, 30 = orange,
 *  280 = purple. Returns its lightness too for the monotonicity checks. */
function cardBucket(fill: string): { bucket: ProbColorBucket; lightness: number } {
  const m = /^hsl\((\d+)\s+(\d+)%\s+(\d+)%\)$/.exec(fill);
  if (!m) throw new Error(`unparseable card fill "${fill}"`);
  const hue = Number(m[1]);
  const lightness = Number(m[3]);
  if (hue === 0) return { bucket: 'white', lightness };
  if (hue === 30) return { bucket: 'orange', lightness };
  if (hue === 280) return { bucket: 'purple', lightness };
  throw new Error(`unexpected card hue ${hue} in "${fill}"`);
}

// ===========================================================================
// THE TABLE — one describe per cell, asserting eff/source/buckets together.
// ===========================================================================
describe('clip-default probability — the full note.prob × clip.defaultProb table', () => {
  for (const noteProb of NOTE_PROBS) {
    for (const clipDefault of CLIP_DEFAULTS) {
      const label = `note=${noteProb ?? 'unset'} × clip=${clipDefault ?? 'unset'}`;
      const clip = cell(noteProb, clipDefault);
      const ev = noteOf(clip);
      const eff = expectedEff(noteProb, clipDefault);
      const src = expectedSource(noteProb, clipDefault);
      const bucket = expectedBucket(noteProb, clipDefault);

      it(`${label} → eff ${eff}, source ${src}, bucket ${bucket}`, () => {
        // 1) EFFECTIVE probability (precedence: note ?? clip ?? 1).
        expect(noteEffProb(clip, ev)).toBeCloseTo(eff, 10);
        // 2) SOURCE.
        expect(probSource(clip, ev)).toBe(src);
        // 3) shared colour BUCKET (the card reads exactly this).
        expect(probColorBucket(clip, ev)).toBe(bucket);
        // 4) launchpad LED bucket agrees with the shared decision.
        expect(ledBucket(noteProbRgb(clip, ev))).toBe(bucket);
        // 5) card cell bucket agrees too (empty never happens — the cell holds a note).
        expect(cardBucket(noteProbCellFill(clip, 0, 60)).bucket).toBe(bucket);
      });
    }
  }
});

// ===========================================================================
// COLOUR — a per-note override BEATS the clip default (purple vs orange), and
// the WHITE fallout (effective 100%, either source).
// ===========================================================================
describe('colour source: override → purple, default → orange, 100% → white', () => {
  it('same effective prob, DIFFERENT source → different hue (override beats default)', () => {
    // A note that OWNS prob 0.5 under a clip default of 0.5 → purple (source note).
    const overridden = cell(0.5, 0.5);
    // A note with NO own prob under a clip default of 0.5 → orange (source clip).
    const defaulted = cell(undefined, 0.5);
    expect(noteEffProb(overridden, noteOf(overridden))).toBeCloseTo(0.5, 10);
    expect(noteEffProb(defaulted, noteOf(defaulted))).toBeCloseTo(0.5, 10);
    expect(ledBucket(noteProbRgb(overridden, noteOf(overridden)))).toBe('purple');
    expect(ledBucket(noteProbRgb(defaulted, noteOf(defaulted)))).toBe('orange');
    expect(cardBucket(noteProbCellFill(overridden, 0, 60)).bucket).toBe('purple');
    expect(cardBucket(noteProbCellFill(defaulted, 0, 60)).bucket).toBe('orange');
  });
  it('a per-note override at 100% is WHITE even under a low clip default', () => {
    const c = cell(1, 0.1); // own prob 1 wins → effective 1 → white
    expect(noteEffProb(c, noteOf(c))).toBe(1);
    expect(ledBucket(noteProbRgb(c, noteOf(c)))).toBe('white');
    expect(cardBucket(noteProbCellFill(c, 0, 60)).bucket).toBe('white');
  });
  it('a clip default of 100% is WHITE for un-overridden notes (key would be deleted anyway)', () => {
    const c = cell(undefined, 1);
    expect(noteEffProb(c, noteOf(c))).toBe(1);
    expect(ledBucket(noteProbRgb(c, noteOf(c)))).toBe('white');
    expect(cardBucket(noteProbCellFill(c, 0, 60)).bucket).toBe('white');
  });
});

// ===========================================================================
// BRIGHTNESS MONOTONICITY — within EACH ramp (purple = override, orange =
// default), a higher probability is brighter, on BOTH surfaces.
// ===========================================================================
describe('brightness monotonicity within each source ramp', () => {
  const ramp = [0.025, 0.25, 0.5, 0.75, 0.975];
  it('LAUNCHPAD purple ramp (per-note override) brightens with probability', () => {
    let prev = -1;
    for (const p of ramp) {
      const c = cell(p, undefined);
      const rgb = noteProbRgb(c, noteOf(c));
      expect(ledBucket(rgb)).toBe('purple');
      expect(luma(rgb)).toBeGreaterThan(prev);
      prev = luma(rgb);
    }
  });
  it('LAUNCHPAD orange ramp (clip default) brightens with probability', () => {
    let prev = -1;
    for (const p of ramp) {
      const c = cell(undefined, p);
      const rgb = noteProbRgb(c, noteOf(c));
      expect(ledBucket(rgb)).toBe('orange');
      expect(luma(rgb)).toBeGreaterThan(prev);
      prev = luma(rgb);
    }
  });
  it('CARD purple ramp (per-note override) lightens with probability', () => {
    let prev = -1;
    for (const p of ramp) {
      const c = cell(p, undefined);
      const { bucket, lightness } = cardBucket(noteProbCellFill(c, 0, 60));
      expect(bucket).toBe('purple');
      expect(lightness).toBeGreaterThan(prev);
      prev = lightness;
    }
  });
  it('CARD orange ramp (clip default) lightens with probability', () => {
    let prev = -1;
    for (const p of ramp) {
      const c = cell(undefined, p);
      const { bucket, lightness } = cardBucket(noteProbCellFill(c, 0, 60));
      expect(bucket).toBe('orange');
      expect(lightness).toBeGreaterThan(prev);
      prev = lightness;
    }
  });
});

// ===========================================================================
// PLAYBACK — the dice-roll (notesFiringAt) honours the EFFECTIVE prob for every
// cell, seeded-deterministic. p≥1 always, p=0 never, mid-p in-band, override
// beats default.
// ===========================================================================
describe('playback firing under a seeded mulberry32 — the whole table', () => {
  const TRIALS = 400;
  /** Fraction of TRIALS where the single note fired, seeded so the count is
   *  reproducible run-to-run (no Math.random). */
  function fireRate(clip: NoteClipRecord, seed = 12345): number {
    const rng = mulberry32(seed);
    let hits = 0;
    for (let t = 0; t < TRIALS; t++) if (notesFiringAt(clip, 0, rng).length === 1) hits++;
    return hits / TRIALS;
  }

  for (const noteProb of NOTE_PROBS) {
    for (const clipDefault of CLIP_DEFAULTS) {
      const eff = expectedEff(noteProb, clipDefault);
      const label = `note=${noteProb ?? 'unset'} × clip=${clipDefault ?? 'unset'} (eff ${eff})`;
      it(`fires ≈ effective ${eff}: ${label}`, () => {
        const clip = cell(noteProb, clipDefault);
        const rate = fireRate(clip);
        if (eff >= 1) {
          expect(rate, 'p ≥ 1 ALWAYS fires').toBe(1);
        } else if (eff === 0) {
          expect(rate, 'p = 0 NEVER fires').toBe(0);
        } else {
          // Seeded over 400 trials — a generous ±0.1 band around the effective
          // probability (deterministic, so this never flakes).
          expect(rate).toBeGreaterThan(eff - 0.1);
          expect(rate).toBeLessThan(eff + 0.1);
        }
      });
    }
  }

  it('a per-note override BEATS the clip default at playback (0 note under 1 default = silent)', () => {
    const c = cell(0, 1); // own 0 wins over clip default 1 → never fires
    expect(fireRate(c)).toBe(0);
  });
  it('a per-note override BEATS the clip default at playback (1 note under 0 default = always)', () => {
    const c = cell(1, 0); // own 1 wins over clip default 0 → always fires
    expect(fireRate(c)).toBe(1);
  });
  it('an un-overridden note follows the CLIP default (0.5 default ≈ half)', () => {
    const c = cell(undefined, 0.5);
    const rate = fireRate(c);
    expect(rate).toBeGreaterThan(0.4);
    expect(rate).toBeLessThan(0.6);
  });
  it('a chord: overridden voice + defaulted voice roll independently on the SAME clip default', () => {
    // voice A owns prob 0 (never), voice B takes the clip default 1 (always).
    const clip: NoteClipRecord = {
      ...defaultNoteClip(),
      defaultProb: 1,
      steps: [
        { step: 0, midi: 60, prob: 0 }, // override → never
        { step: 0, midi: 64 }, // takes clip default 1 → always
      ],
    };
    const rng = mulberry32(999);
    let firedA = 0;
    let firedB = 0;
    for (let t = 0; t < 200; t++) {
      const fired = notesFiringAt(clip, 0, rng);
      if (fired.some((e) => e.midi === 60)) firedA++;
      if (fired.some((e) => e.midi === 64)) firedB++;
    }
    expect(firedA, 'overridden 0% voice never fires').toBe(0);
    expect(firedB, 'defaulted 100% voice always fires').toBe(200);
  });
});
