// packages/web/src/lib/control/push2/push-card-schema.test.ts
//
// TWO jobs:
//
//  1. THE CONFIG GATE — the reason push-card-config.ts is safe to hand-edit.
//     It reads the LIVE module registries and fails on any override id that is
//     not a real, turnable param of that module, naming the module, the bad id
//     and the valid ids. Pure unit lane, ~0 CI wall-time.
//
//  2. THE RESOLVER — the three tiers, their fall-through, and the exact
//     control roster each AUTHORED card resolves to. Those roster assertions
//     are GOLDENS in the repo's accept-loop style (contract-lock, ART
//     fingerprints): editing push-card-config.ts turns them red on purpose, so
//     a card change is always seen and confirmed rather than shipped blind.

import { describe, it, expect, beforeEach, vi, afterEach, type MockInstance } from 'vitest';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import type { ParamDef, NoUserControlDefLike } from '$lib/graph/types';
import { momentaryParamIds } from '$lib/ui/workflow/shell-control-kind';
import { noUserControlIds } from '$lib/ui/workflow/no-user-control';

import { PUSH_CARD_CONTROLS } from './push-card-config';
import {
  PUSH_CARD_SLOTS,
  isTurnable,
  pushCardParams,
  resolvePushCardControls,
  resetPushCardWarnings,
  type PushCardDefLike,
} from './push-card-schema';

function allDefs(): PushCardDefLike[] {
  return [
    ...(listModuleDefs() as unknown as PushCardDefLike[]),
    ...(listVideoModuleDefs() as unknown as PushCardDefLike[]),
    ...(listMetaModuleDefs() as unknown as PushCardDefLike[]),
  ];
}

function defByType(type: string): PushCardDefLike {
  const def = allDefs().find((d) => d.type === type);
  if (!def) throw new Error(`no such module type: ${type}`);
  return def;
}

/** The control ids a card resolves to, in encoder order. */
function ids(type: string, overrides = PUSH_CARD_CONTROLS): string[] {
  return pushCardParams(resolvePushCardControls(defByType(type), overrides)).map((p) => p.id);
}

// A hand-built def fixture, so the resolver can be exercised on shapes no
// shipped module has (a degenerate range, an all-family face, `curve: 'exp'`).
function fixture(over: Partial<PushCardDefLike> = {}): PushCardDefLike {
  return {
    type: 'fixture',
    domain: 'audio',
    label: 'fixture',
    category: 'test',
    params: [],
    ...over,
  };
}

function p(over: Partial<ParamDef> & { id: string }): ParamDef {
  return { label: over.id, defaultValue: 0, min: 0, max: 1, curve: 'linear', ...over };
}

// ---------------------------------------------------------------------------
// 1. THE CONFIG GATE
// ---------------------------------------------------------------------------

