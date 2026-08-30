// unpatch-menu.test.ts
//
// The right-click UNPATCH affordance, in two halves:
//
//  1. buildUnpatchPlan — the PURE derivation every jack field's right-click
//     runs (which cables are seated on this hole, what each line says, when
//     "Unpatch all" appears, and — critically — that an UNPATCHED point yields
//     NO items so the surfaces leave its right-click behaviour untouched).
//
//  2. The REMOVAL SEAM the menu drives, exercised on a REAL syncedStore peer
//     pair + the app's own UndoManager (createPatch/createUndoManager from
//     graph/store). The menu deliberately re-uses the shipped edge-delete path
//     — one LOCAL_ORIGIN `delete patch.edges[id]` transact, plus the MAJOR-1
//     `wcolDetached` suppression for a reconciler-owned lane cable — so what is
//     pinned here is that this op set (a) converges to a collaborator and
//     (b) undoes as ONE unit, restoring both the edge and the suppression.
//     ([[yjs-save-load-real-ydoc]] discipline; the hidden-card peer harness.)

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { buildUnpatchPlan } from './unpatch-menu';
import { createPatch, LOCAL_ORIGIN } from '$lib/graph/store';
import type { AnyDef } from './port-patch-helpers';
import type { Edge, ModuleNode } from '$lib/graph/types';

// ---------------------------------------------------------------------------
// Fixtures for the pure half — a minimal def registry (label only; that is all
// moduleDisplayName reads).
// ---------------------------------------------------------------------------

const DEFS: Record<string, { label: string }> = {
  clipplayer: { label: 'CLIP PLAYER' },
  sixstrum: { label: 'SIX STRUM' },
  mixmstrs: { label: 'MIXMSTRS' },
  vca: { label: 'VCA' },
};
const defLookup = (type: string) => DEFS[type] as unknown as AnyDef | undefined;

function node(id: string, type: string): ModuleNode {
  return { id, type, domain: 'audio', position: { x: 0, y: 0 }, params: {} } as ModuleNode;
}

function edge(id: string, s: [string, string], t: [string, string]): Edge {
  return {
    id,
    source: { nodeId: s[0], portId: s[1] },
    target: { nodeId: t[0], portId: t[1] },
    sourceType: 'audio',
    targetType: 'audio',
  } as Edge;
}

const NODES: Record<string, ModuleNode> = {
  'pinned-clipplayer': node('pinned-clipplayer', 'clipplayer'),
  'strum-1': node('strum-1', 'sixstrum'),
  'pinned-mixmstrs': node('pinned-mixmstrs', 'mixmstrs'),
  'vca-1': node('vca-1', 'vca'),
  'vca-2': node('vca-2', 'vca'),
};

