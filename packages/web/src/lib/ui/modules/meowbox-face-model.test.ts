// packages/web/src/lib/ui/modules/meowbox-face-model.test.ts
//
// (a) THE SOURCE-GREP PIN. All THIRTEEN anchor tables are RE-TYPED in the model
//     because meowbox's DSP is FAUST and cannot be imported — and unlike
//     kickdrum or ringback there is no TS core either. meowbox ALSO has no
//     `.f32` ART baseline (it is on ART_BACKLOG; its three scenarios are a stub
//     render, an OscillatorNode stand-in and an octave-RATIO check), so NO
//     downstream audio pin would notice a table drift. This grep is the only
//     guard, which is why it also asserts FIVE values parsed per table: a regex
//     that silently matched nothing would compare [] to [] and pass green.
//
// (b) THE STRUCTURAL PINS. Four lines of the .dsp carry the whole face — the
//     0.4 SUSTAIN (which makes this a gate consumer and the audition a held
//     pad), the `en.are` rise (which makes the note settle sharp), the
//     `resonbp` gain of 1.0 (which makes the peak a·Q) and the `·0.6` spread
//     cap (which puts the comb null at 833 Hz). Each is asserted verbatim.
//
// (c) THE ANCHOR-ROSTER PIN. The face's five `note` strings are DERIVED DATA,
//     verified against the tables rather than being captions that can go stale.
//
// (d) THE PERMANENT NEGATIVE CONTROLS — one per readout, in BOTH directions.
//     The three that matter most each defend against a WRONG implementation
//     that reads exactly right at the shipped defaults:
//       `settles`   — a PITCH readback says `0 st` while the voice holds 290 Hz
//       `tail`      — a DECAY readback says `400 ms` at EVERY morph, and is
//                     correct at the default because decayScaleOf(0.25) is 1
//       `peak gain` — an AMPLITUDE-table readback is FLAT across morph
//                     0.5 → 0.75 while the real peak moves +7.36 dB
//     …plus `mono-sum null`, whose control runs the other way: nothing on the
//     panel may move it, so the moving leg perturbs the ENVELOPE instead.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { meowboxDef } from '$lib/audio/modules/meowbox';
import {
  A1_AT,
  A2_AT,
  A3_AT,
  DECAY_SCALE_AT,
  F1_AT,
  F2_AT,
  F3_AT,
  FALL_AT,
  MEOWBOX_ANCHORS,
  MEOWBOX_SUSTAIN,
  Q1_AT,
  Q2_AT,
  Q3_AT,
  RISE_AT,
  VOICED_AT,
  a1Of,
  lerpAt,
  meowboxAnchorMorph,
  meowboxAnchorNote,
  meowboxCombNullHz,
  meowboxFormantHz,
  meowboxOnsetHz,
  meowboxParams,
  meowboxPeakGain,
  meowboxSettledHz,
  meowboxSettledSemitones,
  meowboxTailS,
  meowboxTremoloDepth,
  morphSeg,
  q1Of,
  type MeowboxParams,
} from './meowbox-face-model';

const DEFAULTS: MeowboxParams = meowboxParams(() => undefined);

function withParams(over: Partial<MeowboxParams>): (id: string) => number | undefined {
  const p = { ...DEFAULTS, ...over };
  return (id) => (p as unknown as Record<string, number>)[id];
}

/** ⚠ DRIVES THE REGISTRY, NOT THE MODEL FUNCTION. That is what makes the
 *  registration itself falsifiable: a readout dropped from
 *  face-readout-values.ts fails here, not just a maths change. */

const DSP = (): string =>
  readFileSync(fileURLToPath(new URL('../../../../../dsp/src/meowbox.dsp', import.meta.url)), 'utf8');

