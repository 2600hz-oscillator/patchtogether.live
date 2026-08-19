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
function readout(id: string, over: Partial<MeowboxParams> = {}): string {
  const fn = faceReadoutValueFor(id);
  expect(fn, `${id} is not registered in face-readout-values.ts`).not.toBeNull();
  return fn!(withParams(over));
}

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

  it('the stereo spread is still capped at 0.6 ms — the comb null’s only input', () => {
    const src = DSP();
    expect(src).toContain('maxDelay = 0.001 * ma.SR;');
    expect(src).toContain('stereoSpread(g, m) = (1.0 - ampEnv(g, m)) * 0.6;');
    // ⚠ AND THE .dsp's OWN COMMENT IS WRONG ABOUT IT — :111 says "up to 1 ms"
    // where the ·0.6 caps it at 0.6. Pinned as a DEFECT: this fails the day
    // someone fixes the comment, which is when the readout should be re-read.
    expect(src, 'the "up to 1 ms" comment was corrected — re-check meowbox-comb-null')
      .toContain('delayed by up to 1 ms');
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

  it('F1 is inert at morph 1.0 and NOWHERE ELSE — the whole of 0..0.75 is a1 = 1', () => {
    for (const m of [0, 0.25, 0.5, 0.625, 0.75]) {
      expect(a1Of(m), `a1 at morph ${m}`).toBe(1);
    }
    // …and it falls linearly over the last quarter rather than switching off.
    expect(a1Of(0.9)).toBeCloseTo(0.4, 12);
    expect(a1Of(0.99)).toBeCloseTo(0.04, 12);
    expect(a1Of(1)).toBe(0);
    // The face PRINTS that, rather than hiding a dead band behind a live number.
    expect(readout('meowbox-formant-gain', { morph: 1 }).startsWith('−∞ dB')).toBe(true);
  });
});

