// stereo-drop-choice.test.ts — THE WIDTH-MISMATCH CHOOSER.
//
// The owner replaced two silent rows of the commit matrix with a question
// (2026-08-12). This proves the question is asked on EXACTLY those two rows,
// that each offered row commits what it says it commits, and that a row which
// would evict a live cable says so.
//
// ⚠ THE NEGATIVE HALF IS THE HALF THAT MATTERS, twice over:
//
//   * A chooser that fired on EVERY drop would satisfy every "the dialog
//     appears" assertion here. So stereo→stereo, mono→mono, cv and an
//     unresolvable def each get an explicit `toBeNull()`.
//   * A chooser whose rows were hand-written from the matrix would satisfy
//     every "three options" assertion while offering a row the planner refuses
//     to commit. So the rows are checked against `planAudioCommit` itself —
//     including the case where the sibling port is type-incompatible and the
//     row must VANISH rather than appear and do nothing.
//
// The `NEGATIVE CONTROLS` block at the bottom re-implements the pre-owner
// planner (always 'both', never ask) and proves the load-bearing assertions go
// RED against it — so a regression that silently restores the double-patch
// cannot pass this file.

import { describe, it, expect } from 'vitest';
import { planAudioCommit, type StereoDef } from './stereo-autowire';
import { dropChoiceOption, planDropChoice, type DropChoice } from './stereo-drop-choice';
import type { Edge, PortDef } from './types';

function audio(id: string): PortDef {
  return { id, type: 'audio' };
}

// --- fixtures, ids matching real modules and deliberately non-uniform ---

/** clouds — declared in_l/in_r + out_l/out_r. */
const clouds: StereoDef = {
  type: 'clouds',
  inputs: [audio('in_l'), audio('in_r'), { id: 'pitch', type: 'pitch' }],
  outputs: [audio('out_l'), audio('out_r')],
  stereoPairs: [
    ['in_l', 'in_r'],
    ['out_l', 'out_r'],
  ],
};

/** cofefve — inL/inR + outL/outR (the token fallback, no declaration). */
const cofefve: StereoDef = {
  type: 'cofefve',
  inputs: [audio('inL'), audio('inR')],
  outputs: [audio('outL'), audio('outR')],
};

/** A mono oscillator: one output, no pair anywhere. */
const monoOsc: StereoDef = {
  type: 'osc',
  inputs: [{ id: 'pitch', type: 'pitch' }],
  outputs: [audio('out')],
};

/** A mono filter: one audio input, one audio output. */
const monoFilter: StereoDef = {
  type: 'filter',
  inputs: [audio('audio'), { id: 'cutoff_cv', type: 'cv' }],
  outputs: [audio('audio')],
};

/** A CV utility — nothing audio, so nothing can pair. */
const lfo: StereoDef = {
  type: 'lfo',
  inputs: [{ id: 'rate_cv', type: 'cv' }],
  outputs: [{ id: 'out', type: 'cv' }],
};

/** stereovca — cv `strength_l`/`strength_r` carry the L/R token but are NOT
 *  audio, so they must not pair and must not raise a chooser. */
const stereovca: StereoDef = {
  type: 'stereovca',
  inputs: [audio('in_l'), audio('in_r'), { id: 'strength_l', type: 'cv' }, { id: 'strength_r', type: 'cv' }],
  outputs: [audio('out_l'), audio('out_r')],
};

/** A module DECLARING out_l/out_r a pair while out_r is cv. `allStereoPairs`
 *  counts a declared tuple only where BOTH ports are audio on that rail, so
 *  this pairs NOTHING — which is the point: it is the fixture that proves the
 *  chooser inherits that audio-only rule instead of re-reading `stereoPairs`. */
const declaredButNotAudio: StereoDef = {
  type: 'declared-not-audio',
  inputs: [audio('in_l'), audio('in_r')],
  outputs: [audio('out_l'), { id: 'out_r', type: 'cv' }],
  stereoPairs: [['out_l', 'out_r']],
};

