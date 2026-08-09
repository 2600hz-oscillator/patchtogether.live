// packages/web/src/lib/graph/per-leg-patching.test.ts
//
// PER-LEG STEREO PATCHING, pinned against the OWNER'S REAL RACK.
//
// THE PATCH (decoded from his `es-9_sends.zip`, a `pt-performance-v1` bundle).
// Two stereo aux buses leave `mixmstrs` for hardware and two stereo returns come
// back, on jacks he chose BY HAND on the front of a rack unit:
//
//     mixmstrs.send1L → es9.out3        es9.in14 → mixmstrs.ret1L
//     mixmstrs.send1R → es9.out4        es9.in13 → mixmstrs.ret1R
//     mixmstrs.send2L → es9.out5        es9.in11 → mixmstrs.ret2L
//     mixmstrs.send2R → es9.out6        es9.in12 → mixmstrs.ret2R
//
// ⚠ READ THE RETURN MAPPING BEFORE CHANGING ANYTHING HERE. `in14`→**L** paired
// with `in13`→**R** is REVERSED, and `in11`/`in12` is not adjacent to either.
// That is not a mistake to be normalised — it is which cable is plugged into
// which hole. Any "spread L to the next adjacent point" convenience would
// silently swap his channels, which is why per-side patching is EXPLICIT and
// why these expectations are written out jack by jack instead of generated.
//
// The file loads the REAL `es9Def` / `mixmstrsDef`, not fixtures: the whole
// question is what the shipped contracts do, and a fixture that happens to
// pair the way I expect would prove nothing about them.
//
// ⚠ WHAT THIS FILE IS STRUCTURALLY UNABLE TO SEE, stated so a green run is not
// read as more than it is. `planAudioCommit` ALREADY honoured `channelMode`
// before any of this work — measured, not assumed — so every RETURN row below
// was green on the unmodified planner too. **The bug was never in the planner;
// it was that no UI gesture could ever set `channelMode` for a mono source.**
// A unit test that calls the planner directly cannot see a menu that never
// offers the choice, which is the exact shape of the failure this repo calls
// the backdraft class. The gate for that half is
// `e2e/tests/es9-per-leg-patching.spec.ts`, which drives the real menus and
// asserts the resulting EDGE SET. Do not let this file's greenness stand in
// for it. What IS pinned here and would go red on a regression: the ES-9
// mono-point trim, the leg-group deletion behaviour, and the exact
// port-resolution contract the menu rows depend on.

import { describe, expect, it } from 'vitest';
import '$lib/audio/modules';
import { listModuleDefs } from '$lib/audio/module-registry';
import { es9Def } from '$lib/audio/modules/es9';
import { mixmstrsDef } from '$lib/audio/modules/mixmstrs';
import {
  planAudioCommit,
  siblingLegIds,
  type ChannelMode,
  type StereoDef,
} from './stereo-autowire';
import { MONO_AUDIO_POINT_MODULES, isMonoAudioPointModule } from './stereo-pairs';
import type { Edge } from './types';

const es9 = es9Def as unknown as StereoDef;
const mix = mixmstrsDef as unknown as StereoDef;

const NODE_ES9 = 'es9-9f485c08';
const NODE_MIX = 'pinned-mixmstrs';

/** One patch gesture → the edges it writes, as `from->to` strings. */
function commit(args: {
  fromNodeId: string;
  fromPortId: string;
  fromDef: StereoDef;
  toNodeId: string;
  toPortId: string;
  toDef: StereoDef;
  channelMode?: ChannelMode;
  edges?: Record<string, Edge>;
}): string[] {
  const plan = planAudioCommit({
    edges: args.edges ?? {},
    sourceType: 'audio',
    targetType: 'audio',
    ...args,
  });
  return plan.legs.map((l) => `${l.fromPortId}->${l.toPortId}`);
}

// ---------------------------------------------------------------------------
// THE EIGHT EDGES
// ---------------------------------------------------------------------------