describe('meowbox face model — the shipped defaults', () => {
  it('resolves the def defaults for an untouched node', () => {
    expect(DEFAULTS).toEqual({ pitch: 0, morph: 0.25, decay: 0.4, level: 1 });
    // morph 0.25 lands EXACTLY on anchor 1 (adult meow) — no crossfade.
    expect(morphSeg(DEFAULTS.morph)).toEqual({ idx: 1, seg: 1, seg2: 2, frac: 0 });
  });

  it('prints the face’s own figures', () => {
    expect(readout('meowbox-formants')).toBe('450 Hz · 1.3 kHz · 2.7 kHz');
    // THE HEADLINE: you asked for 262 Hz (C4) and the voice holds 290.
    expect(readout('meowbox-settled-hz')).toBe('290 Hz');
    expect(readout('meowbox-tail-s')).toBe('400 ms');
    expect(readout('meowbox-formant-gain')).toBe('+20.0 dB · +18.5 dB · +13.6 dB');
    expect(readout('meowbox-tremolo')).toBe('6 % @ 15 Hz');
    expect(readout('meowbox-comb-null')).toBe('833 Hz idle · 1.4 kHz held');
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

describe('meowbox face model — NEGATIVE CONTROLS (both directions)', () => {
  // ── A · `formants`. MORPH moves it; nothing else may.
  it('MORPH resolves a mid-glide triple in no anchor row; pitch/decay/level do not move it', () => {
    expect(meowboxFormantHz({ ...DEFAULTS, morph: 0.375 })).toEqual([315, 825, 1750]);
    expect(readout('meowbox-formants', { morph: 0.375 })).toBe('315 Hz · 825 Hz · 1.8 kHz');
    // …and NONE of those three numbers is in a table row, which is the claim.
    for (const t of [F1_AT, F2_AT, F3_AT]) {
      expect(t).not.toContain(315);
      expect(t).not.toContain(825);
      expect(t).not.toContain(1750);
    }
    // The frozen leg: the whole travel of the other three knobs.
    const seen = new Set<string>();
    for (const pitch of [-36, -12, 0, 12, 36]) seen.add(readout('meowbox-formants', { pitch }));
    for (const decay of [0.05, 0.4, 2]) seen.add(readout('meowbox-formants', { decay }));
    for (const level of [0, 1, 2]) seen.add(readout('meowbox-formants', { level }));
    expect([...seen], 'a formant readout that follows PITCH is reading the wrong thing')
      .toEqual(['450 Hz · 1.3 kHz · 2.7 kHz']);
  });

  // ── B · `peak gain` — THE SHARPEST ONE. The amplitude table is FLAT here.
  it('morph 0.5 → 0.75 moves band 1 by +7.36 dB while its AMPLITUDE never moves', () => {
    // The blind implementation, made explicit: A1 is 1.0 at both ends AND at
    // every point between, so a readout of the `a` table is motionless across
    // the entire move.
    for (const m of [0.5, 0.5625, 0.625, 0.6875, 0.75]) {
      expect(a1Of(m), `A1 at morph ${m} — the flat leg`).toBe(1);
    }
    // …and the real peak, which is a·Q, travels 6 → 14.
    expect(meowboxPeakGain({ ...DEFAULTS, morph: 0.5 })[0]).toBeCloseTo(6, 12);
    expect(meowboxPeakGain({ ...DEFAULTS, morph: 0.75 })[0]).toBeCloseTo(14, 12);
    expect(20 * Math.log10(14 / 6)).toBeCloseTo(7.3595, 4);
    expect(readout('meowbox-formant-gain', { morph: 0.5 })).toBe('+15.6 dB · +13.6 dB · +7.6 dB');
    expect(readout('meowbox-formant-gain', { morph: 0.75 })).toBe('+22.9 dB · +22.7 dB · +18.5 dB');
    // The frozen leg.
    expect(readout('meowbox-formant-gain', { decay: 2, level: 0, pitch: 36 }))
      .toBe(readout('meowbox-formant-gain'));
  });

  // ── C · `settles` — a `paramId: 'pitch'` readout is blind to exactly this.
  it('the TIMBRE knob moves the sounding pitch 1.8 semitones with PITCH pinned at 0', () => {
    expect(readout('meowbox-settled-hz')).toBe('290 Hz');
    expect(readout('meowbox-settled-hz', { morph: 0.5 })).toBe('262 Hz');
    expect(meowboxSettledSemitones({ ...DEFAULTS, morph: 0.5 })).toBe(0);
    expect(DEFAULTS.pitch, 'the knob a naive readout would follow sits still').toBe(0);
    // It DOES follow PITCH as well — the readout is not morph-only, it is the
    // SUM, and a version that ignored the knob would be its own bug.
    expect(readout('meowbox-settled-hz', { pitch: 12 })).toBe('581 Hz');
    // The frozen leg: the tail knobs are irrelevant to pitch.
    const seen = new Set<string>();
    for (const decay of [0.05, 0.4, 2]) seen.add(readout('meowbox-settled-hz', { decay }));
    for (const level of [0, 2]) seen.add(readout('meowbox-settled-hz', { level }));
    expect([...seen]).toEqual(['290 Hz']);
  });

  // ── D · `tail` — a `paramId: 'decay'` readout prints 400 ms at every morph,
  //        and is RIGHT at the default. That is why the default is not the test.
  it('MORPH doubles the tail 400 → 800 ms with DECAY pinned at 0.40', () => {
    expect(DEFAULTS.decay).toBe(0.4);
    expect(readout('meowbox-tail-s')).toBe('400 ms');
    expect(readout('meowbox-tail-s', { morph: 0.75 })).toBe('800 ms');
    expect(readout('meowbox-tail-s', { morph: 1 })).toBe('240 ms');
    // The dial's seconds are the truth at EXACTLY ONE morph position.
    const exact = [0, 0.25, 0.5, 0.75, 1].filter(
      (m) => Math.abs(meowboxTailS({ ...DEFAULTS, morph: m }) - DEFAULTS.decay) < 1e-12,
    );
    expect(exact, 'more than one anchor now agrees with the dial').toEqual([0.25]);
    // The reachable span, both ends.
    expect(readout('meowbox-tail-s', { decay: 0.05, morph: 1 })).toBe('30 ms');
    expect(readout('meowbox-tail-s', { decay: 2, morph: 0.75 })).toBe('4.00 s');
    // The frozen leg.
    expect(readout('meowbox-tail-s', { pitch: -36, level: 0 })).toBe('400 ms');
  });

  // ── E · `tremolo` — pinned against the comment, in the direction it denies.
  it('the tremolo is MAXIMAL at hiss and MINIMAL at kitten — the opposite of the source comment', () => {
    expect(meowboxTremoloDepth({ ...DEFAULTS, morph: 1 })).toBeCloseTo(0.34, 12);
    expect(meowboxTremoloDepth({ ...DEFAULTS, morph: 0 })).toBeCloseTo(0.06, 12);
    expect(readout('meowbox-tremolo', { morph: 1 })).toBe('34 % @ 15 Hz');
    expect(readout('meowbox-tremolo', { morph: 0 })).toBe('6 % @ 15 Hz');
    // …and it is monotone in morph across the anchors it is claimed to spare.
    expect(meowboxTremoloDepth({ ...DEFAULTS, morph: 1 }))
      .toBeGreaterThan(meowboxTremoloDepth({ ...DEFAULTS, morph: 0.5 }));
    // The frozen leg.
    expect(readout('meowbox-tremolo', { pitch: 24, decay: 2, level: 0 })).toBe('6 % @ 15 Hz');
  });

  // ── F · `mono-sum null` — the control runs the OTHER WAY, and both legs are
  //        asserted because the easy half alone would be decoration.
  it('the comb null moves with the ENVELOPE and with NO param at all', () => {
    // The moving leg: perturb the thing it actually depends on.
    expect(meowboxCombNullHz(0)).toBeCloseTo(833.333, 3);
    expect(meowboxCombNullHz(MEOWBOX_SUSTAIN)).toBeCloseTo(1388.889, 3);
    expect(meowboxCombNullHz(1)).toBe(Infinity);
    // The frozen leg: EVERY param, swept, must leave the printed string alone.
    // A readout that responded to a knob here would be measuring something else.
    const seen = new Set<string>();
    for (const pitch of [-36, 0, 36]) {
      for (const morph of [0, 0.25, 0.5, 0.75, 1]) {
        for (const decay of [0.05, 0.4, 2]) {
          for (const level of [0, 1, 2]) {
            seen.add(readout('meowbox-comb-null', { pitch, morph, decay, level }));
          }
        }
      }
    }
    expect([...seen], 'a param moved the comb null — it is a function of the envelope only')
      .toEqual(['833 Hz idle · 1.4 kHz held']);
    // …and the null sits INSIDE the formant region at rest, which is the reason
    // the output docs stopped saying "summing to mono is fine".
    const [f1, f2] = meowboxFormantHz(DEFAULTS);
    expect(meowboxCombNullHz(0)).toBeGreaterThan(f1);
    expect(meowboxCombNullHz(0)).toBeLessThan(f2);
  });
});
