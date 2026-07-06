// packages/web/src/lib/graph/node-versions.svelte.ts
//
// NODE-SCOPED version registry (phase 2 of the MIDI-CC perf fix) —
// replaces the ~18 per-component `ydoc.on('update')` version pumps
// (ModuleTitle mounted once per card + every sequencer-style card +
// PatchPanel + surface cards). Each of those bumped its own $state on
// EVERY transaction, so a CC settle commit on ONE module invalidated the
// whole derived chain of EVERY mounted card.
//
// Instead: ONE `nodes.observeDeep` per doc maintains a SvelteMap of
// per-nodeId versions — `event.path[0]` is the nodeId for any change
// under nodes[id] (params/data/label/position), a root-level event's
// `changes.keys` covers add/remove — plus coarse edges / structural /
// whole-doc counters. SvelteMap gives PER-KEY reactivity: a $derived
// reading `nodeVersion(id)` subscribes to only that key's signal, so a
// commit touching node X re-runs ONLY X's card deriveds.
//
// Bumps happen exclusively inside the Yjs observers (transaction cleanup
// — never inside a derived), so there is no state_unsafe_mutation hazard;
// the read path NEVER writes the map. Undo/redo inverse ops and remote
// provider updates run through transactions like everything else →
// observer parity with the old whole-doc pumps.
//
// The registry attaches EAGERLY at module init and re-attaches via
// onBindRackspace (the same rebind seam the snapshot bus uses), clearing
// per-node state so versions never leak across rackspaces.

import type * as Y from 'yjs';
import { SvelteMap } from 'svelte/reactivity';
import { ydoc, onBindRackspace } from './store';

const versions = new SvelteMap<string, number>();
let edgesV = $state(0);
/** Node add/remove only. */
let structuralV = $state(0);
/** Any transaction — the legacy whole-doc escape hatch (MatrixMix). */
let docV = $state(0);

let detachCurrent: (() => void) | null = null;

function attach(doc: Y.Doc): void {
  const nodes = doc.getMap('nodes');
  const edges = doc.getMap('edges');
  const onNodesDeep = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>): void => {
    const touched = new Set<string>();
    for (const ev of events) {
      if (ev.path.length > 0) {
        // Nested change under nodes[id] — params/data/position/name, and
        // deep-data key reassigns under a stable data ref (sequencer
        // steps) that content/ref comparison can never see.
        touched.add(String(ev.path[0]));
      } else {
        // Root map event: entry add / replace / delete.
        structuralV++;
        for (const k of ev.changes.keys.keys()) touched.add(k);
      }
    }
    for (const id of touched) versions.set(id, (versions.get(id) ?? 0) + 1);
  };
  const onEdgesDeep = (): void => {
    edgesV++;
  };
  const onDocUpdate = (): void => {
    docV++;
  };
  nodes.observeDeep(onNodesDeep);
  edges.observeDeep(onEdgesDeep);
  doc.on('update', onDocUpdate);
  detachCurrent = () => {
    try {
      nodes.unobserveDeep(onNodesDeep);
      edges.unobserveDeep(onEdgesDeep);
      doc.off('update', onDocUpdate);
    } catch {
      /* old doc may be destroyed */
    }
  };
}

attach(ydoc);
onBindRackspace((_nextPatch, nextDoc) => {
  detachCurrent?.();
  detachCurrent = null;
  // New rackspace = new id space: drop per-node state and bump every
  // coarse counter so anything mounted across the swap re-derives.
  versions.clear();
  structuralV++;
  edgesV++;
  docV++;
  attach(nextDoc);
});

/** Reactive per-node version: bumps when ANYTHING under nodes[id] changes
 *  (including its add/remove). Reading inside a $derived subscribes to
 *  only this id's signal. */
export function nodeVersion(id: string): number {
  return versions.get(id) ?? 0;
}

/** Reactive version of the edges root map (any patch/unpatch). */
export function edgesVersion(): number {
  return edgesV;
}

/** Reactive version of node ADD/REMOVE only. */
export function nodesStructuralVersion(): number {
  return structuralV;
}

/** Reactive whole-doc version — one bump per transaction. The legacy
 *  pump semantic, for the rare genuinely-global consumer. */
export function docVersion(): number {
  return docV;
}
