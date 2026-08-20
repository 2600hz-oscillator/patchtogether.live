// packages/web/src/lib/ui/modules/stereovca-face-model.test.ts
//
// THE PERMANENT LEGS BEHIND THE stereovca FACEPLATE (queue Q42).
//
// This face declares NO derived readout, so there is no `valueId` to
// negative-control — and that absence is exactly why this file has to exist.
// The owner ruled the module's headline fact onto the CONTROL instead of into a
// readout row (#1962, verbatim *"2 - b"*), which means the whole of the face's
// claim now rests on a LANDMARK ROSTER plus the cell kind that renders it. Both
// are silently deletable:
//
//   * add a `format` to `offset` and `paintsReadout` goes false, so the dial
//     paints NOTHING at rest and every gate stays green;
//   * declare `offset: 'fader'` in `face.paramCells` and ModuleShell takes its
//     fader branch, which passes no `landmarks` at all — again with every gate
//     green, because no gate reads what a cell FORWARDS.
//
// Either edit satisfies the lint, the contract lock, the docs gate and the VRT
// budget while removing the thing the ruling asked for. So the legs below are
// written against the REAL predicates the renderer calls, in both directions.

import { describe, expect, it } from 'vitest';
import { stereovcaDef, stereoVcaMath, STEREOVCA_OFFSET_LANDMARKS } from '$lib/audio/modules/stereovca';
import type { ParamDef } from '$lib/graph/types';
import { knobNameReadout, paintsReadout } from '$lib/ui/controls/knob-vocabulary-model';
import { declaredParamCells, paramCellKind } from '$lib/ui/workflow/shell-control-kind';
import { curatedFace } from '$lib/ui/workflow/curated-face';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';

const param = (id: string): ParamDef => {
  const p = stereovcaDef.params.find((q) => q.id === id);
  if (!p) throw new Error(`stereovca declares no param '${id}'`);
  return p;
};

const OFFSET = () => param('offset');
const LEVEL = () => param('level');

/** The face, as the shell sees it. Throws rather than skipping if the face is
 *  gone — an absent face must fail this file loudly, not vacuously pass it. */
function face() {
  const f = stereovcaDef.face;
  if (!f) throw new Error('stereovca declares no face — Q42 was reverted, not re-ranked');
  return f;
}

// ─── THE RULING'S IMPLEMENTATION, AND WHAT WOULD SILENTLY UNDO IT ───────────

describe('#1962: the mute-at-centre fact is painted as a landmark NAME on the control', () => {
  it('paints MUTE at the SHIPPED DEFAULT — the exact state the module spawns in', () => {
    const offset = OFFSET();
    expect(offset.defaultValue).toBe(0);
    expect(knobNameReadout(offset.defaultValue, offset)).toBe('MUTE');
  });

  it('names both RAILS, so "unity at both ends" is legible without moving the dial', () => {
    const offset = OFFSET();
    expect(knobNameReadout(offset.min, offset)).toBe('INV');
    expect(knobNameReadout(offset.max, offset)).toBe('UNITY');
  });

  it('NEGATIVE CONTROL — declaring a `format` would paint NOTHING, which is how this gets lost', () => {
    const offset = OFFSET();
    expect(paintsReadout(offset)).toBe(true);

    // The exact shape `vca` uses for its attenuverter. Correct THERE (a sign is
    // a boundary, and a nearest lookup genuinely lies about it) and wrong HERE,
    // because this dial's meaning is its magnitude.
    const withFormat = { ...offset, format: (v: number) => `${v.toFixed(2)}` };
    expect(paintsReadout(withFormat)).toBe(false);
    expect(knobNameReadout(0, withFormat)).toBeNull();
  });

  it('NEGATIVE CONTROL — dropping the roster paints nothing either', () => {
    const bare = { ...OFFSET(), landmarks: undefined };
    expect(paintsReadout(bare)).toBe(false);
    expect(knobNameReadout(0, bare)).toBeNull();
  });

  it('the roster the def declares IS the exported one, by identity', () => {
    expect(OFFSET().landmarks).toBe(STEREOVCA_OFFSET_LANDMARKS);
  });
});

