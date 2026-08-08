// stereo-autowire.test.ts — the UNIVERSAL AUDIO COMMIT PLANNER.
//
// Drives the planner with hand-built defs (naming deliberately non-uniform:
// in_l/in_r, inL/inR, L/R, odd/even, mix_l/mix_r) so the naming-agnostic
// derivation is exercised across the real module conventions.
//
// THE FOUR ROWS OF THE POLICY MATRIX EACH GET AN EXPLICIT ASSERT, and the
// stereo→mono DUAL-MONO row gets its first anywhere in the repo:
//
//   stereo → stereo   L→L, R→R
//   mono   → stereo   the one out double-patched into both target legs
//   stereo → mono     BOTH legs into the mono input (NOT a sum, NOT one leg)
//   mono   → mono     one leg
//
// ⚠ The stereo→mono row is asserted in BOTH directions: that two legs are
// written, AND that no round-trip / same-signal special case collapses them to
// one. The pre-reversal design had exactly such a case, and a planner that
// re-grew it would still satisfy "an edge was written" — so the negative half
// is the half that matters. See `NEGATIVE CONTROLS` at the bottom, which
// re-implements the collapsing planner and proves each assert goes RED on it.

import { describe, it, expect } from 'vitest';
import {
  audioEdgeId,
  expandLegGroups,
  findStereoSibling,
  legChannelOfEdge,
  planAudioCommit,
  siblingLegIds,
  type PlanAudioCommitArgs,
  type PlannedLeg,
  type StereoDef,
} from './stereo-autowire';
import type { Edge, PortDef } from './types';

function audio(id: string): PortDef {
  return { id, type: 'audio' };
}

// --- Real-module-shaped fixtures (ids match the live defs) ---

// clouds — in_l/in_r + out_l/out_r, both pairs declared.
const clouds: StereoDef = {
  type: 'clouds',
  inputs: [audio('in_l'), audio('in_r'), { id: 'pitch', type: 'pitch' }],
  outputs: [audio('out_l'), audio('out_r')],
  stereoPairs: [
    ['in_l', 'in_r'],
    ['out_l', 'out_r'],
  ],
};

// cofefve — inL/inR + outL/outR.
const cofefve: StereoDef = {
  type: 'cofefve',
  inputs: [audio('inL'), audio('inR'), { id: 'clock', type: 'gate' }],
  outputs: [audio('outL'), audio('outR')],
  stereoPairs: [
    ['inL', 'inR'],
    ['outL', 'outR'],
  ],
};

// charlottes-echos — L/R reused for BOTH inputs and outputs. The reason
// stereo-pairs resolves PER DIRECTION.
const charlottesEchos: StereoDef = {
  type: 'charlottesEchos',
  inputs: [audio('L'), audio('R'), { id: 'delay', type: 'cv' }],
  outputs: [audio('L'), audio('R')],
  stereoPairs: [['L', 'R']],
};

// rings — mono input `in`, declared OUTPUT pair odd/even. odd/even is in
// COLLAPSE_EXEMPT (two timbres, not two sides) but that list governs JACK
// COLLAPSE only; autowire keeps reading the declaration, which is shipped
// behaviour pinned by e2e/tests/stereo-autowire.spec.ts.
const rings: StereoDef = {
  type: 'rings',
  inputs: [audio('in'), { id: 'pitch', type: 'pitch' }],
  outputs: [audio('odd'), audio('even')],
  stereoPairs: [['odd', 'even']],
};

// A mono FX insert — ONE audio in, ONE audio out. 21 live modules have exactly
// this shape (filter, delay, reverb, vca, the moog rack …) and they are the
// pass-through spine of most patches, which is why the stereo→mono row matters.
const monoFilter: StereoDef = {
  type: 'filter',
  inputs: [audio('audio'), { id: 'cutoff', type: 'cv' }],
  outputs: [audio('audio')],
};

// A mono oscillator-style source — single `out`, no pair of any kind.
const monoOsc: StereoDef = {
  type: 'analogVco',
  inputs: [{ id: 'pitch', type: 'pitch' }],
  outputs: [audio('out')],
};

// A synthetic FDN: stereo OUTPUT pair mix_l/mix_r among 4 mono outs.
const fdnQuad: StereoDef = {
  type: 'fdnQuad',
  inputs: [audio('in1'), audio('in2'), audio('in3'), audio('in4')],
  outputs: [
    audio('out1'),
    audio('out2'),
    audio('out3'),
    audio('out4'),
    audio('mix_l'),
    audio('mix_r'),
  ],
  stereoPairs: [['mix_l', 'mix_r']],
};