describe("the owner's ES-9 send/return patch is reconstructible one leg at a time", () => {
  // THE SENDS. The user right-clicks the COLLAPSED `SEND1` jack (which
  // addresses `send1L`) and picks "patch only L" / "patch only R" — the
  // source-side rows, which appear because `send1L`/`send1R` is a derived pair.
  // The target is a bare ES-9 output jack, so there is nothing to drill.
  it.each([
    ['send1L', 'left', 'out3', 'send1L->out3'],
    ['send1L', 'right', 'out4', 'send1R->out4'],
    ['send2L', 'left', 'out5', 'send2L->out5'],
    ['send2L', 'right', 'out6', 'send2R->out6'],
  ] as const)(
    'SEND: collapsed %s + "only %s" → es9.%s writes exactly [%s]',
    (fromPortId, channelMode, toPortId, expected) => {
      expect(
        commit({
          fromNodeId: NODE_MIX,
          fromPortId,
          fromDef: mix,
          toNodeId: NODE_ES9,
          toPortId,
          toDef: es9,
          channelMode,
        }),
      ).toEqual([expected]);
    },
  );

  // THE RETURNS. The source is a MONO ES-9 point, so it has no side to take and
  // the source-side rows are correctly hidden. The side is named on the TARGET
  // instead: the picker drills the collapsed `RET1` into `RET1 L` / `RET1 R`,
  // and a leg row commits with `channelMode` = that side.
  //
  // ⚠ NOTE THE `toPortId` COLUMN IS ALWAYS THE PAIR'S **LEFT** PORT, including
  // on the rows that write R. That is the contract `CandidatePort.portId`
  // documents: the planner resolves the actual port from the pair, so naming
  // `ret1R` here instead would be right for this mono source and WRONG for a
  // paired one (see the cross-check test below).
  it.each([
    ['in14', 'ret1L', 'left', 'in14->ret1L'],
    ['in13', 'ret1L', 'right', 'in13->ret1R'],
    ['in11', 'ret2L', 'left', 'in11->ret2L'],
    ['in12', 'ret2L', 'right', 'in12->ret2R'],
  ] as const)(
    'RETURN: es9.%s → collapsed %s picked as "%s" writes exactly [%s]',
    (fromPortId, toPortId, channelMode, expected) => {
      expect(
        commit({
          fromNodeId: NODE_ES9,
          fromPortId,
          fromDef: es9,
          toNodeId: NODE_MIX,
          toPortId,
          toDef: mix,
          channelMode,
        }),
      ).toEqual([expected]);
    },
  );

  it('THE REVERSAL SURVIVES: in14 lands on L and in13 on R, not the other way round', () => {
    // The single assertion this whole file exists for. If a future convenience
    // ever "helpfully" spreads a return across adjacent jacks, this is what
    // goes red — and it names the failure in the message rather than printing
    // two similar-looking arrays.
    const l = commit({
      fromNodeId: NODE_ES9, fromPortId: 'in14', fromDef: es9,
      toNodeId: NODE_MIX, toPortId: 'ret1L', toDef: mix, channelMode: 'left',
    });
    const r = commit({
      fromNodeId: NODE_ES9, fromPortId: 'in13', fromDef: es9,
      toNodeId: NODE_MIX, toPortId: 'ret1L', toDef: mix, channelMode: 'right',
    });
    expect(
      [...l, ...r],
      'the owner patched in14 into RET1 L and in13 into RET1 R — physically, by hand. ' +
        'Auto-spreading L to the next adjacent input would swap his channels.',
    ).toEqual(['in14->ret1L', 'in13->ret1R']);
  });

  it('EVERY leg-selecting gesture writes exactly ONE edge — asserted as a COUNT', () => {
    // The failure this repo names the backdraft class: a menu that offers a
    // per-side choice while the planner writes both legs anyway. "An edge
    // appeared" cannot see that; the COUNT can.
    const gestures = [
      { from: 'send1L', fromDef: mix, to: 'out3', toDef: es9, mode: 'left' },
      { from: 'send1L', fromDef: mix, to: 'out4', toDef: es9, mode: 'right' },
      { from: 'in14', fromDef: es9, to: 'ret1L', toDef: mix, mode: 'left' },
      { from: 'in13', fromDef: es9, to: 'ret1L', toDef: mix, mode: 'right' },
    ] as const;
    for (const g of gestures) {
      const legs = commit({
        fromNodeId: 'a', fromPortId: g.from, fromDef: g.fromDef,
        toNodeId: 'b', toPortId: g.to, toDef: g.toDef, channelMode: g.mode,
      });
      expect(legs, `${g.from} --${g.mode}--> ${g.to} must be ONE edge`).toHaveLength(1);
    }
  });

  it('a PAIRED source picking a target LEG stays side-aligned (L→L, R→R)', () => {
    // Why `CandidatePort.portId` is the pair's LEFT port even on the R row.
    // With a paired source the clicked leg is anchored on the SOURCE side, so
    // addressing `ret1R` directly would leave the surviving leg on `ret1L` —
    // the opposite of what the row says. Naming the canonical left keeps the
    // planner's side-symmetric derivation correct for BOTH source kinds.
    expect(
      commit({
        fromNodeId: NODE_MIX, fromPortId: 'send1L', fromDef: mix,
        toNodeId: NODE_MIX, toPortId: 'ret1L', toDef: mix, channelMode: 'right',
      }),
    ).toEqual(['send1R->ret1R']);
  });
});