describe('the NEAREST-MATCH BAND, pinned rather than narrowed', () => {
  // `knobNameReadout` resolves by nearest value with ties to the EARLIER entry
  // (knob-vocabulary-model). With ticks at -1 / 0 / +1 that puts the MUTE/UNITY
  // boundary at |offset| = 0.5 — and the quiescent gain there is |offset| x
  // level = 0.5, i.e. -6.02 dB. So `MUTE` prints over a band whose loud end is
  // audible, and this test is where that cost is recorded instead of hidden.
  //
  // Pinned so a future edit to the roster has to re-argue the band rather than
  // move it silently: narrowing it (a five-tick roster) is a legitimate change
  // and it must turn this test red.
  const quiescentGain = (offset: number, level: number) => Math.abs(offset) * level;

  it('prints MUTE across |offset| < 0.5 and flips at the tie, which resolves to the EARLIER entry', () => {
    const offset = OFFSET();
    expect(knobNameReadout(0.49, offset)).toBe('MUTE');
    // Exactly 0.5 is equidistant from MUTE(0) and UNITY(1); the earlier entry wins.
    expect(knobNameReadout(0.5, offset)).toBe('MUTE');
    expect(knobNameReadout(0.51, offset)).toBe('UNITY');
    expect(knobNameReadout(-0.49, offset)).toBe('MUTE');
    expect(knobNameReadout(-0.51, offset)).toBe('INV');
  });

  it('records the WORST CASE the band tolerates: MUTE is painted at a quiescent gain of 0.5 (-6.02 dB)', () => {
    const worst = quiescentGain(0.5, LEVEL().defaultValue);
    expect(knobNameReadout(0.5, OFFSET())).toBe('MUTE');
    expect(worst).toBeCloseTo(0.5, 12);
    expect(20 * Math.log10(worst)).toBeCloseTo(-6.0206, 3);
  });

  it('TOTALITY — a non-finite value never throws and never prints a number', () => {
    const offset = OFFSET();
    for (const v of [NaN, Infinity, -Infinity]) {
      const out = knobNameReadout(v, offset);
      expect(() => knobNameReadout(v, offset)).not.toThrow();
      // NaN compares false against every distance, so nearestByValue keeps its
      // initial `undefined`; +/-Infinity resolves to the nearer rail. Either way
      // the result is a declared NAME or nothing — never `NaN` on the panel.
      if (out !== null) expect(STEREOVCA_OFFSET_LANDMARKS.some((l) => l.label === out)).toBe(true);
    }
  });
});

describe('the CELL KIND is what forwards the roster — and a fader does not', () => {
  it('resolves `offset` to a KNOB at both tiers, which is the only cell that paints a landmark', () => {
    const declared = declaredParamCells(stereovcaDef);
    expect(paramCellKind(OFFSET(), new Set(), 'lane', declared)).toBe('knob');
    expect(paramCellKind(OFFSET(), new Set(), 'dock', declared)).toBe('knob');
  });

  it('keeps `level` a declared FADER — it has no vocabulary to print, so nothing is lost', () => {
    const declared = declaredParamCells(stereovcaDef);
    expect(declared.get('level')).toBe('fader');
    expect(paintsReadout(LEVEL())).toBe(false);
  });

  it('NEGATIVE CONTROL — declaring `offset: fader` resolves a fader, which is the silent deletion', () => {
    const asFader = new Map([...declaredParamCells(stereovcaDef), ['offset', 'fader' as const]]);
    expect(paramCellKind(OFFSET(), new Set(), 'dock', asFader)).toBe('fader');
  });

  it('DERIVED RULE, not a list: no param that paints a resting NAME may be declared a fader', () => {
    const declared = declaredParamCells(stereovcaDef);
    const offenders = stereovcaDef.params
      .filter((p) => paintsReadout(p) && declared.get(p.id) === 'fader')
      .map((p) => p.id);
    expect(offenders).toEqual([]);
  });
});

// ─── THE RANKING ARGUMENT, AGAINST THE DSP RATHER THAN AGAINST ITSELF ───────

/**
 * The audio carrier these legs multiply — a 6 kHz square at +/-0.5, 256 frames.
 *
 * ⚠ IT IS A SQUARE ON PURPOSE, AND THE FIRST DRAFT OF THIS FILE GOT IT WRONG.
 * A 220 Hz sine at 48 kHz has no SAMPLE on its crest, so `max |out|` came back
 * 0.24998629 for a gain of exactly x0.5 — a 1.4e-5 shortfall that reads exactly
 * like a DSP inaccuracy and is entirely an artifact of where the probe sampled.
 * Loosening the tolerance would have hidden a real gain error of the same size
 * for ever. Every sample of this signal is +/-0.5, which is float32-exact, so
 * `max |out|` IS the gain times the amplitude with nothing left to round.
 */
function carrier(frames = 256): Float32Array {
  return Float32Array.from({ length: frames }, (_, i) => (Math.floor(i / 4) % 2 ? -0.5 : 0.5));
}

