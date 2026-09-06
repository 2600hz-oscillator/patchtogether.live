// packages/web/src/lib/audio/live-node-data.ts
//
// THE HYDRATE-ONCE SEAM — re-read what a factory captured at spawn.
//
// ── WHY A FACTORY'S `node.data` READ GOES STALE ─────────────────────────────
// Every module factory receives `node` once and most read their discrete
// settings off `node.data` right there: a MIDI channel, a device name, an
// output sink. The reconciler then re-materializes a node ONLY on id-absence
// or a type/domain change and NEVER diffs `node.data` (reconciler.ts, the
// `appliedDataRefs` block). A SAME-SESSION load — `loadEnvelopeIntoStore`
// deleting and re-inserting every node in one transaction at the SAME ids —
// therefore leaves every engine handle exactly as it was, holding the previous
// patch's settings while the doc (and every surface reading the doc) shows the
// loaded ones. A MIDI-CV-BUDDY listening on the wrong channel is silence with
// every lamp green; an AUDIO OUT on the wrong sink is silence on the speakers
// the user is looking at. The 2026-09-06 fleet audit named this family
// (findings #4 and #8) after the SAMSLOOP load-silence report.
//
// ── THE SHAPE ───────────────────────────────────────────────────────────────
// A module keeps reading its settings the way it always has, and additionally
// watches a PROJECTION of the live node — the handful of keys it hydrated —
// for a change, re-applying through the SAME setters its surface uses. The
// projection is compared by value, so the watcher is quiet for the whole life
// of an unchanged node and fires once per real change. Reads go through
// `livePatch.nodes[id]`, never a captured proxy: after a same-session load the
// factory's `node` is a DETACHED object and reading it would report the
// previous patch forever (the samsloop/warrensspectrum finding).
//
// ⚠ A POLL, DELIBERATELY. The doc has no per-node "replaced" event that
// survives delete+re-insert (an observer on the old Y.Map dies with it), and a
// reconciler-side hook would hand an unknown `write` key to every handle in the
// fleet. dx7 (100 ms) and samsloop (200 ms) already poll for the same reason;
// this is that pattern with one implementation instead of a sixth copy. The
// projection is a few scalar reads off a SyncedStore proxy, four times a
// second — not a per-frame cost.
//
// ⚠ NEVER WRITES. A watcher that "repaired" the doc would be an untagged Y.Doc
// write racing the load; the loaded data is the truth and the engine follows.

import { patch as livePatch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';

/** How often a hydrate projection is re-read. Slow enough to be free, fast
 *  enough that a loaded patch is live before its first note. */
export const LIVE_DATA_POLL_MS = 250;

/** The live node for an id, or undefined when the graph no longer has it. */
export function readLiveNode(nodeId: string): ModuleNode | undefined {
  return livePatch.nodes[nodeId] as ModuleNode | undefined;
}

export interface LiveNodeWatchOptions<T> {
  nodeId: string;
  /** What the factory hydrated from — the baseline the first diff runs
   *  against. Pass the projection of the factory's own `node`. */
  initial: T;
  /** Pure projection of the keys this module hydrates. Must tolerate a
   *  missing `data` (a fresh node has none). */
  project: (node: ModuleNode) => T;
  /** Called once per change with the NEW and PREVIOUS projection. Apply
   *  per-key: a load that moves one setting must not re-fire the others. */
  onChange: (next: T, prev: T) => void;
  intervalMs?: number;
  /** Injectable for tests; defaults to the globals. */
  schedule?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}

/** Value equality for a projection: projections are small plain objects of
 *  scalars/arrays, so a stable JSON encoding is an exact comparison. */
export function projectionsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Watch the LIVE node for a change in `project(node)` and re-apply it.
 *
 * Returns the stop function; call it from the handle's `dispose`. A missing
 * live node (the id left the graph, or a unit test that never inserted it) is
 * skipped rather than treated as a change — the reconciler disposes the handle
 * on removal, and nothing should be re-applied to a node that is going away.
 */
export function watchLiveNodeData<T>(opts: LiveNodeWatchOptions<T>): () => void {
  const schedule = opts.schedule ?? {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  let prev = opts.initial;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    const live = readLiveNode(opts.nodeId);
    if (!live) return;
    let next: T;
    try {
      next = opts.project(live);
    } catch {
      return; // a half-written node mid-transaction; the next tick re-reads
    }
    if (projectionsEqual(next, prev)) return;
    const before = prev;
    prev = next;
    try {
      opts.onChange(next, before);
    } catch (err) {
      console.warn(`[live-node-data] re-apply failed for ${opts.nodeId}`, err);
    }
  };
  const handle = schedule.setInterval(tick, opts.intervalMs ?? LIVE_DATA_POLL_MS);
  return () => {
    if (stopped) return;
    stopped = true;
    schedule.clearInterval(handle);
  };
}