// ---------------------------------------------------------------------------
// ES-9 = MONO AUDIO POINTS
// ---------------------------------------------------------------------------

describe('ES-9 audio ports are independent MONO POINTS', () => {
  it('a STEREO source into one ES-9 jack does NOT sum both legs into it', () => {
    // The live hazard before this change: dual-mono ("stereo → mono writes BOTH
    // legs into the mono input") put `send1L` AND `send1R` into `out3` — two
    // signals summing into one physical output jack.
    const legs = commit({
      fromNodeId: NODE_MIX, fromPortId: 'send1L', fromDef: mix,
      toNodeId: NODE_ES9, toPortId: 'out3', toDef: es9,
      channelMode: 'both',
    });
    expect(
      legs,
      'two legs into one ES-9 output is a patching error, not a stereo cable',
    ).toEqual(['send1L->out3']);
  });

  it('NEGATIVE CONTROL: the same gesture into a NON-hardware mono input still dual-monos', () => {
    // Without this, the test above would pass just as well if dual-mono had
    // been deleted outright — and the ES-9 rule would be indistinguishable from
    // a global behaviour change. `vca.audio` is an ordinary mono audio input.
    const vca = listModuleDefs().find((d) => d.type === 'vca');
    expect(vca, 'vca must exist for this control to mean anything').toBeDefined();
    const legs = commit({
      fromNodeId: NODE_MIX, fromPortId: 'send1L', fromDef: mix,
      toNodeId: 'vca1', toPortId: 'audio', toDef: vca as unknown as StereoDef,
      channelMode: 'both',
    });
    expect(legs).toEqual(['send1L->audio', 'send1R->audio']);
  });

  it('the trim is keyed on the PORT, so es9 spdif_l/spdif_r still wires as one stereo cable', () => {
    // `spdif_l`/`spdif_r` is a GENUINE declared-by-token pair on the very same
    // module. It resolves two DIFFERENT points, so nothing sums and the ES-9
    // rule must not touch it. (SPDIF is an es9 OUTPUT, so this is the
    // stereo→stereo direction into a mixer channel.)
    expect(
      commit({
        fromNodeId: NODE_ES9, fromPortId: 'spdif_l', fromDef: es9,
        toNodeId: NODE_MIX, toPortId: 'ch3L', toDef: mix, channelMode: 'both',
      }),
    ).toEqual(['spdif_l->ch3L', 'spdif_r->ch3R']);
  });

  it.each(['left', 'right'] as const)(
    'an only-%s patch into an ES-9 jack still writes its ONE leg (the trim runs AFTER the mode filter)',
    (mode) => {
      // The ordering trap. For a MONO target the R side IS the sibling leg
      // (both legs share the port), so a trim that refused to PLAN the sibling
      // would make "patch only R" into an ES-9 jack write NOTHING — silently,
      // because an empty plan looks exactly like a valid one.
      const legs = commit({
        fromNodeId: NODE_MIX, fromPortId: 'send1L', fromDef: mix,
        toNodeId: NODE_ES9, toPortId: 'out3', toDef: es9, channelMode: mode,
      });
      expect(legs, `only-${mode} into es9.out3 must still write one edge`).toEqual([
        mode === 'left' ? 'send1L->out3' : 'send1R->out3',
      ]);
    },
  );

  it('ES-9 as a SOURCE keeps ordinary mono→stereo behaviour', () => {
    // Scope statement. The rule is about legs SUMMING INTO one physical point;
    // one ES-9 jack fanning out to both legs of a stereo input occupies one
    // point and sums nothing, so it is deliberately untouched — and a casual
    // "plug a guitar into in1, hear it in both ears" still works.
    expect(
      commit({
        fromNodeId: NODE_ES9, fromPortId: 'in1', fromDef: es9,
        toNodeId: NODE_MIX, toPortId: 'ch1L', toDef: mix, channelMode: 'both',
      }),
    ).toEqual(['in1->ch1L', 'in1->ch1R']);
  });
});

