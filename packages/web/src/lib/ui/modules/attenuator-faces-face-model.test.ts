// packages/web/src/lib/ui/modules/attenuator-faces-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind the ATTENUATOR faceplates — the two
// passive Moog level panels faced in batch 18.
//
// WHY THESE TWO TOGETHER. They are the cleanest statement in the batch of the
// ONE-PORT METER rule, because they differ in exactly the respect the rule is
// about and in almost nothing else. Both are passive attenuator banks; both are
// a row of identical knobs; both declare `glyph: 'none'`. But:
//
//   · `moog995` HAS a live binding available — `out1` is an `audio` port, so a
//     meter would resolve `live-audio` — and REFUSES it, because its three
//     channels are INDEPENDENT (in_N → gain → out_N, no summing anywhere). A
//     rack patched through channel 2 or 3 alone would see a flat meter over a
//     module passing signal perfectly well: a false SILENCE.
//   · `moog992` SUMS its four channels into one `cv_out`, so it has no
//     independence problem at all — it simply has no audio output, and its
//     `none` is FORCED.
//
// So one is a JUDGEMENT and one is a CONSTRAINT, and the declaration is the
// same word in both files. That is what this file makes falsifiable.
//
// ⚠ THE TEST FOR THE JUDGEMENT IS INDEPENDENCE, NOT PORT COUNT. `moog903a`
// (group 2) also has a one-port meter over two audio outputs and KEEPS it,
// because white and pink are the same generator at different filter slopes.
// Channel 1 of an attenuator bank represents nothing but channel 1.
//
// ⚠ THESE ARE MODEL ASSERTIONS, NOT PIXEL ONES.

import { describe, expect, it } from 'vitest';

import { moog992Def } from '$lib/audio/modules/moog992';
import { moog995Def } from '$lib/audio/modules/moog995';
import { dockFacePlan } from '$lib/ui/workflow/curated-face';
import { paramCellKind } from '$lib/ui/workflow/shell-control-kind';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import type { ParamDef } from '$lib/graph/types';

const NO_MOMENTARY: ReadonlySet<string> = new Set();

const ATTENUATORS = [
  { type: 'moog992', def: moog992Def, order: ['atten1', 'atten2', 'atten3', 'atten4'] },
  { type: 'moog995', def: moog995Def, order: ['atten1', 'atten2', 'atten3'] },
] as const;

describe('attenuator faces — promotion, ranking and honest bands', () => {
  it('each is PROMOTED, ranks every channel in order, and plans exactly ONE band', () => {
    for (const { type, def, order } of ATTENUATORS) {
      expect(STRICT_FACES.has(type), `${type} promoted`).toBe(true);
      expect(def.face?.order, `${type} order`).toEqual(order);
      // Channel order is the ranking — asserted against the def's own roster so
      // a new channel cannot be added without being ranked.
      expect(def.params.map((p) => p.id), `${type} params`).toEqual(order);
      const plan = dockFacePlan(def as never);
      expect(plan, `${type}: planned as UN-FACED`).not.toBeNull();
      expect(plan!.length, `${type}: dock bands (the roster's \`pages\`)`).toBe(1);
    }
  });

  it('every channel is a plain KNOB at unity by default — a fresh panel is transparent', () => {
    // The rest state of these modules is a property of their DEFAULTS: a
    // freshly spawned attenuator passes a direct patch unaltered. If a default
    // ever moves, this reddens before the face's own comments go stale.
    for (const { type, def } of ATTENUATORS) {
      for (const p of def.params as readonly ParamDef[]) {
        expect(p.defaultValue, `${type}.${p.id} default`).toBe(1);
        expect(p.min).toBe(0);
        expect(p.max).toBe(1);
        expect(p.curve).toBe('linear');
        expect(p.options, `${type}.${p.id} must not declare a roster`).toBeUndefined();
        expect(paramCellKind(p, NO_MOMENTARY, 'dock')).toBe('knob');
      }
    }
  });

  it('NO face here declares paramCells, pages, bareCells, a hero or a title', () => {
    // `bareCells` in particular: the per-channel captions ("Att 1".."Att 4")
    // STAY. They are the only thing separating otherwise-identical knobs, which
    // is the tidyVco A/D/S/R case, not the mixmstrs one — and no section
    // heading conveys the channel number, because there are no sections.
    const problems: string[] = [];
    for (const { type, def } of ATTENUATORS) {
      const f = def.face as Record<string, unknown> | undefined;
      for (const field of ['paramCells', 'momentary', 'pages', 'hero', 'title', 'hint', 'xyPads', 'bareCells', 'extension', 'tabbed']) {
        if (f && f[field] !== undefined) problems.push(`${type}: declares face.${field}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('attenuator faces — the ONE-PORT METER rule, both directions', () => {
  it('both declare no glyph, and both resolve to no binding', () => {
    for (const { type, def } of ATTENUATORS) {
      expect(def.face?.glyph, `${type} declared glyph`).toBe('none');
      expect(glyphBinding(def as never).kind, `${type} binding`).toBe('none');
    }
  });

  it('moog995: the refusal is a JUDGEMENT — a meter WOULD bind live here', () => {
    // If this ever starts resolving `static`, the justification in the def has
    // silently become wrong: the comment says "we are declining an available
    // picture", and that claim is only true while the picture is available.
    expect(primaryAudioOutPortId(moog995Def as never)).toBe('out1');
    const withMeter = { ...moog995Def, face: { ...moog995Def.face!, glyph: 'meter' } };
    expect(glyphBinding(withMeter as never).kind).toBe('live-audio');

    // …and the reason it is declined: the channels are INDEPENDENT. One input
    // and one output per channel, no summing node anywhere, so no single port
    // represents the module.
    expect(moog995Def.inputs.map((i) => i.id)).toEqual(['in1', 'in2', 'in3']);
    expect(moog995Def.outputs.map((o) => o.id)).toEqual(['out1', 'out2', 'out3']);
    expect(moog995Def.outputs.every((o) => o.type === 'audio')).toBe(true);
  });

  it('moog992: the refusal is FORCED — it SUMS, and the sum is not audio', () => {
    // The complementary shape: many inputs, ONE output, so there is no
    // independence problem to reason about at all. It just has no audio port.
    expect(moog992Def.inputs).toHaveLength(4);
    expect(moog992Def.outputs.map((o) => o.id)).toEqual(['cv_out']);
    expect(primaryAudioOutPortId(moog992Def as never)).toBeNull();

    const withMeter = { ...moog992Def, face: { ...moog992Def.face!, glyph: 'meter' } };
    expect(glyphBinding(withMeter as never).kind).toBe('static');
  });

  it('NEGATIVE CONTROL: the two refusals are NOT the same fact', () => {
    // The whole point of pairing them. If a future edit made these two modules
    // agree — by giving the 992 an audio out, or the 995 a summed one — this
    // clause fails and the reasoning in both defs needs re-reading.
    const bindingUnderMeter = (def: typeof moog992Def) =>
      glyphBinding({ ...def, face: { ...def.face!, glyph: 'meter' } } as never).kind;

    expect(bindingUnderMeter(moog995Def)).toBe('live-audio');
    expect(bindingUnderMeter(moog992Def)).toBe('static');
    expect(bindingUnderMeter(moog995Def)).not.toBe(bindingUnderMeter(moog992Def));
  });
});
