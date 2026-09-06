// packages/web/src/lib/graph/legacy-group-sticky-load.test.ts
//
// THE SAFETY GATE for retiring the `group` and `sticky` module types.
//
// The owner's ruling deletes both types outright ("we may rebuild these later
// in a new form but for now we burn it down"). The hazard that creates is not
// in the deletion, it is in every rack ALREADY SAVED: a `.imp.json` patch or a
// performance zip authored while GROUP! and STICKY shipped must still LOAD
// after their defs are gone. A crash on legacy patch load is a release
// blocker, so the behaviour is pinned HERE, against a frozen fixture, rather
// than discovered later by a user with a saved instrument.
//
// ── THE FIXTURE (`__fixtures__/legacy-group-sticky.imp.json`) ───────────────
// A rack a user could genuinely have saved: a DUB VOICE group collapsing an
// `analogVco` + a `delay`, with
//   * `data.childIds` + the inverse `data.parentGroupId` on each child,
//   * two `data.exposedPorts` (one input, one output) — the group's own jacks,
//   * `data.exposedControls` and a locked `data.instrumentLayout`,
// a STICKY carrying its text and its size, and FOUR cables covering every
// class the deletion can touch:
//   e-grp-in    lfo-1.phase0     -> grp-1::IN--PITCH--A    (into the group)
//   e-grp-out   grp-1::OUT--AUDIO--B -> out-1.L            (out of the group)
//   e-internal  vco-1.saw        -> dly-1.audio            (INSIDE the group)
//   e-control   vco-2.triangle   -> out-1.R                (touches neither)
// It is authored, then frozen — the same limit the `retired-type-migration`
// precedent states out loud: this proves the LOADER handles a retired type, it
// cannot prove the fixture resembles any particular user's rack.
//
// `sticky` declares NO ports, so no cable can legally terminate on it; its
// realistic payload is text + geometry, and that is what the fixture carries.
//
// ── WHY THE `contains what it claims` BLOCK IS NOT PAPERWORK ────────────────
// Every interesting assertion in the drop leg is an ABSENCE, and an absence
// passes trivially against a fixture that never held the thing. The precedent
// could only warn about that in prose. This file instead decodes the frozen
// envelope DIRECTLY and asserts the saved rack really contains a `group` with
// two exposed ports, a `sticky` with text, and all four cables — so the leg
// can never quietly become vacuous, whatever happens to the registries.
//
// ── WHAT WAS DETERMINED BEFORE ANYTHING WAS DELETED (the three surfaces) ────
//   PERSISTENCE  `loadEnvelopeIntoStore` gates every node on
//                `isKnownModuleType` and drops the unknown ones with a
//                diagnostic, then drops every edge touching a dropped node.
//                It does NOT go through `validateGraphFragment` — which is
//                worth stating, because that function carries an explicit
//                `node.type === 'group'` KEEP exemption that would have
//                preserved an unrenderable group node. It has no callers at
//                all (only its own unit test), so the exemption never runs on
//                a load; it dies with the rest of the group machinery.
//   RECONCILER   `attachReconciler` skips `domain === 'meta'` before
//                `engine.addNode` is ever reached, and a group/sticky node
//                saved by the shipping code carries `domain: 'meta'`. Even a
//                non-meta unknown type is contained: `addNode` is wrapped in a
//                per-node try/catch that marks the node failed and lets the
//                rest of the pass land.
//   RENDERER     unreachable via a patch load (persistence drops the node
//                first), and non-fatal if a node ever arrives another way:
//                `laneRenderKind` sees `hasCard: false` and returns 'legacy',
//                which emits the raw type to SvelteFlow, whose NodeWrapper
//                resolves `store.nodeTypes[type] ?? DefaultNode`. No throw.
//   SAVE         re-saving after such a load cannot resurrect the node — the
//                envelope is encoded from the live store, which no longer
//                holds it. Asserted below.

import { describe, it, expect, beforeAll } from 'vitest';
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadEnvelopeIntoStore,
  makeStateOnlyEnvelope,
  parseEnvelope,
  RETIRED_TYPE_ALIASES,
  type LivePatch,
  type LoadDiagnostic,
} from './persistence';
import { LOAD_DIAGNOSTIC_REASONS, summarizeLoadDiagnostics } from './load-diagnostics';
import { laneRenderKind, emittedTypeFor, isLaneNative } from '$lib/ui/workflow/legacy-fallback';
import type { ModuleNode, Edge } from './types';