// A CV utility — nothing here is audio, so nothing here can pair.
const lfo: StereoDef = {
  type: 'lfo',
  inputs: [{ id: 'rate_cv', type: 'cv' }],
  outputs: [{ id: 'out', type: 'cv' }],
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

/** `[channel, fromPort, toPort]` per leg — the shape every matrix assert reads. */
function shape(legs: PlannedLeg[]): [string, string, string][] {
  return legs.map((l) => [l.channel, l.fromPortId, l.toPortId]);
}

function plan(over: Partial<PlanAudioCommitArgs> = {}) {
  return planAudioCommit({
    fromNodeId: 'src',
    fromPortId: 'out_l',
    fromDef: clouds,
    toNodeId: 'dst',
    toPortId: 'inL',
    toDef: cofefve,
    edges: {},
    sourceType: 'audio',
    targetType: 'audio',
    ...over,
  });
}

// ────────────────────────────── THE MATRIX ──────────────────────────────

describe('planAudioCommit — the policy matrix', () => {
  it('stereo → stereo writes L→L and R→R', () => {
    expect(shape(plan().legs)).toEqual([
      ['left', 'out_l', 'inL'],
      ['right', 'out_r', 'inR'],
    ]);
  });

  it('mono → stereo DOUBLE-PATCHES the one output into both target legs', () => {
    const p = plan({ fromPortId: 'out', fromDef: monoOsc });
    expect(shape(p.legs)).toEqual([
      ['left', 'out', 'inL'],
      ['right', 'out', 'inR'],
    ]);
  });

  it('stereo → MONO writes BOTH legs into the mono input (DUAL-MONO)', () => {
    // The row the 2026-08-07 reversal created. A mono module fed a stereo leg
    // group receives BOTH channels; PR-3b's engine wrapper then runs its DSP
    // twice, one instance per channel.
    const p = plan({ toPortId: 'audio', toDef: monoFilter });
    expect(shape(p.legs)).toEqual([
      ['left', 'out_l', 'audio'],
      ['right', 'out_r', 'audio'],
    ]);
  });

  it('mono → mono writes exactly ONE leg', () => {
    const p = plan({
      fromPortId: 'out',
      fromDef: monoOsc,
      toPortId: 'audio',
      toDef: monoFilter,
    });
    expect(shape(p.legs)).toEqual([['mono', 'out', 'audio']]);
  });
});

describe('stereo → mono: NO round-trip special case survives', () => {
  // The pre-reversal design collapsed a leg group back to ONE leg when it
  // judged the two legs to be the same mono signal, so a correlated sum would
  // not gain +6 dB. Dual-mono never sums, and §0b bans the heuristic by name.
  // These asserts are the ones a re-grown collapse has to break.

  it('does not collapse when BOTH legs originate from one mono source upstream', () => {
    // The exact round-trip shape: `osc` (mono) was double-patched into clouds'
    // in_l/in_r, so clouds' out_l and out_r carry a correlated signal. Patching
    // clouds into a MONO filter must STILL write two legs — the planner has no
    // way to know they are correlated, and must not acquire one.
    const upstream = {
      a: edge('a', ['osc', 'out'], ['src', 'in_l']),
      b: edge('b', ['osc', 'out'], ['src', 'in_r']),
    };
    const p = plan({ toPortId: 'audio', toDef: monoFilter, edges: upstream });
    expect(p.legs).toHaveLength(2);
    expect(shape(p.legs)).toEqual([
      ['left', 'out_l', 'audio'],
      ['right', 'out_r', 'audio'],
    ]);
  });

  it('writes two DISTINCT edge ids for the two legs on one mono input', () => {
    // Both legs land on the SAME target port, so only the SOURCE port keeps
    // them apart. A collapse that deduped on the target endpoint would produce
    // one id here and look like a legitimate de-dup.
    const p = plan({ toPortId: 'audio', toDef: monoFilter });
    const ids = p.legs.map((l) => l.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual([
      audioEdgeId('src', 'out_l', 'dst', 'audio'),
      audioEdgeId('src', 'out_r', 'dst', 'audio'),
    ]);
  });

  it('does not collapse when the SAME node is both source and target (a real round trip)', () => {
    const p = plan({
      fromNodeId: 'n1',
      toNodeId: 'n1',
      fromPortId: 'L',
      fromDef: charlottesEchos,
      toPortId: 'L',
      toDef: charlottesEchos,
    });
    expect(shape(p.legs)).toEqual([
      ['left', 'L', 'L'],
      ['right', 'R', 'R'],
    ]);
  });
});

// ─────────────────────────── naming-agnosticism ───────────────────────────

describe('planAudioCommit — pairing is naming-agnostic and per-direction', () => {
  it('rings odd/even → cofefve inL/inR (declared, non-L/R names)', () => {
    const p = plan({ fromPortId: 'odd', fromDef: rings });
    expect(shape(p.legs)).toEqual([
      ['left', 'odd', 'inL'],
      ['right', 'even', 'inR'],
    ]);
  });

  it('clouds out_l → charlottes-echos L (the target reuses L/R on BOTH rails)', () => {
    const p = plan({ toPortId: 'L', toDef: charlottesEchos });
    expect(shape(p.legs)).toEqual([
      ['left', 'out_l', 'L'],
      ['right', 'out_r', 'R'],
    ]);
  });

  it('an id-token pair with NO declaration still pairs (mixmstrs-style chNL/chNR)', () => {
    const mixer: StereoDef = {
      type: 'mixmstrs',
      inputs: [audio('ch1L'), audio('ch1R'), audio('ch2L'), audio('ch2R')],
      outputs: [audio('masterL'), audio('masterR')],
    };
    const p = plan({ toPortId: 'ch2L', toDef: mixer });
    expect(shape(p.legs)).toEqual([
      ['left', 'out_l', 'ch2L'],
      ['right', 'out_r', 'ch2R'],
    ]);
  });

  it('the R side anchors just as well as the L side', () => {
    const p = plan({ fromPortId: 'out_r', toPortId: 'inR' });
    expect(shape(p.legs)).toEqual([
      ['left', 'out_l', 'inL'],
      ['right', 'out_r', 'inR'],
    ]);
  });

  it('a deliberate CROSS-patch keeps the clicked leg and mirrors the other', () => {
    // out_r → inL is what the user did; the planner never "corrects" it. The
    // sibling is then out_l → inR, which is the same stereo cable, swapped.
    const p = plan({ fromPortId: 'out_r', toPortId: 'inL' });
    expect(p.legs.find((l) => l.clicked)).toMatchObject({
      fromPortId: 'out_r',
      toPortId: 'inL',
    });
    expect(shape(p.legs)).toEqual([
      ['left', 'out_l', 'inR'],
      ['right', 'out_r', 'inL'],
    ]);
  });

  it('an unpaired audio port among paired ones stays a single leg (fdn out1)', () => {
    const p = plan({
      fromPortId: 'out1',
      fromDef: fdnQuad,
      toPortId: 'audio',
      toDef: monoFilter,
    });
    expect(shape(p.legs)).toEqual([['mono', 'out1', 'audio']]);
  });

  it('NON-AUDIO cables never pair — a cv patch is always one leg', () => {
    const p = plan({
      fromPortId: 'out',
      fromDef: lfo,
      toPortId: 'cutoff',
      toDef: monoFilter,
      sourceType: 'cv',
      targetType: 'cv',
    });
    expect(shape(p.legs)).toEqual([['mono', 'out', 'cutoff']]);
  });

  it('an endpoint with NO def (a group exposed port) is treated as unpaired', () => {
    const p = plan({ fromDef: undefined });
    expect(shape(p.legs)).toEqual([['left', 'out_l', 'inL']]);
    // …and the clicked leg keeps the cable types the caller resolved through
    // the exposed-port seam, which no def read could reproduce.
    expect(p.legs[0]).toMatchObject({ sourceType: 'audio', targetType: 'audio' });
  });
});

describe('planAudioCommit — the sibling leg must be REAL and COMPATIBLE', () => {
  it('drops the sibling when the paired port is missing from the rail', () => {
    // Declares out_l/out_r but only ships out_l — the sibling cannot be built.
    const broken: StereoDef = {
      type: 'broken',
      inputs: [],
      outputs: [audio('out_l')],
      stereoPairs: [['out_l', 'out_r']],
    };
    const p = plan({ fromPortId: 'out_l', fromDef: broken });
    // The target is still a pair, so the mono source double-patches instead.
    expect(shape(p.legs)).toEqual([
      ['left', 'out_l', 'inL'],
      ['right', 'out_l', 'inR'],
    ]);
  });

  it('drops the sibling when its types are incompatible', () => {
    // in_r is CV-typed, so the declared tuple is not an AUDIO pair at all and
    // stereo-pairs refuses it — the target reads as unpaired.
    const halfCv: StereoDef = {
      type: 'halfCv',
      inputs: [audio('in_l'), { id: 'in_r', type: 'cv' }],
      outputs: [],
      stereoPairs: [['in_l', 'in_r']],
    };
    const p = plan({ toPortId: 'in_l', toDef: halfCv });
    expect(shape(p.legs)).toEqual([
      ['left', 'out_l', 'in_l'],
      ['right', 'out_r', 'in_l'],
    ]);
  });
});

// ─────────────────────────────── channelMode ───────────────────────────────

describe('planAudioCommit — channelMode selects legs (PR-4 only-L / only-R)', () => {
  it('left keeps only the L leg', () => {
    expect(shape(plan({ channelMode: 'left' }).legs)).toEqual([['left', 'out_l', 'inL']]);
  });

  it('right keeps only the R leg', () => {
    expect(shape(plan({ channelMode: 'right' }).legs)).toEqual([['right', 'out_r', 'inR']]);
  });

  it('selects by CHANNEL, not by which port was clicked', () => {
    // Clicked out_l; asked for R. The R leg is what gets written, even though
    // it is the leg the user did not touch.
    expect(shape(plan({ fromPortId: 'out_l', channelMode: 'right' }).legs)).toEqual([
      ['right', 'out_r', 'inR'],
    ]);
  });

  it('only-L into a MONO target is a single leg from the L output', () => {
    const p = plan({ toPortId: 'audio', toDef: monoFilter, channelMode: 'left' });
    expect(shape(p.legs)).toEqual([['left', 'out_l', 'audio']]);
  });

  it('a MONO→MONO patch survives any channelMode — there is no side to select', () => {
    // Selecting a channel of a signal that has none would yield an empty plan,
    // which is indistinguishable from a REJECTED patch at the call site.
    for (const channelMode of ['both', 'left', 'right'] as const) {
      const p = plan({
        fromPortId: 'out',
        fromDef: monoOsc,
        toPortId: 'audio',
        toDef: monoFilter,
        channelMode,
      });
      expect(shape(p.legs), `channelMode=${channelMode}`).toEqual([['mono', 'out', 'audio']]);
    }
  });

  it('defaults to both', () => {
    expect(plan({ channelMode: undefined }).legs).toHaveLength(2);
  });
});

// ────────────────────────── leg-level occupancy (Q4) ──────────────────────────

describe('planAudioCommit — LEG-LEVEL occupancy', () => {
  it('a full-stereo patch replaces BOTH legs of the target', () => {
    const p = plan({
      edges: {
        oldL: edge('oldL', ['other', 'out_l'], ['dst', 'inL']),
        oldR: edge('oldR', ['other', 'out_r'], ['dst', 'inR']),
        elsewhere: edge('elsewhere', ['other', 'out_l'], ['third', 'inL']),
      },
    });
    expect(p.replaceEdgeIds).toEqual(['oldL', 'oldR']);
  });

  it('an only-L patch replaces ONLY the L leg — so A-only-L + B-only-R coexist', () => {
    const p = plan({
      channelMode: 'left',
      edges: { bR: edge('bR', ['bee', 'out_r'], ['dst', 'inR']) },
    });
    expect(p.replaceEdgeIds).toEqual([]);
    expect(shape(p.legs)).toEqual([['left', 'out_l', 'inL']]);
  });

  it('an only-R patch evicts only the R leg, leaving an existing L leg alone', () => {
    const p = plan({
      channelMode: 'right',
      edges: {
        aL: edge('aL', ['ay', 'out_l'], ['dst', 'inL']),
        bR: edge('bR', ['bee', 'out_r'], ['dst', 'inR']),
      },
    });
    expect(p.replaceEdgeIds).toEqual(['bR']);
  });

  it('never evicts a leg THIS plan is about to write (no delete-then-rewrite churn)', () => {
    const already = audioEdgeId('src', 'out_r', 'dst', 'inR');
    const p = plan({
      edges: { [already]: edge(already, ['src', 'out_r'], ['dst', 'inR']) },
    });
    expect(p.replaceEdgeIds).toEqual([]);
  });

  it('a stereo→mono commit evicts what sat on the mono input, not its own two legs', () => {
    const p = plan({
      toPortId: 'audio',
      toDef: monoFilter,
      edges: { old: edge('old', ['other', 'out'], ['dst', 'audio']) },
    });
    expect(p.replaceEdgeIds).toEqual(['old']);
    expect(p.legs).toHaveLength(2);
  });

  it('ignores edges targeting a DIFFERENT node with the same port id', () => {
    const p = plan({
      edges: { far: edge('far', ['other', 'out_l'], ['someone-else', 'inL']) },
    });
    expect(p.replaceEdgeIds).toEqual([]);
  });
});

// ───────────────────────── leg-group deletion ─────────────────────────

const legGroupDefs: Record<string, StereoDef> = {
  src: clouds,
  dst: cofefve,
  mono: monoFilter,
  osc: monoOsc,
};
const defForNode = (nodeId: string): StereoDef | undefined => legGroupDefs[nodeId];

describe('siblingLegIds / expandLegGroups', () => {
  const stereoPair = {
    L: edge('L', ['src', 'out_l'], ['dst', 'inL']),
    R: edge('R', ['src', 'out_r'], ['dst', 'inR']),
  };

  it('finds the other leg of a stereo→stereo group from either side', () => {
    expect(siblingLegIds(stereoPair.L, stereoPair, defForNode)).toEqual(['R']);
    expect(siblingLegIds(stereoPair.R, stereoPair, defForNode)).toEqual(['L']);
  });

  it('finds the other leg of a stereo→MONO group (both legs on one input)', () => {
    const edges = {
      L: edge('L', ['src', 'out_l'], ['mono', 'audio']),
      R: edge('R', ['src', 'out_r'], ['mono', 'audio']),
    };
    expect(siblingLegIds(edges.L, edges, defForNode)).toEqual(['R']);
  });

  it('finds the other leg of a MONO→stereo group (both legs from one output)', () => {
    const edges = {
      L: edge('L', ['osc', 'out'], ['dst', 'inL']),
      R: edge('R', ['osc', 'out'], ['dst', 'inR']),
    };
    expect(siblingLegIds(edges.L, edges, defForNode)).toEqual(['R']);
  });

  it('an only-L cable has no sibling to expand to', () => {
    const solo = { L: stereoPair.L };
    expect(siblingLegIds(solo.L, solo, defForNode)).toEqual([]);
  });

  it('a plain mono cable has no group at all', () => {
    const e = { m: edge('m', ['osc', 'out'], ['mono', 'audio']) };
    expect(siblingLegIds(e.m, e, defForNode)).toEqual([]);
  });

  it('does NOT group two legs from DIFFERENT sources into one input pair', () => {
    // A-only-L + B-only-R: two independent cables that happen to fill one
    // stereo input. Deleting one must not take the other.
    const edges = {
      aL: edge('aL', ['src', 'out_l'], ['dst', 'inL']),
      bR: edge('bR', ['other', 'out_r'], ['dst', 'inR']),
    };
    expect(siblingLegIds(edges.aL, edges, defForNode)).toEqual([]);
  });

  it('expandLegGroups widens a Backspace payload to the whole group', () => {
    expect(expandLegGroups(['L'], stereoPair, defForNode)).toEqual(['L', 'R']);
  });

  it('expandLegGroups is idempotent when both legs are already selected', () => {
    expect(expandLegGroups(['L', 'R'], stereoPair, defForNode)).toEqual(['L', 'R']);
  });

  it('expandLegGroups keeps the seeds first and drops unknown ids gracefully', () => {
    expect(expandLegGroups(['nope', 'R'], stereoPair, defForNode)).toEqual(['nope', 'R', 'L']);
  });
});

describe('legChannelOfEdge', () => {
  it('reads the SOURCE side when the source is paired', () => {
    expect(legChannelOfEdge(edge('e', ['src', 'out_r'], ['mono', 'audio']), defForNode)).toBe(
      'right',
    );
  });

  it('falls back to the TARGET side for a mono source', () => {
    expect(legChannelOfEdge(edge('e', ['osc', 'out'], ['dst', 'inR']), defForNode)).toBe('right');
  });

  it('is null when neither end is paired', () => {
    expect(legChannelOfEdge(edge('e', ['osc', 'out'], ['mono', 'audio']), defForNode)).toBeNull();
  });
});

describe('audioEdgeId', () => {
  it('is the endpoint-derived template every commit path shares', () => {
    expect(audioEdgeId('a', 'out_l', 'b', 'inL')).toBe('e-a-out_l-b-inL');
  });
});

describe('findStereoSibling (declared-only, still used by patch-convenience)', () => {
  it('resolves the sibling in either tuple slot', () => {
    expect(findStereoSibling(clouds, 'in_l')).toBe('in_r');
    expect(findStereoSibling(clouds, 'out_r')).toBe('out_l');
    expect(findStereoSibling(rings, 'odd')).toBe('even');
  });

  it('returns null for an unpaired port or an undeclared def', () => {
    expect(findStereoSibling(rings, 'in')).toBeNull();
    expect(findStereoSibling(monoOsc, 'out')).toBeNull();
  });
});

// ───────────────────────────── NEGATIVE CONTROLS ─────────────────────────────
//
// "Both legs are written" is only a meaningful assertion if a planner that
// writes ONE leg makes it fail. These re-implement the two planners this PR
// replaced and run the matrix asserts against them, so the suite proves it can
// go red rather than merely being green today.

/** The PRE-REVERSAL planner: mono source ⇒ no sibling; stereo→mono ⇒ collapse
 *  the group to the single clicked leg (the round-trip special case). */
function collapsingPlanner(args: {
  fromPortId: string;
  fromDef: StereoDef;
  toPortId: string;
  toDef: StereoDef;
}): [string, string, string][] {
  const sibFrom = findStereoSibling(args.fromDef, args.fromPortId);
  const sibTo = findStereoSibling(args.toDef, args.toPortId);
  if (!sibFrom || !sibTo) return [['mono', args.fromPortId, args.toPortId]];
  return [
    ['left', args.fromPortId, args.toPortId],
    ['right', sibFrom, sibTo],
  ];
}

describe('NEGATIVE CONTROL — the asserts fail against a single-leg planner', () => {
  it('stereo → mono: the collapsing planner writes ONE leg where dual-mono needs two', () => {
    const collapsed = collapsingPlanner({
      fromPortId: 'out_l',
      fromDef: clouds,
      toPortId: 'audio',
      toDef: monoFilter,
    });
    // This is the exact assert the real planner passes above — it must FAIL here.
    expect(() =>
      expect(collapsed).toEqual([
        ['left', 'out_l', 'audio'],
        ['right', 'out_r', 'audio'],
      ]),
    ).toThrow();
    expect(collapsed).toHaveLength(1);
  });

  it('mono → stereo: the collapsing planner leaves the sibling UNPATCHED', () => {
    const collapsed = collapsingPlanner({
      fromPortId: 'out',
      fromDef: monoOsc,
      toPortId: 'inL',
      toDef: cofefve,
    });
    expect(() =>
      expect(collapsed).toEqual([
        ['left', 'out', 'inL'],
        ['right', 'out', 'inR'],
      ]),
    ).toThrow();
    expect(collapsed).toHaveLength(1);
  });

  it('stereo → stereo: the collapsing planner DOES agree — the control is not vacuous', () => {
    // The negative control must be NON-DEGENERATE: if the old planner failed
    // every assert, "it fails" would prove nothing about which row moved.
    expect(
      collapsingPlanner({
        fromPortId: 'out_l',
        fromDef: clouds,
        toPortId: 'inL',
        toDef: cofefve,
      }),
    ).toEqual([
      ['left', 'out_l', 'inL'],
      ['right', 'out_r', 'inR'],
    ]);
  });

  it('leg-group deletion: a NON-expanding delete leaves an orphan the expand assert catches', () => {
    const stereoPair = {
      L: edge('L', ['src', 'out_l'], ['dst', 'inL']),
      R: edge('R', ['src', 'out_r'], ['dst', 'inR']),
    };
    const notExpanded = (ids: string[]) => ids; // the pre-PR-3 handleDelete
    expect(() => expect(notExpanded(['L'])).toEqual(['L', 'R'])).toThrow();
    expect(expandLegGroups(['L'], stereoPair, defForNode)).toEqual(['L', 'R']);
  });

  it('occupancy: a WHOLE-INPUT eviction would kill the coexisting only-R leg', () => {
    // The pre-PR-3 rule was "delete every edge targeting the same input". Under
    // leg-level occupancy an only-L patch must spare an only-R neighbour.
    const edges = { bR: edge('bR', ['bee', 'out_r'], ['dst', 'inR']) };
    const wholeInputEviction = Object.keys(edges); // what the old inline loop did
    expect(() => expect(wholeInputEviction).toEqual([])).toThrow();
    expect(plan({ channelMode: 'left', edges }).replaceEdgeIds).toEqual([]);
  });
});