describe('buildUnpatchPlan — the patch-point menu model', () => {
  it("the OWNER'S CASE: a lane-wired POLY input lists its one source cable", () => {
    // Exactly what a workflow lane auto-wires for a poly instrument: the clip
    // player's pitch lane → SIX STRUM's poly input, as a reconciler-owned
    // wcol- edge the user never drew and previously could not remove.
    const edges = {
      'wcol-e-poly': edge('wcol-e-poly', ['pinned-clipplayer', 'pitch1'], ['strum-1', 'poly']),
    };
    const plan = buildUnpatchPlan(edges, NODES, defLookup, {
      nodeId: 'strum-1',
      portId: 'poly',
      direction: 'input',
    });
    expect(plan.title).toBe('SIX STRUM POLY');
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].edgeId).toBe('wcol-e-poly');
    expect(plan.items[0].label).toBe('Unpatch — CLIP PLAYER PITCH1');
    // ONE cable → no "Unpatch all" line.
    expect(plan.allLabel).toBeNull();
  });

  it('an UNPATCHED point yields NO items (no unpatch affordance at all)', () => {
    const edges = {
      e1: edge('e1', ['pinned-clipplayer', 'pitch1'], ['strum-1', 'poly']),
    };
    const plan = buildUnpatchPlan(edges, NODES, defLookup, {
      nodeId: 'strum-1',
      portId: 'strum1', // a different, unpatched hole on the same card
      direction: 'input',
    });
    expect(plan.items).toEqual([]);
    expect(plan.allLabel).toBeNull();
  });

  it('DIRECTION discriminates: the same port id as input vs output', () => {
    // 'out' is strum-1's OUTPUT; nothing terminates on an input named 'out'.
    const edges = { e1: edge('e1', ['strum-1', 'out'], ['pinned-mixmstrs', 'ch1']) };
    expect(
      buildUnpatchPlan(edges, NODES, defLookup, {
        nodeId: 'strum-1',
        portId: 'out',
        direction: 'input',
      }).items,
    ).toEqual([]);
    const asOutput = buildUnpatchPlan(edges, NODES, defLookup, {
      nodeId: 'strum-1',
      portId: 'out',
      direction: 'output',
    });
    expect(asOutput.items).toHaveLength(1);
    // Outputs use the → arrow (they FEED the remote).
    expect(asOutput.items[0].label).toBe('Unpatch → MIXMSTRS CH1');
  });

  it('a FANNED-OUT output lists every consumer + an "Unpatch all (N)"', () => {
    const edges = {
      'e-c': edge('e-c', ['strum-1', 'out'], ['vca-2', 'audio']),
      'e-a': edge('e-a', ['strum-1', 'out'], ['pinned-mixmstrs', 'ch1']),
      'e-b': edge('e-b', ['strum-1', 'out'], ['vca-1', 'audio']),
    };
    const plan = buildUnpatchPlan(edges, NODES, defLookup, {
      nodeId: 'strum-1',
      portId: 'out',
      direction: 'output',
    });
    // Deterministic order (by edge id) so two peers + two runs agree.
    expect(plan.items.map((i) => i.edgeId)).toEqual(['e-a', 'e-b', 'e-c']);
    expect(plan.allLabel).toBe('Unpatch all (3)');
    // Repeat instances of one type are numbered exactly like every other
    // patch surface (moduleDisplayName is shared).
    expect(plan.items.map((i) => i.remote)).toEqual([
      'MIXMSTRS CH1',
      'VCA #1 AUDIO',
      'VCA #2 AUDIO',
    ]);
  });

  it('a RENAMED remote is listed by its rename; un-renamed siblings keep their #N (#2264)', () => {
    // Same fan-out as above, with vca-1 renamed. The menu line shows the
    // user's name verbatim (moduleDisplayName is shared with every other
    // patch surface); vca-2's numbering is untouched by its sibling's rename.
    const nodes = {
      ...NODES,
      'vca-1': { ...node('vca-1', 'vca'), data: { name: 'feedback' } } as ModuleNode,
      // A reserved auto-default (what migrateAssignNames writes) is NOT a
      // rename — mixmstrs keeps its type label.
      'pinned-mixmstrs': { ...node('pinned-mixmstrs', 'mixmstrs'), data: { name: 'MIXMSTRS' } } as ModuleNode,
    };
    const edges = {
      'e-c': edge('e-c', ['strum-1', 'out'], ['vca-2', 'audio']),
      'e-a': edge('e-a', ['strum-1', 'out'], ['pinned-mixmstrs', 'ch1']),
      'e-b': edge('e-b', ['strum-1', 'out'], ['vca-1', 'audio']),
    };
    const plan = buildUnpatchPlan(edges, nodes, defLookup, {
      nodeId: 'strum-1',
      portId: 'out',
      direction: 'output',
    });
    expect(plan.items.map((i) => i.remote)).toEqual([
      'MIXMSTRS CH1',
      'feedback AUDIO',
      'VCA #2 AUDIO',
    ]);
  });

  it('a RENAMED target names the menu TITLE by its rename (#2264)', () => {
    const nodes = {
      ...NODES,
      'strum-1': { ...node('strum-1', 'sixstrum'), data: { name: 'lead_gtr' } } as ModuleNode,
    };
    const edges = { e1: edge('e1', ['strum-1', 'out'], ['pinned-mixmstrs', 'ch1']) };
    const plan = buildUnpatchPlan(edges, nodes, defLookup, {
      nodeId: 'strum-1',
      portId: 'out',
      direction: 'output',
    });
    expect(plan.title).toBe('lead_gtr OUT');
  });

  it('a duplicate cable on ONE input is individually removable (no assumed 1:1)', () => {
    const edges = {
      e1: edge('e1', ['pinned-clipplayer', 'pitch1'], ['strum-1', 'poly']),
      e2: edge('e2', ['vca-1', 'out'], ['strum-1', 'poly']),
    };
    const plan = buildUnpatchPlan(edges, NODES, defLookup, {
      nodeId: 'strum-1',
      portId: 'poly',
      direction: 'input',
    });
    expect(plan.items.map((i) => i.edgeId)).toEqual(['e1', 'e2']);
    expect(plan.allLabel).toBe('Unpatch all (2)');
  });

  it('a HALF-FORMED edge is skipped, never thrown on (runs over the live store)', () => {
    const edges = {
      bad1: { id: 'bad1' } as unknown as Edge,
      bad2: { id: 'bad2', source: { nodeId: 1 }, target: {} } as unknown as Edge,
      ok: edge('ok', ['pinned-clipplayer', 'pitch1'], ['strum-1', 'poly']),
    };
    const plan = buildUnpatchPlan(edges, NODES, defLookup, {
      nodeId: 'strum-1',
      portId: 'poly',
      direction: 'input',
    });
    expect(plan.items.map((i) => i.edgeId)).toEqual(['ok']);
  });

  it('falls back to the node TYPE when a remote module has no def', () => {
    const edges = { e1: edge('e1', ['ghost-1', 'out'], ['strum-1', 'poly']) };
    const nodes = { ...NODES, 'ghost-1': node('ghost-1', 'notregistered') };
    const plan = buildUnpatchPlan(edges, nodes, defLookup, {
      nodeId: 'strum-1',
      portId: 'poly',
      direction: 'input',
    });
    expect(plan.items[0].label).toBe('Unpatch — notregistered OUT');
  });

  it('a mono cable removes exactly itself (edgeIds is the whole cable, always)', () => {
    const edges = { e1: edge('e1', ['vca-1', 'out'], ['strum-1', 'poly']) };
    const plan = buildUnpatchPlan(edges, NODES, defLookup, {
      nodeId: 'strum-1',
      portId: 'poly',
      direction: 'input',
    });
    expect(plan.items[0].edgeIds).toEqual(['e1']);
    expect(plan.items[0].soloChannel).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LEG-GROUP awareness (PR-3). A stereo cable is TWO edges; the menu must offer
// ONE row that removes both, and must say "(L only)" when a lone leg is seated.
//
// The fixtures above deliberately carry only a `label`, so nothing there pairs
// — which is exactly why these need their own def set WITH real ports.
// ---------------------------------------------------------------------------

const PORTED_DEFS: Record<string, unknown> = {
  clouds: {
    label: 'CLOUDS',
    inputs: [
      { id: 'in_l', type: 'audio' },
      { id: 'in_r', type: 'audio' },
    ],
    outputs: [
      { id: 'out_l', type: 'audio' },
      { id: 'out_r', type: 'audio' },
    ],
    stereoPairs: [
      ['in_l', 'in_r'],
      ['out_l', 'out_r'],
    ],
  },
  cofefve: {
    label: 'COFEFVE',
    inputs: [
      { id: 'inL', type: 'audio' },
      { id: 'inR', type: 'audio' },
    ],
    outputs: [
      { id: 'outL', type: 'audio' },
      { id: 'outR', type: 'audio' },
    ],
    stereoPairs: [
      ['inL', 'inR'],
      ['outL', 'outR'],
    ],
  },
  filter: {
    label: 'FILTER',
    inputs: [{ id: 'audio', type: 'audio' }],
    outputs: [{ id: 'audio', type: 'audio' }],
  },
  // A DECLARED pair that is COLLAPSE_EXEMPT — two timbre taps, not an image.
  rings: {
    // `type` is load-bearing: COLLAPSE_EXEMPT is keyed on the exact
    // `<type>:<direction>:<left>+<right>` triple, so a fixture without it can
    // never match the exemption — the first draft of this test failed for
    // exactly that reason.
    type: 'rings',
    label: 'RINGS',
    inputs: [{ id: 'in', type: 'audio' }],
    outputs: [
      { id: 'odd', type: 'audio' },
      { id: 'even', type: 'audio' },
    ],
    stereoPairs: [['odd', 'even']],
  },
};
const portedLookup = (type: string) => PORTED_DEFS[type] as AnyDef | undefined;
const PORTED_NODES: Record<string, ModuleNode> = {
  cl: node('cl', 'clouds'),
  co: node('co', 'cofefve'),
  fi: node('fi', 'filter'),
  ri: node('ri', 'rings'),
};

describe('buildUnpatchPlan — leg groups', () => {
  const stereoCable = {
    'e-L': edge('e-L', ['cl', 'out_l'], ['co', 'inL']),
    'e-R': edge('e-R', ['cl', 'out_r'], ['co', 'inR']),
  };

  it('a stereo cable is ONE row that removes BOTH legs', () => {
    const plan = buildUnpatchPlan(stereoCable, PORTED_NODES, portedLookup, {
      nodeId: 'co',
      portId: 'inL',
      direction: 'input',
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].edgeIds.slice().sort()).toEqual(['e-L', 'e-R']);
    // A COMPLETE stereo cable gets NO channel suffix — nothing is missing.
    expect(plan.items[0].soloChannel).toBeNull();
    // …and it is named for the JACK, not for a leg. This expectation used to
    // read `CLOUDS OUT_L` — it encoded the bug the owner reported: a complete
    // stereo group described as if it were half of one, while the jack a click
    // away said `OUT`.
    expect(plan.items[0].label).toBe('Unpatch — CLOUDS OUT');
    // A live cable's mode is `both`, which is what puts the channel chips on
    // this row (they were previously unreachable on a PATCHED output).
    expect(plan.items[0].channelMode).toBe('both');
  });

  it('a LONE leg is labelled "(L only)" / "(R only)"', () => {
    const onlyL = { 'e-L': stereoCable['e-L'] };
    expect(
      buildUnpatchPlan(onlyL, PORTED_NODES, portedLookup, {
        nodeId: 'co',
        portId: 'inL',
        direction: 'input',
      }).items[0],
      // ONE rule: the label names the JACK (`OUT`), the suffix names the
      // channel. Not `OUT_L (L only)`, which said it twice and disagreed with
      // the jack on the first half.
    ).toMatchObject({
      soloChannel: 'left',
      label: 'Unpatch — CLOUDS OUT (L only)',
      channelMode: 'left',
    });

    const onlyR = { 'e-R': stereoCable['e-R'] };
    expect(
      buildUnpatchPlan(onlyR, PORTED_NODES, portedLookup, {
        nodeId: 'co',
        portId: 'inR',
        direction: 'input',
      }).items[0],
    ).toMatchObject({
      soloChannel: 'right',
      label: 'Unpatch — CLOUDS OUT (R only)',
      channelMode: 'right',
    });
  });

  it('a lone rings.ODD cable is NOT labelled "(L only)" — it is a whole cable', () => {
    // rings odd/even is a declared pair for WIRING (its autowire is shipped)
    // but COLLAPSE_EXEMPT for display: two different timbre taps, rendered as
    // two jacks named ODD and EVEN. `legChannelOfEdge` reads the WIRING list
    // and answers 'left' here, so the naive suffix would say "(L only)" about a
    // jack the UI calls ODD. The suffix asks `imageChannelOfEdge` instead — the
    // same helper the dashed only-L/R cable uses, so the two cannot disagree.
    const lone = { 'e-odd': edge('e-odd', ['ri', 'odd'], ['fi', 'audio']) };
    const plan = buildUnpatchPlan(lone, PORTED_NODES, portedLookup, {
      nodeId: 'fi',
      portId: 'audio',
      direction: 'input',
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].soloChannel).toBeNull();
    expect(plan.items[0].channelMode).toBeNull(); // and NO channel chips
    expect(plan.items[0].label).toBe('Unpatch — RINGS ODD');

    // CONTROL, so the assertion above is not passing because the suffix is
    // simply broken: the same shape on a REAL stereo pair still gets it.
    const realLone = { 'e-L': edge('e-L', ['cl', 'out_l'], ['fi', 'audio']) };
    const realPlan = buildUnpatchPlan(realLone, PORTED_NODES, portedLookup, {
      nodeId: 'fi',
      portId: 'audio',
      direction: 'input',
    });
    expect(realPlan.items[0].soloChannel).toBe('left');
    expect(realPlan.items[0].label).toBe('Unpatch — CLOUDS OUT (L only)');
  });

  it('a stereo→MONO group lists ONCE, not once per leg', () => {
    // Both legs terminate on the SAME mono input, so the per-edge loop would
    // otherwise emit two identical rows for one cable — and an "Unpatch all (2)"
    // for a patch point holding one cable.
    const dualMono = {
      'e-L': edge('e-L', ['cl', 'out_l'], ['fi', 'audio']),
      'e-R': edge('e-R', ['cl', 'out_r'], ['fi', 'audio']),
    };
    const plan = buildUnpatchPlan(dualMono, PORTED_NODES, portedLookup, {
      nodeId: 'fi',
      portId: 'audio',
      direction: 'input',
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].edgeIds.slice().sort()).toEqual(['e-L', 'e-R']);
    expect(plan.allLabel).toBeNull();
  });

  it('a mono→STEREO group lists ONCE on the shared OUTPUT point', () => {
    const doublePatched = {
      'e-L': edge('e-L', ['fi', 'audio'], ['co', 'inL']),
      'e-R': edge('e-R', ['fi', 'audio'], ['co', 'inR']),
    };
    const plan = buildUnpatchPlan(doublePatched, PORTED_NODES, portedLookup, {
      nodeId: 'fi',
      portId: 'audio',
      direction: 'output',
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].edgeIds.slice().sort()).toEqual(['e-L', 'e-R']);
  });

  it('TWO independent cables filling one stereo input stay TWO rows', () => {
    // The leg-occupancy case: A-only-L + B-only-R. They are not one cable, and
    // removing one must not remove the other.
    const nodes = { ...PORTED_NODES, cl2: node('cl2', 'clouds') };
    const mixed = {
      'e-a': edge('e-a', ['cl', 'out_l'], ['co', 'inL']),
      'e-b': edge('e-b', ['cl2', 'out_r'], ['co', 'inR']),
    };
    const plan = buildUnpatchPlan(mixed, nodes, portedLookup, {
      nodeId: 'co',
      portId: 'inL',
      direction: 'input',
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].edgeIds).toEqual(['e-a']);
    expect(plan.items[0].soloChannel).toBe('left');
  });

  it('NEGATIVE CONTROL — a non-expanding builder returns one leg, and that fails', () => {
    // What the pre-PR-3 model produced. Kept so "removes both legs" is an
    // assertion that can go red rather than a description of today.
    const preExpansion = ['e-L'];
    expect(() => expect(preExpansion.slice().sort()).toEqual(['e-L', 'e-R'])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The removal seam — real Y.Doc peers + the app's UndoManager.
// ---------------------------------------------------------------------------

const WCOL_ID = 'wcol-e-pinned-clipplayer-pitch1-strum-1-poly';

/** The EXACT op set Canvas's unpatchEdges runs for a managed lane cable. */
function unpatch(
  peer: ReturnType<typeof createPatch>,
  edgeId: string,
  colKey: string | null,
): void {
  peer.ydoc.transact(() => {
    if (colKey && edgeId.startsWith('wcol-e-')) {
      const mixer = peer.patch.nodes['pinned-mixmstrs'];
      if (mixer) {
        if (!mixer.data) mixer.data = {};
        const d = mixer.data as { wcolDetached?: Record<string, string[]> };
        if (!d.wcolDetached) d.wcolDetached = {};
        const cur = d.wcolDetached[colKey] ?? [];
        if (!cur.includes(edgeId)) d.wcolDetached[colKey] = [...cur, edgeId];
      }
    }
    delete peer.patch.edges[edgeId];
  }, LOCAL_ORIGIN);
}

/** The suppression set on the pinned mixer, as the reconcile reads it. */
function detached(
  peer: ReturnType<typeof createPatch>,
): Record<string, string[]> | undefined {
  const d = peer.patch.nodes['pinned-mixmstrs']?.data as
    | { wcolDetached?: Record<string, string[]> }
    | undefined;
  return d?.wcolDetached;
}

function seed(peer: ReturnType<typeof createPatch>): void {
  peer.ydoc.transact(() => {
    peer.patch.nodes['pinned-mixmstrs'] = { ...node('pinned-mixmstrs', 'mixmstrs'), data: {} } as ModuleNode;
    peer.patch.nodes['strum-1'] = { ...node('strum-1', 'sixstrum'), data: { channel: 1 } } as ModuleNode;
    peer.patch.edges[WCOL_ID] = edge(
      WCOL_ID,
      ['pinned-clipplayer', 'pitch1'],
      ['strum-1', 'poly'],
    );
  });
}

function converge(a: ReturnType<typeof createPatch>, b: ReturnType<typeof createPatch>): void {
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
  Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));
}

describe('unpatch removal seam — real syncedStore peers + UndoManager', () => {
  it('the removal CONVERGES: a collaborator sees the cable gone', () => {
    const a = createPatch();
    const b = createPatch();
    seed(a);
    converge(a, b);
    expect(b.patch.edges[WCOL_ID]).toBeDefined();

    unpatch(a, WCOL_ID, '1');
    converge(a, b);

    expect(a.patch.edges[WCOL_ID]).toBeUndefined();
    expect(b.patch.edges[WCOL_ID]).toBeUndefined();
    // …and the suppression marker rode the SAME sync, so the collaborator's
    // reconcile pass will not re-add the lane cable either.
    expect(detached(b)?.['1']).toEqual([WCOL_ID]);
  });

  it('UNDO restores the cable AND clears the suppression (ONE undo unit)', () => {
    const a = createPatch();
    seed(a);
    // The seed is not the unit under test — start the undo stack clean.
    a.undoManager.clear();

    unpatch(a, WCOL_ID, '1');
    expect(a.patch.edges[WCOL_ID]).toBeUndefined();

    a.undoManager.undo();
    const restored = a.patch.edges[WCOL_ID];
    expect(restored).toBeDefined();
    expect(restored!.target).toEqual({ nodeId: 'strum-1', portId: 'poly' });
    // Both writes were one LOCAL_ORIGIN transact → one undo entry, so the
    // detach suppression is lifted with the cable (else the reconcile would
    // immediately delete the cable undo just restored).
    expect(detached(a)?.['1'] ?? []).toEqual([]);

    // Redo removes it again — the round trip is symmetric.
    a.undoManager.redo();
    expect(a.patch.edges[WCOL_ID]).toBeUndefined();
  });

  it('a HAND-DRAWN cable is removed without planting any suppression marker', () => {
    const a = createPatch();
    const b = createPatch();
    seed(a);
    a.ydoc.transact(() => {
      a.patch.edges['e-hand'] = edge('e-hand', ['vca-1', 'out'], ['strum-1', 'poly']);
    });
    converge(a, b);

    unpatch(a, 'e-hand', '1'); // colKey resolves, but the id is not wcol-
    converge(a, b);

    expect(b.patch.edges['e-hand']).toBeUndefined();
    expect(b.patch.edges[WCOL_ID]).toBeDefined(); // untouched
    expect(detached(b)).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE MENU LABEL vs THE JACK LABEL — the drift gate.
//
// THE BUG this exists for (owner, on #1409): right-clicking a patched stereo
// output showed title `TIDY VCO OUT_L` and item `Unpatch → cloudseed IN_L` for
// a COMPLETE stereo group, while the jack one click away read `OUT`. Two
// surfaces describing one jack, disagreeing, with no gate comparing them —
// the same shape as the BackdraftCard ±1-vs-±0.2 finding.
//
// So the gate is not "the string is right", it is "the two surfaces AGREE",
// over the LIVE registry rather than a fixture. A future change to either
// naming rule fails here instead of shipping a contradiction.
// ────────────────────────────────────────────────────────────────────────────

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { derivedStereoPairs, type StereoPairDefLike } from '$lib/graph/stereo-pairs';
import { collapseStereoPorts } from './stereo-jack-collapse';
import { unpatchPortLabel } from './unpatch-menu';
import type { StereoDef } from '$lib/graph/stereo-autowire';

describe('the unpatch menu names a jack the SAME way the jack does', () => {
  const defs = [
    ...(listModuleDefs() as unknown as StereoPairDefLike[]),
    ...(listVideoModuleDefs() as unknown as StereoPairDefLike[]),
  ];

  it('the registry loaded (the sweep below is not vacuously empty)', () => {
    expect(defs.length).toBeGreaterThan(100);
    const paired = defs.filter((d) => derivedStereoPairs(d).length > 0);
    expect(paired.length, 'modules with a derived pair').toBeGreaterThan(30);
  });

  it('EVERY collapsed pair: the menu label === the jack label', () => {
    const drift: string[] = [];
    let compared = 0;
    for (const def of defs) {
      for (const direction of ['input', 'output'] as const) {
        const ports = ((direction === 'input' ? def.inputs : def.outputs) ?? []).map((p) => ({
          id: p.id,
          cable: p.type,
        }));
        const rows = collapseStereoPorts(ports, def, direction);
        for (const row of rows) {
          if (!row.siblingId) continue; // only collapsed pairs are in scope
          compared += 1;
          // The JACK's name, and the MENU's name, for the same jack.
          const jack = row.label!;
          const menu = unpatchPortLabel(def as unknown as StereoDef, row.id, direction);
          if (jack !== menu) {
            drift.push(`${def.type} ${direction} ${row.id}: jack "${jack}" vs menu "${menu}"`);
          }
          // …and the menu must NOT be naming a single leg. This is the exact
          // regression: `OUT_L` where the jack says `OUT`.
          if (menu.toUpperCase() === row.id.toUpperCase()) {
            drift.push(`${def.type} ${direction} ${row.id}: menu still prints the raw LEG id`);
          }
        }
      }
    }
    expect(compared, 'collapsed pairs actually compared').toBeGreaterThan(50);
    expect(drift).toEqual([]);
  });

  it('the owner-reported case, by name', () => {
    const tidyVco = defs.find((d) => d.type === 'tidyVco')!;
    const cloudseed = defs.find((d) => d.type === 'cloudseed')!;
    expect(unpatchPortLabel(tidyVco as unknown as StereoDef, 'out_l', 'output')).toBe('OUT');
    expect(unpatchPortLabel(cloudseed as unknown as StereoDef, 'in_l', 'input')).toBe('IN');
  });

  it('an UNPAIRED port is untouched — the fix does not rename everything', () => {
    // Scope control. `vca.audio` is not half of anything and must still print
    // its raw id, or this "fix" would be a silent mass relabelling.
    const vca = defs.find((d) => d.type === 'vca')!;
    expect(unpatchPortLabel(vca as unknown as StereoDef, 'audio', 'output')).toBe('AUDIO');
    expect(unpatchPortLabel(undefined, 'whatever', 'output')).toBe('WHATEVER');
  });

  it('rings odd/even is NOT renamed — COLLAPSE_EXEMPT, two timbre taps', () => {
    const rings = defs.find((d) => d.type === 'rings')!;
    expect(unpatchPortLabel(rings as unknown as StereoDef, 'odd', 'output')).toBe('ODD');
    expect(unpatchPortLabel(rings as unknown as StereoDef, 'even', 'output')).toBe('EVEN');
  });
});