describe('meowbox face model — the .dsp SOURCE PIN', () => {
  it('all THIRTEEN anchor tables still match the .dsp, five values each', () => {
    const src = DSP();
    const tables: [string, readonly number[]][] = [
      ['f1At', F1_AT], ['f2At', F2_AT], ['f3At', F3_AT],
      ['q1At', Q1_AT], ['q2At', Q2_AT], ['q3At', Q3_AT],
      ['a1At', A1_AT], ['a2At', A2_AT], ['a3At', A3_AT],
      ['voicedAt', VOICED_AT],
      ['riseAmtAt', RISE_AT],
      ['fallAmtAt', FALL_AT],
      ['decayScaleAt', DECAY_SCALE_AT],
    ];
    expect(tables, 'the model must mirror all thirteen tables').toHaveLength(13);
    for (const [name, mirror] of tables) {
      const m = new RegExp(`${name}\\(i\\)\\s*=\\s*ba\\.selectn\\(5,\\s*i,([^)]*)\\)`).exec(src);
      expect(m, `${name} not found in meowbox.dsp`).not.toBeNull();
      const nums = m![1]!
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map(Number);
      // ⚠ THE COUNT ASSERTION IS THE POINT. A regex that matched an empty body
      // would compare [] to [] and pass.
      expect(nums, `${name} must parse to five values`).toHaveLength(5);
      expect(nums.every(Number.isFinite), `${name} parsed a non-number`).toBe(true);
      expect(nums, `${name} drifted from the model's re-typed copy`).toEqual([...mirror]);
    }
  });

  it('the amp envelope still SUSTAINS at 0.4 — the fact the audition shape rests on', () => {
    // If this ever becomes a 0 sustain, meowbox is a trigger consumer, the port's
    // `edge: 'gate'` is wrong, and the MEOW pad should be a one-shot. All three
    // move together or none of them do.
    expect(DSP()).toContain('ampEnv(g, m) = en.adsr(0.005, 0.05, 0.4, decayKnob * decayScaleOf(m), g);');
    expect(MEOWBOX_SUSTAIN).toBe(0.4);
    expect(meowboxDef.inputs.find((p) => p.id === 'gate')?.edge).toBe('gate');
  });

  it('the pitch contour still uses `en.are`, which SUSTAINS at 1.0', () => {
    // `en.are` holds at 1 while the gate is high, so the rise offset never
    // decays away and the note ends sharp. An `en.ar` here would make
    // `meowbox-settled-hz` wrong by 1.8 semitones at the defaults.
    expect(DSP()).toContain('en.are(0.03, 0.08, g) * riseAmtOf(m) * 12.0');
  });

  it('every resonbp still has gain 1.0, so the peak IS a·Q', () => {
    const src = DSP();
    for (const n of [1, 2, 3]) {
      expect(src, `formant ${n} changed shape`).toContain(
        `fi.resonbp(f${n}Of(m), q${n}Of(m), 1.0, x) * a${n}Of(m)`,
      );
    }
  });

  it('the tremolo still scales INVERSELY to voiced, contradicting its own comment', () => {
    const src = DSP();
    expect(src).toContain(
      'tremolo(m) = 1.0 - 0.4 * (1.0 - voicedOf(m)) + 0.4 * (1.0 - voicedOf(m)) * os.osc(15.0);',
    );
    // The comment claims the strength "scales with voicedOf(m)". Pinned as a
    // DEFECT, not approved — this goes red the day the source is made true.
    expect(src, 'meowbox.dsp:92-95 was corrected — re-read meowbox-tremolo')
      .toContain('Strength scales with');
  });
});

describe('meowbox face model — INERT, measured rather than argued', () => {
  it('the max(0.5, …) Q clamp can NEVER bind — dead code, swept not sampled', () => {
    let binds = 0;
    for (let i = 0; i <= 10_000; i++) {
      const m = i / 10_000;
      if (lerpAt(Q1_AT, m) < 0.5 || lerpAt(Q2_AT, m) < 0.5 || lerpAt(Q3_AT, m) < 0.5) binds++;
    }
    expect(binds, 'the .dsp clamp at :54-56 binds somewhere — it is no longer dead code').toBe(0);
    // …and the clamp is still IN the mirror, so the mirror is the source rather
    // than a tidied version of it.
    expect(q1Of(1)).toBe(0.5);
  });
});

describe('meowbox face model — the shipped defaults', () => {
  it('resolves the def defaults for an untouched node', () => {
    expect(DEFAULTS).toEqual({ pitch: 0, morph: 0.25, decay: 0.4, level: 1 });
    // morph 0.25 lands EXACTLY on anchor 1 (adult meow) — no crossfade.
    expect(morphSeg(DEFAULTS.morph)).toEqual({ idx: 1, seg: 1, seg2: 2, frac: 0 });
  });

  it('the note starts FLAT and settles SHARP — both, at the defaults', () => {
    expect(meowboxOnsetHz(DEFAULTS)).toBeCloseTo(230.94, 2);
    expect(meowboxSettledHz(DEFAULTS)).toBeCloseTo(290.29, 2);
    expect(meowboxSettledSemitones(DEFAULTS)).toBeCloseTo(1.8, 12);
  });
});

describe('meowbox face model — the five anchors', () => {

  it('the `tail ×` column is the DECAY knob’s own defeat, read down the roster', () => {
    // The same dial is worth 0.7× at kitten and 2.0× at yowl. Reading the column
    // is what makes the point without spending a hint on it.
    expect(meowboxAnchorNote(0)).toBe('700 Hz · 85 % voiced · tail ×0.7');
    expect(meowboxAnchorNote(3)).toBe('380 Hz · 80 % voiced · tail ×2.0');
    expect(meowboxAnchorNote(4)).toBe('100 Hz · 15 % voiced · tail ×0.6');
  });
});
