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
import type { ParamDef } from '$lib/graph/types';
import { momentaryParamIds } from '$lib/ui/workflow/shell-control-kind';

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
      const valid = params
        .filter((q) => isTurnable(q) && !momentary.has(q.id))
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
    // karplus has no override; its face ranks 8 params, all turnable.
    expect(ids('karplus')).toEqual([
      'decay', 'brightness', 'tune', 'color', 'burst', 'position', 'stiffness', 'level',
    ]);
    expect(resolvePushCardControls(defByType('karplus')).source).toBe('face');
  });

  it('SKIPS a control family and keeps walking — it does not stop at rank 1', () => {
    // sixstrum's face ranks its PRESET family 7th. The window must step over
    // it and pull rank 8 in, not come back one control short.
    const spec = resolvePushCardControls(defByType('sixstrum'));
    expect(spec.source).toBe('face');
    expect(spec.skipped).toEqual(['sixstrum-preset-{n}']);
    expect(pushCardParams(spec)).toHaveLength(8);
    expect(pushCardParams(spec).map((q) => q.id)).toEqual([
      'strumSpread', 'ring', 'material', 'pickTone', 'muteDepth', 'register', 'strumDir', 'tuning',
    ]);
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
    // charlottesEchos carries no face, so it is a real generic-audio card.
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

  it('only a module with NO turnable params ends up with a blank card', () => {
    const blank: string[] = [];
    for (const def of allDefs()) {
      if (pushCardParams(resolvePushCardControls(def)).length === 0) blank.push(def.type);
    }
    // The 21 port-only / DOM-only modules (clocked-runner, midi-lane, painter,
    // videoOut, the meta widgets, …) genuinely have no ParamDefs at all.
    const noParams = allDefs().filter((d) => (d.params ?? []).length === 0).map((d) => d.type);
    expect(blank.sort()).toEqual(noParams.sort());
  });

  it('every faced module resolves through the override or face tier', () => {
    for (const def of allDefs()) {
      if (!def.face) continue;
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

  // ⚠ THE THREE ASSERTIONS BELOW READ THE **FACE** RANKING (`ids(type, {})` —
  // no override), which is NOT this file's to author: it is `def.face.order`,
  // and a face rework moves it. All three were pinned against the PRE-face-
  // rework defs and went red the moment #1276 (adsr, "release-first"), #1273
  // (tidyVco, "CUTOFF leads, PW demoted") and #1277 (kickdrum, 5 bands) landed
  // — three PRs that never touched this file, so nothing conflicted and the
  // breakage reached main. This is the hazard CLAUDE.md states on
  // PUSH_CARD_CONTROLS ("a push card is resolved from the LIVE def, so adding
  // or renaming a param on ANY module can silently change that module's push
  // card") arriving through the back door: not the AUTHORED card (an override
  // REPLACES, so those goldens held green throughout) but the face-derived
  // baseline each one is contrasted against.
  //
  // So when one of these fails, the question is NOT "what does the face print
  // now" — it is "does the OVERRIDE still buy what its comment claims". Re-pin
  // the face side, then re-read the contrast. Pasting the actual value without
  // that second step turns a live negative control into decoration.

  it('adsr reorders the face ranking into ENVELOPE order', () => {
    // The face leads with RELEASE (#1276: the control you reach for first on a
    // pad patch). The Push card wants the ADSR mnemonic instead, because four
    // encoders left-to-right under the labels A/D/S/R is the reading order the
    // hardware itself implies.
    expect(ids('adsr', {})).toEqual(['release', 'attack', 'sustain', 'decay']);
    expect(ids('adsr')).toEqual(['attack', 'decay', 'sustain', 'release']);
  });

  it('cloudseed promotes the preset macro from rank 8 to encoder 1', () => {
    expect(ids('cloudseed', {}).indexOf('preset_index')).toBe(7);
    expect(ids('cloudseed').indexOf('preset_index')).toBe(0);
  });

  it('tidyVco groups the two oscillators before the filter', () => {
    // #1273 put CUTOFF first and demoted PW, so the face's 8-encoder window is
    // filter-led — and `shape2` / `mix` fall outside it ENTIRELY (ranks 9 and
    // 10 of 25). The override is therefore not a re-shuffle of the same eight:
    // it puts the second oscillator on the card at all, which is the whole
    // claim in this test's name.
    expect(ids('tidyVco', {})).toEqual([
      'cutoff', 'shape1', 'res', 'detune', 'oct2', 'pw', 'fold', 'env',
    ]);
    const faced = ids('tidyVco', {});
    expect(faced).not.toContain('shape2');
    expect(faced).not.toContain('mix');
    expect(ids('tidyVco').slice(0, 3)).toEqual(['shape1', 'shape2', 'mix']);
  });

  it('kickdrum keeps the three pitch-envelope controls adjacent', () => {
    expect(ids('kickdrum').slice(0, 3)).toEqual(['tune', 'pitch_amt', 'pitch_time']);
    // The face window does not merely SEPARATE the pitch pair — since #1277 it
    // drops `pitch_time` off the card completely (rank 11 of 26, past the 8
    // encoders), so the authored order is what makes the pitch envelope
    // adjustable from the hardware at all. Asserted as absence + distance
    // rather than as a signed index gap: the old `indexOf - indexOf > 1` read
    // -1 for "missing" and quietly compared it as a position, which is how a
    // dropped control could have passed as a merely-reordered one.
    const faced = ids('kickdrum', {});
    expect(faced).toContain('pitch_amt');
    expect(faced).not.toContain('pitch_time');
  });
});