const FIXTURE = fileURLToPath(
  new URL('./__fixtures__/legacy-group-sticky.imp.json', import.meta.url),
);

/** Every cable in the frozen rack, by the class the deletion puts it in. */
const CABLES_TOUCHING_THE_GROUP = ['e-grp-in', 'e-grp-out'] as const;
const CABLES_THAT_MUST_SURVIVE = ['e-internal', 'e-control'] as const;

function freshPatch(): { ydoc: Y.Doc; store: LivePatch } {
  const store = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({
    nodes: {},
    edges: {},
  });
  return { ydoc: getYjsDoc(store), store: store as unknown as LivePatch };
}

const raw = readFileSync(FIXTURE, 'utf8');

describe('the frozen fixture contains what the drop leg claims (anti-vacuity control)', () => {
  // Decoded WITHOUT the loader, so this block is true regardless of which
  // types happen to be registered in this build.
  let savedNodes: Record<string, ModuleNode>;
  let savedEdges: Record<string, Edge>;

  beforeAll(() => {
    const doc = new Y.Doc();
    const env = parseEnvelope(raw);
    Y.applyUpdate(doc, Uint8Array.from(atob(env.update), (c) => c.charCodeAt(0)));
    savedNodes = doc.getMap('nodes').toJSON() as Record<string, ModuleNode>;
    savedEdges = doc.getMap('edges').toJSON() as Record<string, Edge>;
  });

  it('holds a GROUP node with real membership, jacks, controls and a layout', () => {
    const g = savedNodes['grp-1'];
    expect(g, 'the fixture must contain a group node or the drop leg is vacuous').toBeDefined();
    expect(g!.type).toBe('group');
    expect(g!.domain).toBe('meta');
    const d = g!.data as unknown as {
      childIds: string[];
      exposedPorts: { id: string; childId: string; childPortId: string; direction: string }[];
      exposedControls: unknown[];
      instrumentLayout: { mode: string; controls: Record<string, unknown> };
      label: string;
    };
    expect(d.childIds).toEqual(['vco-1', 'dly-1']);
    expect(d.exposedPorts.map((p) => p.id)).toEqual(['IN--PITCH--A', 'OUT--AUDIO--B']);
    expect(d.exposedPorts.map((p) => p.direction)).toEqual(['input', 'output']);
    expect(d.exposedControls).toHaveLength(2);
    expect(d.instrumentLayout.mode).toBe('locked');
    expect(Object.keys(d.instrumentLayout.controls)).toHaveLength(3);
    expect(d.label).toBe('DUB VOICE');
  });

  it('holds a STICKY node with its text and its size', () => {
    const s = savedNodes['stk-1'];
    expect(s, 'the fixture must contain a sticky node or the drop leg is vacuous').toBeDefined();
    expect(s!.type).toBe('sticky');
    expect(s!.domain).toBe('meta');
    const d = s!.data as { text: string; width: number; height: number };
    expect(typeof d.text).toBe('string');
    expect(d.text.length).toBeGreaterThan(20);
    expect(d.width).toBe(240);
    expect(d.height).toBe(160);
  });

  it('the two children carry the inverse membership pointer', () => {
    for (const id of ['vco-1', 'dly-1']) {
      expect((savedNodes[id]!.data as { parentGroupId?: string }).parentGroupId).toBe('grp-1');
    }
  });

  it('holds all four cables, two of them terminating on the group itself', () => {
    expect(Object.keys(savedEdges).sort()).toEqual(
      [...CABLES_TOUCHING_THE_GROUP, ...CABLES_THAT_MUST_SURVIVE].sort(),
    );
    // BY ENDPOINT, not by count — a count would pass if the wrong two touched.
    expect(savedEdges['e-grp-in']!.target).toEqual({
      nodeId: 'grp-1',
      portId: 'IN--PITCH--A',
    });
    expect(savedEdges['e-grp-out']!.source).toEqual({
      nodeId: 'grp-1',
      portId: 'OUT--AUDIO--B',
    });
    // And the survivors touch neither meta node at either end.
    for (const id of CABLES_THAT_MUST_SURVIVE) {
      const e = savedEdges[id]!;
      for (const end of [e.source.nodeId, e.target.nodeId]) {
        expect(['grp-1', 'stk-1']).not.toContain(end);
      }
    }
  });
});