/** es9 — a MONO AUDIO POINT module (ids and rails match the live def: `out1..`
 *  are graph INPUTS driving physical jacks, `in1..`/`spdif_*` are outputs). Its
 *  `out1` is the one target where dual-mono was ALREADY refused, so it is the
 *  case where the old behaviour silently picked a side for the user. */
const es9: StereoDef = {
  type: 'es9',
  inputs: [
    { id: 'out1', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
    { id: 'out2', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  ],
  outputs: [audio('in1'), audio('spdif_l'), audio('spdif_r')],
};

function edge(id: string, src: [string, string], dst: [string, string]): Edge {
  return {
    id,
    source: { nodeId: src[0], portId: src[1] },
    target: { nodeId: dst[0], portId: dst[1] },
    sourceType: 'audio',
    targetType: 'audio',
  };
}

function choose(
  over: {
    fromPortId?: string;
    fromDef?: StereoDef;
    toPortId?: string;
    toDef?: StereoDef;
    edges?: Record<string, Edge>;
    sourceType?: 'audio' | 'cv';
    targetType?: 'audio' | 'cv';
  } = {},
): DropChoice | null {
  return planDropChoice({
    fromNodeId: 'src',
    fromPortId: over.fromPortId ?? 'out',
    fromDef: 'fromDef' in over ? over.fromDef : monoOsc,
    toNodeId: 'dst',
    toPortId: over.toPortId ?? 'in_l',
    toDef: 'toDef' in over ? over.toDef : clouds,
    edges: over.edges ?? {},
    sourceType: over.sourceType ?? 'audio',
    targetType: over.targetType ?? 'audio',
  });
}

const modesOf = (c: DropChoice | null) => c?.options.map((o) => o.mode);

// ───────────────────────── WHEN THE QUESTION IS ASKED ─────────────────────────

describe('planDropChoice — exactly the two ambiguous rows ask', () => {
  it('mono → stereo asks L / R / BOTH', () => {
    const c = choose();
    expect(c?.kind).toBe('mono-to-stereo');
    expect(modesOf(c)).toEqual(['left', 'right', 'both']);
    // The pair named is the TARGET's, because that is the side with the image.
    expect(c?.pair).toEqual({ left: 'in_l', right: 'in_r' });
  });

  it('stereo → mono asks WHICH CHANNEL, and offers no BOTH', () => {
    const c = choose({ fromPortId: 'out_l', fromDef: clouds, toPortId: 'audio', toDef: monoFilter });
    expect(c?.kind).toBe('stereo-to-mono');
    expect(
      modesOf(c),
      'the owner asked for a channel, not a width — BOTH is not on offer here',
    ).toEqual(['left', 'right']);
    expect(c?.pair).toEqual({ left: 'out_l', right: 'out_r' });
  });

  it('asks from EITHER clicked leg — dropping on in_r asks the same question', () => {
    // The question is about the PAIR, not about the hole the cable happened to
    // land in, so the option set must not depend on which leg was clicked.
    const onLeft = choose({ toPortId: 'in_l' });
    const onRight = choose({ toPortId: 'in_r' });
    expect(modesOf(onRight)).toEqual(modesOf(onLeft));
    expect(onRight?.pair).toEqual(onLeft?.pair);
  });

  it('works on a TOKEN-derived pair, not just a declared one', () => {
    const c = choose({ toPortId: 'inL', toDef: cofefve });
    expect(c?.kind).toBe('mono-to-stereo');
    expect(c?.pair).toEqual({ left: 'inL', right: 'inR' });
  });
});

describe('planDropChoice — the rows that must NOT ask', () => {
  it('stereo → stereo commits silently', () => {
    expect(choose({ fromPortId: 'out_l', fromDef: clouds, toPortId: 'inL', toDef: cofefve })).toBeNull();
  });

  it('mono → mono commits silently', () => {
    expect(choose({ toPortId: 'audio', toDef: monoFilter })).toBeNull();
  });

  it('a CV cable never asks', () => {
    expect(
      choose({ fromPortId: 'out', fromDef: lfo, toPortId: 'rate_cv', toDef: lfo, sourceType: 'cv', targetType: 'cv' }),
    ).toBeNull();
  });

  it('a CV port carrying an L/R token never asks — pairing is AUDIO-only', () => {
    expect(
      choose({
        fromPortId: 'out',
        fromDef: lfo,
        toPortId: 'strength_l',
        toDef: stereovca,
        sourceType: 'cv',
        targetType: 'cv',
      }),
      'stereovca strength_l/strength_r are two independent cv jacks',
    ).toBeNull();
  });

  it('an UNRESOLVABLE def (a group exposed port) never asks', () => {
    // Undefined ⇒ unpaired ⇒ no question. The safe direction: prompting about
    // a pair nobody can name would be worse than the old silent commit.
    expect(choose({ toDef: undefined })).toBeNull();
    expect(choose({ fromPortId: 'out_l', fromDef: undefined, toPortId: 'audio', toDef: monoFilter })).toBeNull();
  });

  it('a DECLARED tuple whose ports are not both audio does not ask', () => {
    // The chooser must inherit `allStereoPairs`' audio-only rule rather than
    // re-reading `def.stereoPairs`. A re-reading implementation would see a
    // declared pair here and ask a question about a cv jack.
    expect(
      choose({ fromPortId: 'out_l', fromDef: declaredButNotAudio, toPortId: 'audio', toDef: monoFilter }),
    ).toBeNull();
  });

  it('never offers a row that commits nothing', () => {
    // The unconditional form of the "one option is no choice" guard: whatever
    // rows a drop produces, EVERY one of them must plan at least one leg. A
    // dialog row that writes no edge is a button that does nothing, and it
    // would be indistinguishable from a cancelled drop.
    const drops: [string, Parameters<typeof choose>[0]][] = [
      ['mono → stereo (declared)', {}],
      ['mono → stereo (token)', { toPortId: 'inL', toDef: cofefve }],
      ['mono → stereo on the R leg', { toPortId: 'in_r' }],
      ['stereo → mono', { fromPortId: 'out_l', fromDef: clouds, toPortId: 'audio', toDef: monoFilter }],
      ['stereo → mono from the R leg', { fromPortId: 'out_r', fromDef: clouds, toPortId: 'audio', toDef: monoFilter }],
      ['stereo → mono AUDIO POINT (es9)', { fromPortId: 'out_l', fromDef: clouds, toPortId: 'out1', toDef: es9 }],
    ];
    const empty: string[] = [];
    for (const [name, over] of drops) {
      const c = choose(over);
      expect(c, `${name} must ask`).not.toBeNull();
      for (const opt of c!.options) {
        if (opt.toPortIds.length === 0 || opt.fromPortIds.length === 0) empty.push(`${name}/${opt.mode}`);
      }
    }
    expect(empty).toEqual([]);
  });
});

// ─────────────────── WHAT EACH ROW ACTUALLY COMMITS ───────────────────

describe('planDropChoice — a row describes the patch it makes', () => {
  it('mono → stereo: L writes only the L leg, R only the R, BOTH writes two', () => {
    const c = choose()!;
    expect(dropChoiceOption(c, 'left')).toMatchObject({
      toPortIds: ['in_l'],
      fromPortIds: ['out'],
    });
    expect(dropChoiceOption(c, 'right')).toMatchObject({
      toPortIds: ['in_r'],
      fromPortIds: ['out'],
    });
    expect(dropChoiceOption(c, 'both')).toMatchObject({
      toPortIds: ['in_l', 'in_r'],
      fromPortIds: ['out'],
    });
  });

  it('stereo → mono: each row reads ONE source leg into the one mono input', () => {
    const c = choose({ fromPortId: 'out_l', fromDef: clouds, toPortId: 'audio', toDef: monoFilter })!;
    expect(dropChoiceOption(c, 'left')).toMatchObject({
      fromPortIds: ['out_l'],
      toPortIds: ['audio'],
    });
    expect(dropChoiceOption(c, 'right')).toMatchObject({
      fromPortIds: ['out_r'],
      toPortIds: ['audio'],
    });
  });

  it('stereo → an ES-9 physical jack asks instead of picking the clicked side', () => {
    // The MONO AUDIO POINT trim already refused to sum two legs into one
    // hardware jack — it kept the CLICKED leg and dropped the other, silently.
    // That was the app choosing a channel for the user. Now the user chooses.
    const fromL = choose({ fromPortId: 'out_l', fromDef: clouds, toPortId: 'out1', toDef: es9 })!;
    expect(modesOf(fromL)).toEqual(['left', 'right']);
    expect(dropChoiceOption(fromL, 'left')).toMatchObject({ fromPortIds: ['out_l'], toPortIds: ['out1'] });
    expect(dropChoiceOption(fromL, 'right')).toMatchObject({ fromPortIds: ['out_r'], toPortIds: ['out1'] });

    // …and dropping the R leg on the same jack offers the same two rows, so
    // which hole the cable landed in no longer decides the channel.
    const fromR = choose({ fromPortId: 'out_r', fromDef: clouds, toPortId: 'out1', toDef: es9 })!;
    expect(dropChoiceOption(fromR, 'left')).toMatchObject({ fromPortIds: ['out_l'] });
    expect(dropChoiceOption(fromR, 'right')).toMatchObject({ fromPortIds: ['out_r'] });
  });

  it('every row agrees with planAudioCommit on the SAME mode — one computation', () => {
    // The rows must not be a second opinion. Re-plan each mode independently
    // and require the row to match, so a row can never advertise a patch the
    // commit would not make.
    const args = {
      fromNodeId: 'src',
      fromPortId: 'out',
      fromDef: monoOsc,
      toNodeId: 'dst',
      toPortId: 'in_l',
      toDef: clouds,
      edges: {},
      sourceType: 'audio' as const,
      targetType: 'audio' as const,
    };
    const c = planDropChoice(args)!;
    for (const opt of c.options) {
      const plan = planAudioCommit({ ...args, channelMode: opt.mode });
      expect([...new Set(plan.legs.map((l) => l.toPortId))], `mode ${opt.mode}`).toEqual(opt.toPortIds);
      expect([...new Set(plan.legs.map((l) => l.fromPortId))], `mode ${opt.mode}`).toEqual(opt.fromPortIds);
      expect(plan.replaceEdgeIds, `mode ${opt.mode}`).toEqual(opt.replaceEdgeIds);
    }
  });
});

// ─────────────── THE ALREADY-PATCHED JACK (the destructive drop) ───────────────

describe('planDropChoice — an occupied jack says what each row costs', () => {
  // A live STEREO cable already seated on the target pair, from some other
  // source. This is the measured bug: a second drop used to evict both legs
  // with no notice at all.
  const occupied: Record<string, Edge> = {
    'e-a-out_l-dst-in_l': edge('e-a-out_l-dst-in_l', ['a', 'out_l'], ['dst', 'in_l']),
    'e-a-out_r-dst-in_r': edge('e-a-out_r-dst-in_r', ['a', 'out_r'], ['dst', 'in_r']),
  };

  it('flags that something will be destroyed', () => {
    const c = choose({ edges: occupied })!;
    expect(c.destroys, 'the whole point of surfacing it').toBe(true);
    expect(choose()!.destroys, 'an empty rack destroys nothing').toBe(false);
  });

  it('names the EXACT edges each row evicts — L takes only the L leg', () => {
    const c = choose({ edges: occupied })!;
    expect(dropChoiceOption(c, 'left')!.replaceEdgeIds).toEqual(['e-a-out_l-dst-in_l']);
    expect(dropChoiceOption(c, 'right')!.replaceEdgeIds).toEqual(['e-a-out_r-dst-in_r']);
    expect(
      dropChoiceOption(c, 'both')!.replaceEdgeIds,
      'BOTH is the row that costs the whole cable, and it must say so',
    ).toEqual(['e-a-out_l-dst-in_l', 'e-a-out_r-dst-in_r']);
  });

  it('a row that lands on a FREE leg costs nothing — so the flag is not "is anything patched"', () => {
    // Only the LEFT leg is occupied. Choosing R must report an empty cost, or
    // `destroys` degenerates into "this card has a cable somewhere".
    const halfOccupied = { 'e-a-out_l-dst-in_l': occupied['e-a-out_l-dst-in_l']! };
    const c = choose({ edges: halfOccupied })!;
    expect(dropChoiceOption(c, 'right')!.replaceEdgeIds).toEqual([]);
    expect(dropChoiceOption(c, 'left')!.replaceEdgeIds).toEqual(['e-a-out_l-dst-in_l']);
    expect(c.destroys).toBe(true);
  });

  it('re-patching the SAME cable evicts nothing (the plan keeps its own legs)', () => {
    const same: Record<string, Edge> = {
      'e-src-out-dst-in_l': edge('e-src-out-dst-in_l', ['src', 'out'], ['dst', 'in_l']),
    };
    const c = choose({ edges: same })!;
    expect(dropChoiceOption(c, 'left')!.replaceEdgeIds).toEqual([]);
    expect(dropChoiceOption(c, 'both')!.replaceEdgeIds).toEqual([]);
  });

  it('stereo → mono surfaces the cable already on the mono input', () => {
    const onMono: Record<string, Edge> = {
      'e-a-out-dst-audio': edge('e-a-out-dst-audio', ['a', 'out'], ['dst', 'audio']),
    };
    const c = choose({
      fromPortId: 'out_l',
      fromDef: clouds,
      toPortId: 'audio',
      toDef: monoFilter,
      edges: onMono,
    })!;
    expect(c.destroys).toBe(true);
    for (const opt of c.options) {
      expect(opt.replaceEdgeIds, `mode ${opt.mode}`).toEqual(['e-a-out-dst-audio']);
    }
  });
});

// ───────────────────────────── NEGATIVE CONTROLS ─────────────────────────────
//
// Re-implement the behaviour this feature REPLACED — "never ask, always both" —
// and prove the load-bearing assertions above go RED against it. Without this,
// a regression that deletes the chooser and restores the silent double-patch
// would only turn the e2e red, and only if the e2e was still wired to the
// dialog. Here it cannot even reach CI.

/** The pre-owner planner: a chooser that never fires. */
function neverAsk(): DropChoice | null {
  return null;
}

/** A chooser that fires on everything — the OTHER failure direction, and the
 *  one a "the dialog appears" test cannot see. */
function alwaysAsk(): DropChoice {
  return {
    kind: 'mono-to-stereo',
    pair: { left: 'in_l', right: 'in_r' },
    options: [
      { mode: 'left', toPortIds: ['in_l'], fromPortIds: ['out'], replaceEdgeIds: [] },
      { mode: 'right', toPortIds: ['in_r'], fromPortIds: ['out'], replaceEdgeIds: [] },
      { mode: 'both', toPortIds: ['in_l', 'in_r'], fromPortIds: ['out'], replaceEdgeIds: [] },
    ],
    destroys: false,
  };
}

describe('NEGATIVE CONTROLS — the assertions can fail', () => {
  it('a planner that never asks fails the mono → stereo case', () => {
    expect(() => expect(neverAsk()?.kind).toBe('mono-to-stereo')).toThrow();
    expect(() => expect(modesOf(neverAsk())).toEqual(['left', 'right', 'both'])).toThrow();
  });

  it('a planner that never asks fails the stereo → mono case', () => {
    expect(() => expect(neverAsk()?.kind).toBe('stereo-to-mono')).toThrow();
  });

  it('a planner that always asks fails every must-not-ask row', () => {
    expect(() => expect(alwaysAsk()).toBeNull()).toThrow();
  });

  it('a chooser blind to occupancy fails the already-patched case', () => {
    // `alwaysAsk` reports `destroys: false` and empty costs — exactly what a
    // dialog built without reading the live edge set would report.
    expect(() => expect(alwaysAsk().destroys).toBe(true)).toThrow();
    expect(() =>
      expect(dropChoiceOption(alwaysAsk(), 'both')!.replaceEdgeIds).toEqual([
        'e-a-out_l-dst-in_l',
        'e-a-out_r-dst-in_r',
      ]),
    ).toThrow();
  });
});