describe('MONO_AUDIO_POINT_MODULES is anchored to the live registry', () => {
  it('every entry names a module the registry ACTUALLY has', () => {
    // A stale entry is one nobody is watching — the same discipline
    // COLLAPSE_EXEMPT is held to. If `es9` is ever renamed, this goes red
    // instead of the rule silently ceasing to apply.
    const known = new Set(listModuleDefs().map((d) => d.type));
    for (const type of MONO_AUDIO_POINT_MODULES.keys()) {
      expect(known.has(type), `MONO_AUDIO_POINT_MODULES names '${type}', which no longer exists`).toBe(true);
    }
  });

  it('every entry carries a REASON', () => {
    for (const [type, reason] of MONO_AUDIO_POINT_MODULES) {
      expect(reason.length, `${type} needs the reason it is exempt`).toBeGreaterThan(40);
    }
  });

  it('stays the list of ONE the owner scoped it to', () => {
    // "we're not going to have anything else like that" — owner, 2026-08-07.
    // A second entry is not necessarily wrong, but it is a decision that needs
    // a human, not a quiet append. Ratcheted in BOTH directions.
    expect([...MONO_AUDIO_POINT_MODULES.keys()]).toEqual(['es9']);
  });

  it('does not fire for anything else', () => {
    expect(isMonoAudioPointModule('es9')).toBe(true);
    for (const t of ['moog984', 'matrixmix', 'mixmstrs', 'audioOut', undefined]) {
      expect(isMonoAudioPointModule(t), `${t} must NOT be a mono-audio-point module`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// UNPATCH must not co-delete across the reversed mapping
// ---------------------------------------------------------------------------

describe('unpatching a single-leg cable leaves its neighbours alone', () => {
  /** The owner's eight edges, as a live edge map. */
  function ownerEdges(): Record<string, Edge> {
    const spec: [string, string, string, string][] = [
      [NODE_MIX, 'send1L', NODE_ES9, 'out3'],
      [NODE_MIX, 'send1R', NODE_ES9, 'out4'],
      [NODE_MIX, 'send2L', NODE_ES9, 'out5'],
      [NODE_MIX, 'send2R', NODE_ES9, 'out6'],
      [NODE_ES9, 'in14', NODE_MIX, 'ret1L'],
      [NODE_ES9, 'in13', NODE_MIX, 'ret1R'],
      [NODE_ES9, 'in11', NODE_MIX, 'ret2L'],
      [NODE_ES9, 'in12', NODE_MIX, 'ret2R'],
    ];
    const out: Record<string, Edge> = {};
    for (const [sn, sp, tn, tp] of spec) {
      const id = `e-${sn}-${sp}-${tn}-${tp}`;
      out[id] = {
        id,
        source: { nodeId: sn, portId: sp },
        target: { nodeId: tn, portId: tp },
        sourceType: 'audio',
        targetType: 'audio',
      };
    }
    return out;
  }

  const defForNode = (nodeId: string): StereoDef | undefined =>
    nodeId === NODE_ES9 ? es9 : nodeId === NODE_MIX ? mix : undefined;

  it('NO edge in the rack has a sibling leg — every one of the eight is its own cable', () => {
    // This is the "do not regress unpatch" pin. `siblingLegIds` co-deletes a
    // leg group, and the two returns of a pair here come from DIFFERENT ES-9
    // jacks (in14/in13) — so they are two independent cables that merely land
    // on the two halves of one input. Co-deleting them would silently take out
    // a cable the user did not select.
    const edges = ownerEdges();
    for (const [id, e] of Object.entries(edges)) {
      expect(
        siblingLegIds(e, edges, defForNode),
        `${id} must not drag another cable with it`,
      ).toEqual([]);
    }
  });

  it('a half-patched pair returns no siblings and does not throw', () => {
    // Only the L return exists. `ret1R` is empty. Nothing to co-delete, and in
    // particular no invented id for a leg that was never patched.
    const id = `e-${NODE_ES9}-in14-${NODE_MIX}-ret1L`;
    const edges: Record<string, Edge> = {
      [id]: {
        id,
        source: { nodeId: NODE_ES9, portId: 'in14' },
        target: { nodeId: NODE_MIX, portId: 'ret1L' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    };
    expect(() => siblingLegIds(edges[id]!, edges, defForNode)).not.toThrow();
    expect(siblingLegIds(edges[id]!, edges, defForNode)).toEqual([]);
  });

  it('POSITIVE CONTROL: a REAL leg group IS still found', () => {
    // Without this the test above would pass if `siblingLegIds` simply always
    // returned [] — i.e. if leg-group deletion were broken outright.
    const a = `e-${NODE_ES9}-spdif_l-${NODE_MIX}-ch3L`;
    const b = `e-${NODE_ES9}-spdif_r-${NODE_MIX}-ch3R`;
    const edges: Record<string, Edge> = {
      [a]: {
        id: a,
        source: { nodeId: NODE_ES9, portId: 'spdif_l' },
        target: { nodeId: NODE_MIX, portId: 'ch3L' },
        sourceType: 'audio', targetType: 'audio',
      },
      [b]: {
        id: b,
        source: { nodeId: NODE_ES9, portId: 'spdif_r' },
        target: { nodeId: NODE_MIX, portId: 'ch3R' },
        sourceType: 'audio', targetType: 'audio',
      },
    };
    expect(siblingLegIds(edges[a]!, edges, defForNode)).toEqual([b]);
  });

  it('replaceEdgeIds evicts ONLY the leg being rewritten', () => {
    // Re-patching just the L return must not disturb the R one, which is a
    // different cable from a different jack. (Leg-level occupancy, owner Q4.)
    const edges = ownerEdges();
    const plan = planAudioCommit({
      fromNodeId: NODE_ES9, fromPortId: 'in9', fromDef: es9,
      toNodeId: NODE_MIX, toPortId: 'ret1L', toDef: mix,
      edges, sourceType: 'audio', targetType: 'audio', channelMode: 'left',
    });
    expect(plan.legs.map((l) => `${l.fromPortId}->${l.toPortId}`)).toEqual(['in9->ret1L']);
    expect(plan.replaceEdgeIds).toEqual([`e-${NODE_ES9}-in14-${NODE_MIX}-ret1L`]);
  });
});