describe('rank 1 is OFFSET, and the reason is reachability from the spawn state', () => {
  it('gives the mini tile OFFSET — derived from the face, so a re-rank must re-argue this', () => {
    const mini = curatedFace(stereovcaDef, 'mini');
    expect(mini?.controls.map((c) => c.key)).toEqual(['offset']);
  });

  it('LEVEL is bit-exactly inert at the shipped defaults, across its whole travel', () => {
    // The oracle is the def's own mirror of the worklet loop. `strength` null =
    // an unpatched Web Audio input (a zero-length channel array), which is the
    // convention both the mirror and packages/dsp/src/stereovca.ts use.
    const IN = carrier();
    const offset = OFFSET().defaultValue;
    const renders = Array.from({ length: 41 }, (_, k) =>
      stereoVcaMath.render(IN, null, null, null, offset, k / 40, IN.length).outL);

    for (const out of renders) {
      expect(Array.from(out).every((s) => Object.is(s, 0) || s === 0)).toBe(true);
    }
    // ...and every one of the 41 is the SAME render, which is the claim.
    for (const out of renders) expect(Array.from(out)).toEqual(Array.from(renders[0]!));
  });

  it('POSITIVE CONTROL — with STRENGTH patched, LEVEL is perfectly live on the same instrument', () => {
    const IN = carrier();
    const S = new Float32Array(256).fill(1);
    const peak = (level: number) => {
      const { outL } = stereoVcaMath.render(IN, null, S, null, 0, level, IN.length);
      return Math.max(...Array.from(outL).map(Math.abs));
    };
    expect(peak(0)).toBeCloseTo(0, 12);
    expect(peak(0.5)).toBeCloseTo(0.25, 6);
    expect(peak(1)).toBeCloseTo(0.5, 6);
  });

  it('OFFSET is the only control that un-mutes it, and UNITY sits at BOTH rails', () => {
    const IN = carrier();
    const peak = (offset: number) => {
      const { outL } = stereoVcaMath.render(IN, null, null, null, offset, 1, IN.length);
      return Math.max(...Array.from(outL).map(Math.abs));
    };
    expect(peak(-1)).toBeCloseTo(0.5, 6);
    expect(peak(0)).toBe(0);
    expect(peak(1)).toBeCloseTo(0.5, 6);
    // The two rails differ in POLARITY and not in level — which is why they are
    // named INV and UNITY rather than given one shared name.
    const l = stereoVcaMath.render(IN, null, null, null, -1, 1, IN.length).outL;
    const r = stereoVcaMath.render(IN, null, null, null, 1, 1, IN.length).outL;
    for (let i = 0; i < IN.length; i++) expect(l[i]).toBeCloseTo(-r[i]!, 12);
  });
});

describe('the GLYPH binds live, and the face declares the one that reads', () => {
  it('resolves live-audio on out_l — run through the real resolver, not reasoned from the def', () => {
    expect(primaryAudioOutPortId(stereovcaDef)).toBe('out_l');
    expect(glyphBinding(stereovcaDef)).toEqual({ kind: 'live-audio', portId: 'out_l' });
    expect(face().glyph).toBe('meter');
  });

  it('NEGATIVE CONTROL — `envelope` would resolve STATIC on this def (no A/D/S/R)', () => {
    const asEnvelope = { ...stereovcaDef, face: { ...face(), glyph: 'envelope' as const } };
    expect(glyphBinding(asEnvelope)).toEqual({ kind: 'static' });
  });

  it('⚠ the tap reads EXACTLY ZERO at spawn, so a live-glyph assertion must drive the module first', () => {
    const IN = carrier(128);
    const { outL } = stereoVcaMath.render(IN, null, null, null, OFFSET().defaultValue, LEVEL().defaultValue, IN.length);
    expect(Math.max(...Array.from(outL).map(Math.abs))).toBe(0);
  });
});

describe('the face declaration', () => {
  // ── THE TWO RESTING-TEXT CASES ARE GONE: THE TYPES ENFORCE THEM NOW ───────
  //
  // This block used to open with `declares NO readouts` (`face.hero.readouts`
  // empty) and `declares NO sidebar` (`face.sidebar` undefined). #1971 deleted
  // BOTH FIELDS — `readouts` from `ModuleFaceHero`, `sidebar` from
  // `ModuleFace` — so neither expression typechecks any more, and the claim
  // each made is now made by `tsc` for every module before a test runs.
  // `graph/types.ts` says so at the declaration site: *"THERE IS NO `readouts`
  // FIELD, AND THERE IS NO `sidebar` ON `ModuleFace`. Both are DELETED, not
  // deprecated, and re-adding either — under any name — is the mistake this
  // note exists to prevent."*
  //
  // ⚠ DELETED, NOT LAPSED, and the direction is the point: a per-module
  // runtime check that a field is empty is strictly WEAKER than a type that
  // refuses the field. The fleet-wide SHAPE is denied by
  // `face-resting-text-source.test.ts`, which enumerates the permitted text
  // roles and reddens on the TYPE — the formulation chosen precisely because
  // four different mechanisms had each passed the gate written for the one
  // before it. This module declared neither field to begin with (its def says
  // so, and says it was the RULING rather than an omission), so nothing about
  // stereovca changed here; only the place the guarantee is enforced.

  it('is ONE page holding BOTH controls, so no control is unreachable at the dock', () => {
    const pages = face().pages ?? [];
    expect(pages.length).toBe(1);
    expect([...(pages[0]?.controls ?? [])].sort()).toEqual([...face().order].sort());
  });
});
