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
import { LOAD_DIAGNOSTIC_REASONS } from './load-diagnostics';
import {
  laneRenderKind,
  emittedTypeFor,
  isShellSwappable,
} from '$lib/ui/workflow/legacy-fallback';
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

describe('loading the frozen rack in THIS build', () => {
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

  // ⚠ THIS BLOCK IS THE PRE-DELETION POSITIVE CONTROL AND IS MEANT TO BE
  // REPLACED. While `group` and `sticky` are still registered the rack loads
  // WHOLE — which is precisely what makes every assertion the drop leg will
  // make currently FALSE. Landing it first is how we know the drop leg tests
  // the deletion and not the fixture. The commit that removes the two defs
  // replaces this block with the drop leg.

  it('every node survives, including the two meta nodes', () => {
    expect(Object.keys(nodes).sort()).toEqual(
      ['dly-1', 'grp-1', 'lfo-1', 'out-1', 'stk-1', 'vco-1', 'vco-2'].sort(),
    );
    expect(nodes['grp-1']!.type).toBe('group');
    expect(nodes['stk-1']!.type).toBe('sticky');
  });

  it('every cable survives — including the two that terminate on the group', () => {
    // The group's exposed handles resolve through `resolveExposedPort` inside
    // `validateEdge`, which is why a cable to a def-less group node validates.
    for (const id of [...CABLES_TOUCHING_THE_GROUP, ...CABLES_THAT_MUST_SURVIVE]) {
      expect(edges[id], `${id} must survive while group is registered`).toBeDefined();
    }
  });

  it('the load is clean — nothing to tell the user', () => {
    expect(diagnostics).toEqual([]);
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

  it('RENDERER: a type with no card renders through SvelteFlow, never a throw', () => {
    // The pure half of the renderer determination. With the defs gone the type
    // is not in the card map, so `isShellSwappable` is false, `laneRenderKind`
    // short-circuits to 'legacy' and the raw type is emitted; xyflow's
    // NodeWrapper resolves `nodeTypes[type] ?? DefaultNode`.
    for (const type of ['group', 'sticky']) {
      const kind = laneRenderKind({
        shellFaces: true,
        userDocked: false,
        type,
        hasCard: isShellSwappable(type, /* hasResolvableCard */ false),
        migrated: false,
      });
      expect(kind).toBe('legacy');
      expect(emittedTypeFor(kind, type)).toBe(type);
    }
  });

  it('SAVE: re-saving the loaded rack round-trips whatever survived, and nothing more', () => {
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