describe('push-card-config: every override names a control the def declares', () => {
  const defs = new Map(allDefs().map((d) => [d.type, d]));

  it('names a module type that exists', () => {
    for (const type of Object.keys(PUSH_CARD_CONTROLS)) {
      expect(
        defs.has(type),
        `push-card-config: unknown module type '${type}'\n` +
          `  (keys are module TYPES from the def, e.g. 'tidyVco' not 'tidy-vco')`,
      ).toBe(true);
    }
  });

  it('names only real, TURNABLE params — a typo fails loudly, with the valid list', () => {
    for (const [type, controls] of Object.entries(PUSH_CARD_CONTROLS)) {
      const def = defs.get(type);
      if (!def) continue; // reported by the test above
      const params = def.params ?? [];
      const byId = new Map(params.map((q) => [q.id, q]));
      const momentary = momentaryParamIds(def);
      // #1726 — params the DEF declares a player never sets. They are
      // `isTurnable` (backdraft's six gate params are 0..1 linear), so every
      // other check here passes them, and they are absent from `face.momentary`
      // too — nothing already in this gate can see them.
      const noControl = noUserControlIds(def as NoUserControlDefLike);
      const valid = params
        .filter((q) => isTurnable(q) && !momentary.has(q.id) && !noControl.has(q.id))
        .map((q) => q.id)
        .join(', ');

      for (const id of controls) {
        const param = byId.get(id);
        expect(
          param !== undefined,
          `push-card-config: ${type} → unknown control '${id}'\n  valid params: ${valid}`,
        ).toBe(true);
        if (!param) continue;
        expect(
          isTurnable(param),
          `push-card-config: ${type} → '${id}' has a degenerate range ` +
            `(${param.min}..${param.max}); an encoder has nothing to turn.\n` +
            `  valid params: ${valid}`,
        ).toBe(true);
        expect(
          momentary.has(id),
          `push-card-config: ${type} → '${id}' is a MOMENTARY press-pad ` +
            `(face.momentary), not a value an encoder can turn.\n` +
            `  valid params: ${valid}`,
        ).toBe(false);
        // #1726 — an override REPLACES the ranking, so it is the one tier a
        // no-user-control param could still reach an encoder through. The
        // resolver drops it either way; this makes the config say so at edit
        // time rather than shipping a silently blank strip.
        expect(
          noControl.has(id),
          `push-card-config: ${type} → '${id}' is declared noUserControl on the def ` +
            `(a player never sets it — a CV bridge or the harness writes it), so it ` +
            `cannot be an encoder.\n  valid params: ${valid}`,
        ).toBe(false);
      }
    }
  });

  it('lists at most 8 controls, with no duplicates', () => {
    for (const [type, controls] of Object.entries(PUSH_CARD_CONTROLS)) {
      expect(
        controls.length,
        `push-card-config: ${type} lists ${controls.length} controls; the Push 2 has ` +
          `${PUSH_CARD_SLOTS} display encoders, so at most ${PUSH_CARD_SLOTS} fit`,
      ).toBeLessThanOrEqual(PUSH_CARD_SLOTS);
      const dupes = controls.filter((id, i) => controls.indexOf(id) !== i);
      expect(dupes, `push-card-config: ${type} lists ${dupes.join(', ')} twice`).toEqual([]);
    }
  });

  it('resolves each override to the SAME ids that were written down', () => {
    // Closes the loop: the gate above validates the ids in isolation, this
    // asserts the resolver actually honours all of them (an off-by-one slice
    // or a silent drop would pass the checks above and still lose a control).
    for (const [type, controls] of Object.entries(PUSH_CARD_CONTROLS)) {
      const spec = resolvePushCardControls(defByType(type));
      expect(spec.source, `${type} should resolve through the OVERRIDE tier`).toBe('override');
      expect(pushCardParams(spec).map((q) => q.id), `${type}`).toEqual([...controls]);
      expect(spec.skipped, `${type} dropped an override id`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. THE THREE TIERS
// ---------------------------------------------------------------------------

describe('resolvePushCardControls — tier 1, the override', () => {
  it('REPLACES the ranking; it does not merge with the face', () => {
    const spec = resolvePushCardControls(defByType('filter'), { filter: ['mode', 'cutoff'] });
    expect(spec.source).toBe('override');
    expect(pushCardParams(spec).map((q) => q.id)).toEqual(['mode', 'cutoff']);
    // filter's face ranks cutoff FIRST and has 5 params; none of that leaks in.
    expect(spec.slots.filter((s) => s.kind === 'param')).toHaveLength(2);
  });

  it('always pads to 8 slots — fewer controls is the COMMON case, not an error', () => {
    const spec = resolvePushCardControls(defByType('vca'));
    expect(spec.slots).toHaveLength(PUSH_CARD_SLOTS);
    expect(spec.slots.slice(2).every((s) => s.kind === 'empty')).toBe(true);
  });

  it('truncates past 8 rather than overflowing the encoder row', () => {
    const nine = ['tune', 'pitch_amt', 'pitch_time', 'sub_decay', 'body_level', 'click_level', 'drive', 'level', 'tilt'];
    const spec = resolvePushCardControls(defByType('kickdrum'), { kickdrum: nine });
    expect(pushCardParams(spec)).toHaveLength(8);
    expect(pushCardParams(spec).map((q) => q.id)).not.toContain('tilt');
  });
});

describe('resolvePushCardControls — the runtime typo guard', () => {
  let warn: MockInstance;
  beforeEach(() => {
    resetPushCardWarnings();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('drops an unresolvable id, leaves ONE dark strip, and warns readably', () => {
    const spec = resolvePushCardControls(defByType('dx7'), { dx7: ['feedbck', 'algorithm'] });
    // The good id still lands: one typo must not blank the whole screen.
    expect(pushCardParams(spec).map((q) => q.id)).toEqual(['algorithm']);
    expect(spec.skipped).toEqual(['feedbck']);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('dx7');
    expect(msg).toContain('feedbck');
    expect(msg).toContain('valid params:');
    expect(msg).toContain('feedback'); // the id they meant is in the printed list
  });

  it('warns once per (module, id), not once per repaint', () => {
    const bad = { dx7: ['feedbck'] };
    resolvePushCardControls(defByType('dx7'), bad);
    resolvePushCardControls(defByType('dx7'), bad);
    resolvePushCardControls(defByType('dx7'), bad);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('falls through to the FACE when every override id is a typo', () => {
    const spec = resolvePushCardControls(defByType('filter'), { filter: ['nope', 'alsonope'] });
    expect(spec.source).toBe('face');
    expect(pushCardParams(spec).map((q) => q.id)[0]).toBe('cutoff');
  });

  it('refuses a MOMENTARY press-pad — an encoder cannot turn a trigger', () => {
    const spec = resolvePushCardControls(defByType('tomtom'), { tomtom: ['strike', 'tune'] });
    expect(pushCardParams(spec).map((q) => q.id)).toEqual(['tune']);
    expect(spec.skipped).toEqual(['strike']);
  });
});

describe('resolvePushCardControls — tier 2, the curated face', () => {
  it('takes the first 8 TURNABLE params of face.order, in rank order', () => {
    // karplus has no override; its face ranks 8 params (all turnable) plus one
    // control family, so the window has to step over the family AND still land
    // eight — the same property sixstrum pins below, on a module where the
    // family sits mid-order rather than at rank 7 of 15.
    //
    // ⚠ THIS GOLDEN MOVED WITH THE FACE, and that is the point rather than
    // churn: the encoder layout is DERIVED from `face.order`, so karplus's
    // LEVEL 8→6 / POS 6→8 re-rank re-assigns encoders 6-8. It is the hazard
    // CLAUDE.md's push-card note names ("a re-rank can silently change a
    // module's push card") firing as designed — visible, in an accept loop,
    // instead of silently.
    expect(ids('karplus')).toEqual([
      'decay', 'brightness', 'tune', 'color', 'burst', 'level', 'position', 'stiffness',
    ]);
    const spec = resolvePushCardControls(defByType('karplus'));
    expect(spec.source).toBe('face');
    expect(spec.skipped, 'the PLUCK is a family — an encoder cannot turn a button').toEqual([
      'karplus-strike-{n}',
    ]);
  });

  it('SKIPS control families and keeps walking — it does not stop at rank 1', () => {
    // sixstrum's face ranks TWO families back to back at 7 and 8 (the STRUM
    // audition, then the PRESET recall). The window must step over BOTH and
    // pull ranks 9-10 in, not come back two controls short.
    //
    // ⚠ THIS CARD MOVED IN FACE BATCH 3, and deliberately. The face re-do
    // re-ranked on one test — does this knob move a string that is ALREADY
    // RINGING? — so the encoders now carry the five controls that are live on a
    // sounding string (RING, MATERIAL, BODY, LEVEL, STIFF) plus the namesake
    // STRUM, where they used to carry three next-strike-only ones (PICK TONE,
    // REGISTER, plus DIR/TUNING). No override pins this module, so accepting
    // the drift here is the deliberate act CLAUDE.md asks for.
    const spec = resolvePushCardControls(defByType('sixstrum'));
    expect(spec.source).toBe('face');
    expect(spec.skipped).toEqual(['sixstrum-strum-{n}', 'sixstrum-preset-{n}']);
    expect(pushCardParams(spec)).toHaveLength(8);
    expect(pushCardParams(spec).map((q) => q.id)).toEqual([
      'ring', 'material', 'body', 'strumSpread', 'level', 'stiffness', 'tuning', 'register',
    ]);
  });

  it('a FIRST PROMOTION moves the module GENERIC → FACE, and that re-orders the encoders', () => {
    // wavetableVco, promoted 2026-08-15 (faceplate queue Q9). Nothing pins it
    // in PUSH_CARD_CONTROLS, so this is the drift CLAUDE.md's push-card note
    // warns about, firing as designed — and it is ACCEPTED DELIBERATELY here
    // rather than left silent, because the golden below only covers overrides
    // and would never have gone red.
    //
    // What moved: the GENERIC tier is DECLARATION order — tune, fine, wavePos,
    // fmAmount, pmAmount — so WAVE sat on encoder 3. The face ranks WAVE first
    // (it is the only control that changes the timbre, and the only thing this
    // VCO does that its siblings cannot), so it takes encoder 1 and pushes TUNE
    // and FINE down one each. Five params, all turnable, so nothing is skipped
    // and nothing falls off the 8-wide window; the card is a permutation of the
    // same set, which is exactly the case an override would be wrong to freeze.
    const spec = resolvePushCardControls(defByType('wavetableVco'));
    expect(spec.source).toBe('face');
    expect(spec.skipped, 'no families and no momentary pads on this module').toEqual([]);
    expect(pushCardParams(spec).map((q) => q.id)).toEqual([
      'wavePos', 'tune', 'fine', 'fmAmount', 'pmAmount',
    ]);
    // The negative control on the claim above: the DEF's own declaration order
    // is genuinely different, so this test would pass vacuously if the two
    // agreed and a future re-rank could not be distinguished from a no-op.
    expect((defByType('wavetableVco').params ?? []).map((q) => q.id)).toEqual([
      'tune', 'fine', 'wavePos', 'fmAmount', 'pmAmount',
    ]);
  });

  it('a FIRST PROMOTION can move the TIER and leave the CARD identical — ninelives', () => {
    // ninelives, promoted 2026-08-15 (faceplate queue Q11). The counterpart to
    // the leg above, and the reason both are worth having: a promotion moves
    // the module GENERIC → FACE unconditionally, but whether the ENCODERS move
    // depends entirely on whether the face's ranking differs from declaration
    // order. Here it does not — RATE genuinely outranks WAVEFORM (it moves all
    // nine taps; the morph moves none of them) and the def happens to declare
    // them in that order too — so the tier is new and the card is unchanged.
    //
    // Recorded rather than assumed: without this leg, "the card did not move"
    // and "nobody looked" are the same green.
    const spec = resolvePushCardControls(defByType('ninelives'));
    expect(spec.source, 'the promotion moves it off the GENERIC tier').toBe('face');
    expect(spec.skipped, 'no families and no momentary pads on this module').toEqual([]);
    expect(pushCardParams(spec).map((q) => q.id)).toEqual(['rate', 'shape']);
    // …and the card is identical to what the GENERIC tier produced BECAUSE the
    // two orders agree, stated directly so a future re-rank cannot slip through
    // as "the card was always like that".
    expect((defByType('ninelives').params ?? []).map((q) => q.id)).toEqual(['rate', 'shape']);
  });

  it('a FIRST PROMOTION over FOUR IDENTICAL CONTROLS leaves the card identical — illogic', () => {
    // illogic, promoted 2026-08-16 (faceplate queue Q17). The ninelives case
    // again, and worth its own leg because the REASON the orders agree is
    // different and could stop being true independently.
    //
    // ninelives's two keys agree with declaration order by coincidence of a
    // genuine priority argument. illogic's four keys are four copies of the
    // SAME control, so there is no priority to express at all — the face ranks
    // them by the axis the module itself supplies (channel 1 reaches seven of
    // the ten outputs, channel 2 six, channels 3 and 4 three each, measured in
    // art/scenarios/illogic/face-audit.test.ts), which happens to be channel
    // order, which happens to be declaration order. Three coincidences deep, so
    // "the card did not move" is exactly the claim that needs recording rather
    // than assuming.
    const spec = resolvePushCardControls(defByType('illogic'));
    expect(spec.source, 'the promotion moves it off the GENERIC tier').toBe('face');
    expect(spec.skipped, 'no families and no momentary pads on this module').toEqual([]);
    expect(pushCardParams(spec).map((q) => q.id)).toEqual([
      'att1_amount', 'att2_amount', 'att3_amount', 'att4_amount',
    ]);
    // …and the GENERIC tier would have produced the same four in the same
    // order, stated directly so a future re-rank cannot slip through as "the
    // card was always like that".
    expect((defByType('illogic').params ?? []).map((q) => q.id)).toEqual([
      'att1_amount', 'att2_amount', 'att3_amount', 'att4_amount',
    ]);
  });

  it('a PAIR promoted together keeps ONE card law — moog907a + moog914', () => {
    // The two fixed filter banks, promoted 2026-08-15 (faceplate queue Q12).
    // Recorded for the same reason as the two legs above, plus one more that is
    // specific to a PAIR: the whole argument for authoring them together is that
    // one idea should not produce two layouts, and the Push card is a surface
    // where that could quietly stop being true.
    //
    // What moved, and it is the SAME move on both: the GENERIC tier is
    // declaration order, which starts `hp` (the 7.5 / 6.6 kHz section) because
    // the def lists the shelves outside-in. The face ranks by FREQUENCY, so
    // encoder 1 becomes `lp` and the other seven are unchanged — a one-slot
    // substitution, not a reshuffle.
    //
    // ⚠ AND THE 914 TRUNCATES. It has fourteen sections and the encoder row is
    // eight, so `band8`…`band12` and `hp` are off the card entirely. That is the
    // 8-wide window doing its job on a module that genuinely has more controls
    // than a Push row, not a ranking mistake — and it is stated here so a future
    // reader does not "fix" it by re-ranking the axis.
    for (const type of ['moog907a', 'moog914']) {
      const spec = resolvePushCardControls(defByType(type));
      expect(spec.source, `${type}: the promotion moves it off the GENERIC tier`).toBe('face');
      expect(spec.skipped, `${type}: no families and no momentary pads`).toEqual([]);
      const ids = pushCardParams(spec).map((q) => q.id);
      expect(ids, `${type}: frequency order, truncated to the encoder row`).toEqual([
        'lp', 'band1', 'band2', 'band3', 'band4', 'band5', 'band6', 'band7',
      ]);
      // The negative control on the claim: declaration order is genuinely
      // DIFFERENT at slot 1, so this leg would pass vacuously if they agreed.
      expect(
        (defByType(type).params ?? []).map((q) => q.id).slice(0, 8),
        `${type}: what the GENERIC tier produced before the promotion`,
      ).toEqual(['hp', 'band1', 'band2', 'band3', 'band4', 'band5', 'band6', 'band7']);
    }
  });

  it('records WHICH keys it skipped, so the card cannot silently shrink', () => {
    // Fixture: a face whose first two ranks are unturnable. Both are named.
    const def = fixture({
      params: [p({ id: 'a' }), p({ id: 'b' })],
      controlFamilies: [{ id: 'fam', label: 'Fam' }],
      face: { order: ['fam-{n}', 'nope-static', 'a', 'b'] },
    });
    const spec = resolvePushCardControls(def, {});
    expect(spec.skipped).toEqual(['fam-{n}', 'nope-static']);
    expect(pushCardParams(spec).map((q) => q.id)).toEqual(['a', 'b']);
  });

  it('falls through to GENERIC when a face ranks nothing turnable', () => {
    const def = fixture({
      params: [p({ id: 'depth', min: 0, max: 1 })],
      controlFamilies: [{ id: 'fam', label: 'Fam' }],
      // `depth` exists but is NOT ranked, so the face window is empty.
      face: { order: ['fam-{n}'] },
    });
    const spec = resolvePushCardControls(def, {});
    expect(spec.source).toBe('generic');
    expect(pushCardParams(spec).map((q) => q.id)).toEqual(['depth']);
  });

  it('drops a DECLARED momentary pad from the face window', () => {
    // tidyVco ranks `hold` (momentary) 25th, tomtom ranks `strike` 9th — both
    // outside the window today. Prove the rule with a fixture that ranks one
    // INSIDE it, so the check cannot pass vacuously.
    const def = fixture({
      params: [p({ id: 'strike', curve: 'discrete', min: 0, max: 1 }), p({ id: 'tune', min: 20, max: 200 })],
      face: { order: ['strike', 'tune'], momentary: ['strike'] },
    });
    const spec = resolvePushCardControls(def, {});
    expect(spec.source).toBe('face');
    expect(pushCardParams(spec).map((q) => q.id)).toEqual(['tune']);
    expect(spec.skipped).toEqual(['strike']);
  });
});

describe('resolvePushCardControls — tier 3, the GENERIC card', () => {
  it('AUDIO: declaration order is the ranking', () => {
    // DERIVED, not named: the first un-faced audio def with enough params. It
    // used to be `charlottesEchos` — which now carries a face, so it moved from
    // this tier to the FACE tier (and its card re-ranked from declaration order
    // to `face.order`; no `PUSH_CARD_CONTROLS` entry, so that is the intended
    // effect of promoting it). Naming a module here would have gone stale
    // silently the moment it was promoted.
    const def = allDefs().find((d) => d.domain === 'audio' && !d.face && (d.params ?? []).length >= 3);
    expect(def, 'expected at least one un-faced audio module').toBeTruthy();
    const spec = resolvePushCardControls(def!, {});
    expect(spec.source).toBe('generic');
    expect(spec.domain).toBe('audio');
  });

  it('VIDEO: the SAME rule, carrying its own domain', () => {
    const def = listVideoModuleDefs().find((d) => (d.params ?? []).length >= 3) as unknown as PushCardDefLike;
    const spec = resolvePushCardControls(def, {});
    expect(spec.source).toBe('generic');
    expect(spec.domain).toBe('video');
    // Same selection rule, not a second one: declaration order.
    const expected = (def.params ?? []).filter((q) => isTurnable(q)).slice(0, 8).map((q) => q.id);
    expect(pushCardParams(spec).map((q) => q.id)).toEqual(expected);
  });

  it('demotes plain on/off switches BELOW the continuous params', () => {
    const def = fixture({
      params: [
        p({ id: 'bypass', curve: 'discrete', min: 0, max: 1 }),
        p({ id: 'freeze', curve: 'discrete', min: 0, max: 1 }),
        p({ id: 'gain', min: 0, max: 2 }),
        p({ id: 'tone', min: 0, max: 1 }),
      ],
    });
    const spec = resolvePushCardControls(def, {});
    expect(pushCardParams(spec).map((q) => q.id)).toEqual(['gain', 'tone', 'bypass', 'freeze']);
  });

  it('keeps declaration order WITHIN each partition (concatenation, not a sort)', () => {
    const def = fixture({
      params: [
        p({ id: 'z', min: 0, max: 1 }),
        p({ id: 'sw1', curve: 'discrete', min: 0, max: 1 }),
        p({ id: 'a', min: 0, max: 1 }),
        p({ id: 'sw0', curve: 'discrete', min: 0, max: 1 }),
      ],
    });
    expect(pushCardParams(resolvePushCardControls(def, {})).map((q) => q.id)).toEqual([
      'z', 'a', 'sw1', 'sw0',
    ]);
  });

  it('drops a DEGENERATE range — a bar with no width cannot show anything', () => {
    const def = fixture({
      params: [p({ id: 'stuck', min: 1, max: 1 }), p({ id: 'real', min: 0, max: 1 })],
    });
    const spec = resolvePushCardControls(def, {});
    expect(pushCardParams(spec).map((q) => q.id)).toEqual(['real']);
    expect(spec.skipped).toEqual(['stuck']);
  });

  it('a module with NO turnable params resolves to 8 empty slots', () => {
    const spec = resolvePushCardControls(fixture({ params: [] }), {});
    expect(spec.source).toBe('generic');
    expect(spec.slots).toHaveLength(PUSH_CARD_SLOTS);
    expect(pushCardParams(spec)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. COVERAGE — every module in the registry gets a card
// ---------------------------------------------------------------------------

describe('every shipped module resolves to a push card', () => {
  it('never throws, always returns exactly 8 slots', () => {
    for (const def of allDefs()) {
      const spec = resolvePushCardControls(def);
      expect(spec.slots, def.type).toHaveLength(PUSH_CARD_SLOTS);
      expect(spec.moduleType).toBe(def.type);
    }
  });

  /**
   * The GROUND TRUTH for a blank card: the module has no param an ENCODER can
   * turn. Two disqualifiers, and both matter —
   *   * a degenerate range (`isTurnable`), which no shipped module has; and
   *   * a MOMENTARY press-pad, which `resolvePushCardControls` skips at every
   *     tier, override included, because an encoder cannot press a key.
   *
   * ⚠ THIS USED TO BE `params.length === 0`, AND THAT WAS A DIFFERENT CLAIM
   * WEARING THIS ONE'S NAME. It equated "no turnable params" with "no params at
   * all", which held only while no module's ENTIRE param list was press-pads.
   * bluebox is that module (twelve keys, all `face.momentary`), and the
   * assertion went red the moment it existed — correctly, but with a message
   * about the wrong thing. Derived from the defs, so it stays anchored to the
   * artifact instead of to a hand-list that would rot.
   */
  function noTurnableTypes(): string[] {
    return allDefs()
      .filter((d) => {
        const momentary = momentaryParamIds(d);
        return !(d.params ?? []).some((p) => !momentary.has(p.id) && isTurnable(p));
      })
      .map((d) => d.type);
  }

  it('only a module with NO ENCODER-TURNABLE param ends up with a blank card', () => {
    const blank: string[] = [];
    for (const def of allDefs()) {
      if (pushCardParams(resolvePushCardControls(def)).length === 0) blank.push(def.type);
    }
    expect(blank.sort()).toEqual(noTurnableTypes().sort());
  });

  it('the blank-card set is the port-only modules PLUS the all-press-pad ones', () => {
    // The clause above is an equality between two derivations; this one names
    // what is actually in the set, so a module silently JOINING it is visible.
    // The 21+ port-only / DOM-only modules (clocked-runner, midi-lane, painter,
    // videoOut, the meta widgets, …) genuinely declare no ParamDefs.
    const noParams = new Set(allDefs().filter((d) => (d.params ?? []).length === 0).map((d) => d.type));
    const allPressPads = noTurnableTypes().filter((t) => !noParams.has(t));
    // ⚠ ONE ENTRY, AND IT IS A DELIBERATE HARDWARE STATE, NOT A REGRESSION.
    // bluebox is twelve momentary keys and nothing else, so its Push card is
    // the screen's own `no-controls` state ("this module has no turnable
    // controls") rather than eight encoders. Before `curve: 'discrete'` landed
    // the generic tier put EIGHT of the twelve keys on encoders as continuous
    // 0..1 dials — which dropped keys 9/0/BLUEBOX/REDBOX outright, ramped
    // uselessly from 0.00 to 0.49, and (worse) wrote a DURABLE held-key value
    // into the Y.Doc, the exact data-integrity bug $lib/audio/momentary-params
    // exists to prevent. Saying "nothing to turn" is the honest card.
    // A keypad wants the Push's 64 PADS, not its 8 encoders; that is a real
    // follow-up and a different surface from this schema.
    expect(allPressPads).toEqual(['bluebox']);
  });

  it('every faced module with something to turn resolves through override or face', () => {
    // DENY BY DEFAULT: a faced module falling through to `generic` normally
    // means its curated ranking was ignored. The ONE legitimate reason is that
    // the face ranks nothing an encoder can turn, and that reason is checked
    // rather than asserted — the module must actually have zero turnable params.
    const noTurnable = new Set(noTurnableTypes());
    for (const def of allDefs()) {
      if (!def.face) continue;
      if (noTurnable.has(def.type)) {
        expect(
          resolvePushCardControls(def).source,
          `${def.type}: has no turnable param, so the card must be the generic blank`,
        ).toBe('generic');
        continue;
      }
      expect(resolvePushCardControls(def).source, def.type).not.toBe('generic');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. THE AUTHORED CARDS — goldens (accept-loop: an edit turns these red)
// ---------------------------------------------------------------------------

describe('the AUTHORED push cards', () => {
  // If one of these fails after an intentional push-card-config.ts edit, that
  // is the gate working: read the diff, confirm the new card is what you meant,
  // and update the expectation in the SAME commit.
  const AUTHORED: Record<string, string[]> = {
    dx7: ['feedback', 'algorithm', 'level', 'transpose', 'attack', 'decay', 'sustain', 'release'],
    adsr: ['attack', 'decay', 'sustain', 'release'],
    vca: ['base', 'cvAmount'],
    lfo: ['rate', 'shape', 'depth'],
    tidyVco: ['shape1', 'shape2', 'mix', 'detune', 'oct2', 'cutoff', 'res', 'env'],
    kickdrum: ['tune', 'pitch_amt', 'pitch_time', 'sub_decay', 'body_level', 'click_level', 'drive', 'level'],
    cloudseed: [
      'preset_index', 'late_line_size', 'late_line_decay', 'dry_out',
      'early_out', 'late_out', 'low_cut', 'high_cut',
    ],
  };

  for (const [type, expected] of Object.entries(AUTHORED)) {
    it(`${type} shows ${expected.length} control${expected.length === 1 ? '' : 's'}, in encoder order`, () => {
      expect(ids(type)).toEqual(expected);
    });
  }

  it('dx7 drops voiceCount that the face window would have kept', () => {
    // The authored card differs from the default on purpose — prove it does,
    // otherwise the override is decoration and this file is untested.
    const faced = ids('dx7', {});
    expect(faced).toContain('voiceCount');
    expect(ids('dx7')).not.toContain('voiceCount');
  });

  // ── The overrides are NOT decoration ───────────────────────────────────
  //
  // Each case below states what the override ACHIEVES as a RELATION to whatever
  // the module's curated face currently ranks — never as a literal copy of that
  // ranking.
  //
  // ⚠ Copying the ranking is what the first draft did, and it was wrong for a
  // reason worth writing down: `face.order` lives in another file and is
  // re-curated on its own schedule. The 2026-08-02 face batch (#1276-#1280)
  // rewrote adsr, lfo, tidyVco and kickdrum, and every literal-form assertion
  // here went red — for a change that has nothing to do with the Push. A test
  // that fails when an unrelated file is legitimately edited is coupling, not
  // coverage. The claim actually worth gating is "the override does real work",
  // and that claim is a DIFFERENCE, so assert the difference.

  it('featurecv: promotion moved the card GENERIC → FACE, and the encoders really re-ordered', () => {
    // THE FACEPLATE QUEUE · Q16. This module carries NO `PUSH_CARD_CONTROLS`
    // entry, so its card is resolved by the FACE tier the moment it enters
    // STRICT_FACES — the skill's "a first promotion moves the module from
    // GENERIC to FACE, and the whole card changes, not one slot". It is
    // asserted here rather than left silent because nothing else in this file
    // would have noticed.
    //
    // Stated as a DIFFERENCE against the same def with its face removed, never
    // as a copy of `face.order` (see the note above): the ranking is re-curated
    // on its own schedule and a literal copy would redden this file for a
    // change that has nothing to do with the Push.
    const def = defByType('featurecv');
    const faced = pushCardParams(resolvePushCardControls(def, {})).map((p) => p.id);
    const generic = pushCardParams(
      resolvePushCardControls({ ...def, face: undefined }, {}),
    ).map((p) => p.id);
    // Same controls either way — a re-ORDER, not a re-pick (six params, well
    // inside the eight-encoder window).
    expect([...faced].sort()).toEqual([...generic].sort());
    expect(faced, 'the face must actually move the card, or this promotion is decoration')
      .not.toEqual(generic);
    // The ONE claim worth pinning: POLARITY takes encoder 1. That is the face's
    // whole rank-1 argument — it is the only control on this module with
    // authority over an output before anything is patched — so if it stops
    // being true, the re-rank wants reviewing rather than absorbing.
    expect(faced[0]).toBe('bipolar');
    expect(generic[0]).not.toBe('bipolar');
  });

  it('moog911: promotion moved the card GENERIC → FACE, and ESUS took encoder 2', () => {
    // THE FACEPLATE QUEUE · Q34. No `PUSH_CARD_CONTROLS` entry, so the card is
    // resolved by the FACE tier from the moment `moog911` enters STRICT_FACES.
    // Asserted here for the featurecv reason: nothing else in this file would
    // have noticed, and a card that changes silently is how the skill's "a
    // first promotion moves the module from GENERIC to FACE" gets discovered
    // by a player instead of by a test.
    //
    // Stated as a DIFFERENCE, never as a copy of `face.order`.
    const def = defByType('moog911');
    const faced = pushCardParams(resolvePushCardControls(def, {})).map((p) => p.id);
    const generic = pushCardParams(
      resolvePushCardControls({ ...def, face: undefined }, {}),
    ).map((p) => p.id);
    // A re-ORDER, not a re-pick — four params, well inside the eight encoders.
    expect([...faced].sort()).toEqual([...generic].sort());
    expect(faced, 'the face must actually move the card, or this promotion is decoration')
      .not.toEqual(generic);
    // ⚠ THE CLAIM IS ABOUT ENCODER 2, NOT ENCODER 1. Declaration order already
    // puts `t1` first, so rank 1 is the one slot where face and generic AGREE
    // and pinning it would prove nothing. The face's rank-2 argument is the
    // real difference: ESUS is the only control on this module that changes
    // what ANOTHER control does (it re-times the delivered T2 stage from
    // 276.313 ms down to 0.021 ms while the T2 dial never moves), so it belongs
    // beside the attack rather than behind the dial it re-times.
    expect(faced[0]).toBe('t1');
    expect(generic[0]).toBe('t1');
    expect(faced[1]).toBe('esus');
    expect(generic[1]).toBe('t2');
  });

  it('moog911a: promotion moved the card GENERIC → FACE, and MODE took encoder 2', () => {
    // THE FACEPLATE QUEUE · Q35. No `PUSH_CARD_CONTROLS` entry, so the FACE tier
    // resolves this card from the moment `moog911a` enters STRICT_FACES.
    // Asserted for the featurecv reason: nothing else here would have noticed.
    const def = defByType('moog911a');
    const faced = pushCardParams(resolvePushCardControls(def, {})).map((p) => p.id);
    const generic = pushCardParams(
      resolvePushCardControls({ ...def, face: undefined }, {}),
    ).map((p) => p.id);
    // A re-ORDER, not a re-pick — three params, well inside the eight encoders.
    expect([...faced].sort()).toEqual([...generic].sort());
    expect(faced, 'the face must actually move the card, or this promotion is decoration')
      .not.toEqual(generic);
    // The face's rank-2 argument, and it is MEASURED: driving TRIG 2 alone gives
    // one pulse in OFF and NONE in PARALLEL or SERIES, so MODE turns an input
    // JACK on and off — it belongs beside the delay it gates rather than behind
    // the one it does not.
    expect(faced[1]).toBe('mode');
    expect(generic[1]).toBe('delay2');
  });

  it('adsr REORDERS the face ranking into ENVELOPE order', () => {
    const ENVELOPE = ['attack', 'decay', 'sustain', 'release'];
    expect(ids('adsr')).toEqual(ENVELOPE);
    // The override earns its keep only if the face does not already say this.
    expect(ids('adsr', {})).not.toEqual(ENVELOPE);
    // …and it is a re-ORDER, not a re-PICK: the same four controls either way.
    expect([...ids('adsr', {})].sort()).toEqual([...ENVELOPE].sort());
  });

  it('cloudseed PINS the preset macro to encoder 1, and re-picks the tank controls', () => {
    // 46 params — by far the widest face, so the override has the most to do.
    //
    // ACCEPT-LOOP (2026-08-02, the cloudseed face rework): `> 0` was the one
    // line here still encoding where the FACE puts the macro, and the face now
    // ranks `preset_index` FIRST too (preset recall is this module's headline
    // gesture). The header two blocks up says exactly why that line had to go:
    // a claim stated as a literal position in `face.order` fails when another
    // file is legitimately edited. Position 0 on the OVERRIDE is the claim.
    expect(ids('cloudseed').indexOf('preset_index'), 'the override pins encoder 1').toBe(0);

    // And it is still not decoration, which is the property `> 0` was really
    // standing in for. Measured: the face card is
    //   preset_index late_out late_line_decay dry_out late_line_size
    //   tap_predelay early_out high_cut
    // and the override is
    //   preset_index late_line_size late_line_decay dry_out early_out
    //   late_out low_cut high_cut
    // — a re-PICK (`tap_predelay` out, `low_cut` in) on top of a re-order, so
    // the override is what puts BOTH cuts on the card. Asserted as the relation
    // rather than as either list, so a further re-curation of either side reads
    // as an accept-loop and not as a Push regression.
    const faced = ids('cloudseed', {});
    expect(faced, 'the face card is not the authored card').not.toEqual(ids('cloudseed'));
    expect(ids('cloudseed'), 'the override puts BOTH tone cuts on the card').toEqual(
      expect.arrayContaining(['low_cut', 'high_cut']),
    );
    expect(faced, '…which the face card does not').not.toContain('low_cut');
  });

  it('tidyVco groups the two oscillators before the filter', () => {
    const OSC = ['shape1', 'shape2', 'mix'];
    expect(ids('tidyVco').slice(0, 3)).toEqual(OSC);
    // The face interleaves osc and filter, so it does NOT open on the osc
    // section — that interleaving is the whole reason the override exists.
    expect(ids('tidyVco', {}).slice(0, 3)).not.toEqual(OSC);
  });

  it('kickdrum keeps the three pitch-envelope controls adjacent, at the head', () => {
    const PITCH = ['tune', 'pitch_amt', 'pitch_time'];
    expect(ids('kickdrum').slice(0, 3)).toEqual(PITCH);
    // The face window does not hand you the trio together. (Today it is the
    // strongest form of "not adjacent" — pitch_time is not in the window at
    // all — but a re-curated face may change WHY this holds without changing
    // WHETHER it holds, which is exactly why this is a relation.)
    const faced = ids('kickdrum', {});
    // NON-VACUITY ANCHOR, kept from #1287's rewrite of this clause. Without it
    // the contrast below would also pass on an EMPTY face window — the same
    // hole that let the previous `indexOf(pitch_time) - indexOf(pitch_amt)`
    // subtract two -1s into -4 and read as position data.
    expect(faced, 'pitch_amt is a lane rank and must be IN the face window').toContain('pitch_amt');
    expect(faced.slice(0, 3)).not.toEqual(PITCH);
  });

  it('SWEEP: every override either changes the card or is a documented restatement', () => {
    // The general form of the four cases above, so a NEW override cannot be
    // added as decoration without either changing something or being declared.
    // Guards the guard: if `resolvePushCardControls` ever stopped honouring the
    // override tier, `changed` would empty out and this would fail on count.
    const RESTATEMENTS = new Set([
      // Two params, one sane order — listed in push-card-config.ts so the card
      // is STATED rather than inferred. Identical to the face by construction.
      'vca',
    ]);
    const changed: string[] = [];
    for (const type of Object.keys(AUTHORED)) {
      const same = ids(type).join() === ids(type, {}).join();
      if (same) expect(RESTATEMENTS, `${type} override matches its face default`).toContain(type);
      else changed.push(type);
    }
    expect(changed.length, 'most overrides must genuinely re-shape the card').toBeGreaterThanOrEqual(
      Object.keys(AUTHORED).length - RESTATEMENTS.size,
    );
  });
});