describe('loading the frozen rack after the types are UNREGISTERED', () => {
  let diagnostics: LoadDiagnostic[];
  let nodes: Record<string, ModuleNode | undefined>;
  let edges: Record<string, Edge | undefined>;
  let dest: ReturnType<typeof freshPatch>;

  beforeAll(async () => {
    // The REAL registries, so this exercises the shipped contract.
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    await import('$lib/meta/modules');

    dest = freshPatch();
    const result = loadEnvelopeIntoStore(parseEnvelope(raw), dest.ydoc, dest.store);
    diagnostics = result.diagnostics;
    nodes = dest.store.nodes;
    edges = dest.store.edges;
    // ⚠ EXPLICIT HOOK TIMEOUT, and it is load-bearing rather than padding.
    // The audio barrel is an eager glob over the whole module tree; on a COLD
    // vite transform cache that one import measured 28s here, against vitest's
    // 10s default. The hook then fails with `Hook timed out` and SKIPS every
    // test below it — a red that names the harness and says nothing about the
    // subject, and which only appears after an unrelated edit invalidates the
    // cache. Anything that reads a registry from a `beforeAll` has this.
  }, 120_000);

  // ── THE DROP LEG ─────────────────────────────────────────────────────────
  //
  // ⚠ WHAT STOOD HERE UNTIL THE DEFS WERE DELETED, and why it matters that it
  // did. This block was authored as the PRE-DELETION POSITIVE CONTROL: with
  // `group` and `sticky` still registered it asserted the rack loads WHOLE —
  // all seven nodes present, all four cables present, `diagnostics` empty.
  // Every one of those assertions is the exact negation of the ones below, so
  // watching them go red exactly when the defs left the registry is what proves
  // this leg tests the DELETION and not the fixture. (The control was also run
  // the other way at authoring time, before anything was deleted, by making the
  // meta barrel reject the two types: the same three assertions went red then,
  // with the diagnostics quoted below, while the fixture-contents block above
  // stayed green.)

  it('DROP: both meta nodes are ABSENT — the rack loads WITHOUT them', () => {
    expect(nodes['grp-1']).toBeUndefined();
    expect(nodes['stk-1']).toBeUndefined();
    expect(
      Object.values(nodes).some((x) => x?.type === 'group' || x?.type === 'sticky'),
      'no node may carry a retired type',
    ).toBe(false);
  });

  it('DROP: the five ordinary nodes survive INTACT — position, params and all', () => {
    // The whole point of "loads gracefully": what is left is a working rack,
    // not a husk. Asserted by VALUE, not by count.
    expect(Object.keys(nodes).sort()).toEqual(
      ['dly-1', 'lfo-1', 'out-1', 'vco-1', 'vco-2'].sort(),
    );
    expect(nodes['vco-1']!.type).toBe('analogVco');
    expect(nodes['vco-1']!.position).toEqual({ x: 40, y: 120 });
    expect(nodes['vco-1']!.params).toEqual({ tune: 7, fine: -12 });
    expect(nodes['dly-1']!.params).toEqual({ time: 0.375, feedback: 0.55, mix: 0.5 });
  });

  it('DROP: the two children OUTLIVE their group, carrying an inert parentGroupId', () => {
    // A child is an ordinary registered module, so it survives its container.
    // Its stale `data.parentGroupId` now points at nothing — harmless, because
    // the lane filter that read it is deleted too, but stated so the next
    // reader knows the field is expected to be there and expected to be inert.
    for (const id of ['vco-1', 'dly-1']) {
      expect(nodes[id]).toBeDefined();
      expect((nodes[id]!.data as { parentGroupId?: string }).parentGroupId).toBe('grp-1');
    }
  });

  it('DROP: exactly the two cables that touched the group are gone', () => {
    for (const id of CABLES_TOUCHING_THE_GROUP) {
      expect(edges[id], `${id} terminated on the group and must be gone`).toBeUndefined();
    }
    // ⚠ THE OTHER HALF, and it is the one that would go unnoticed: a loader that
    // dropped EVERYTHING would pass the assertion above. Both survivors are
    // checked by ENDPOINT, not merely for presence.
    expect(edges['e-internal']!.source).toEqual({ nodeId: 'vco-1', portId: 'saw' });
    expect(edges['e-internal']!.target).toEqual({ nodeId: 'dly-1', portId: 'audio' });
    expect(edges['e-control']!.source).toEqual({ nodeId: 'vco-2', portId: 'triangle' });
    expect(edges['e-control']!.target).toEqual({ nodeId: 'out-1', portId: 'R' });
    expect(Object.keys(edges).sort()).toEqual([...CABLES_THAT_MUST_SURVIVE].sort());
  });

  it('DROP: one unknown-type diagnostic per retired node, naming the type', () => {
    for (const [nodeId, type] of [['grp-1', 'group'], ['stk-1', 'sticky']] as const) {
      const d = diagnostics.filter((x) => x.nodeId === nodeId);
      expect(d, `${nodeId} must carry exactly one diagnostic`).toHaveLength(1);
      expect(d[0]!.type).toBe(type);
      expect(d[0]!.reason).toBe(LOAD_DIAGNOSTIC_REASONS.unknownType);
    }
  });

  it('DROP: each orphaned cable carries its own diagnostic (exact set)', () => {
    const orphaned = diagnostics
      .filter((d) => d.reason === LOAD_DIAGNOSTIC_REASONS.orphanEdge)
      .map((d) => d.nodeId)
      .sort();
    expect(
      orphaned,
      'exactly the two cables that touched the group — no more, and no fewer',
    ).toEqual([...CABLES_TOUCHING_THE_GROUP].sort());
  });

  it('DROP: the user is TOLD — the load is summarised, naming both types', () => {
    // The half #1033 promised and did not build: without this the whole thing
    // degrades "gracefully" into a rack that silently lost nodes and cables,
    // with the only evidence in a console nobody has open.
    const summary = summarizeLoadDiagnostics(diagnostics);
    expect(summary, 'a load that dropped nodes MUST produce a notice').not.toBeNull();
    expect(summary!).toMatch(/group/);
    expect(summary!).toMatch(/sticky/);
    expect(summary!).toMatch(/could not be loaded/);
    expect(summary!).toMatch(/2 cables removed/);
  });

  it('DROP: nothing threw — the load COMPLETED', () => {
    // Implied by every assertion above (the beforeAll would have failed), but
    // stated because "a crash on legacy patch load is a release blocker" is the
    // literal requirement this file exists to discharge.
    expect(diagnostics).toHaveLength(4); // 2 nodes + 2 orphaned cables
  });

  // ── Determinations that hold in BOTH worlds ──────────────────────────────

  it('neither type is aliased onto a replacement (the anti-alias control)', () => {
    // A future alias would make the drop leg silently pass by migrating the
    // node instead of dropping it. Same permanent control the precedent uses.
    expect(Object.keys(RETIRED_TYPE_ALIASES)).not.toContain('group');
    expect(Object.keys(RETIRED_TYPE_ALIASES)).not.toContain('sticky');
  });

  it('the loader has ONE reason string for an unregistered type', () => {
    // The drop leg asserts on this exact string; pin it so a re-word cannot
    // silently reclassify a dropped node as a friendly "migrated" note.
    expect(LOAD_DIAGNOSTIC_REASONS.unknownType).toBe('module type not registered in this build');
    expect(LOAD_DIAGNOSTIC_REASONS.orphanEdge).toBe('edge references a dropped node');
  });

  it('RENDERER: an unregistered type renders through SvelteFlow, never a throw', () => {
    // The pure half of the renderer determination, restated for a fleet with no
    // cards. It used to run `isShellSwappable(type, false)` and assert the kind
    // short-circuited to `'legacy'` — the verbatim-card arm. There is no such
    // arm: an unregistered type is not carved out either, so it resolves
    // `'shell'` and emits `moduleShell`. The property that matters is unchanged
    // and is the one this leg's title names — the decision is TOTAL and returns
    // a string for a type the registry has never heard of, so nothing throws on
    // the way to xyflow, which resolves `nodeTypes[type] ?? DefaultNode`.
    for (const type of ['group', 'sticky']) {
      expect(isLaneNative(type), 'a dropped type is not a lane-native carve-out').toBe(false);
      const kind = laneRenderKind({ userDocked: false, type, laneNative: isLaneNative(type) });
      expect(kind).toBe('shell');
      expect(emittedTypeFor(kind, type)).toBe('moduleShell');
    }
  });

  it('SAVE: a re-save cannot resurrect a dropped node', () => {
    // The save path encodes the LIVE store, so it can only ever contain what
    // the load kept — a dropped node cannot be resurrected by saving.
    const env = makeStateOnlyEnvelope(dest.ydoc, undefined);
    const back = new Y.Doc();
    Y.applyUpdate(back, Uint8Array.from(atob(env.update), (c) => c.charCodeAt(0)));
    const resaved = back.getMap('nodes').toJSON() as Record<string, ModuleNode>;
    expect(Object.keys(resaved).sort()).toEqual(
      Object.keys(nodes).filter((k) => nodes[k]).sort(),
    );
  });
});
