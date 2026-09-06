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
// against the SAME projection of what the ENGINE currently holds, re-applying
// any difference through the setters its surface uses. Reads go through
// `livePatch.nodes[id]`, never a captured proxy: after a same-session load the
// factory's `node` is a DETACHED object and reading it would report the
// previous patch forever (the samsloop/warrensspectrum finding).
//
// ⚠ DOC AGAINST ENGINE, NEVER AGAINST A REMEMBERED SNAPSHOT. The first cut of
// this seam compared the doc to the projection it last saw, and the audio-out
// e2e caught the hole on its first run: the picker's `write()` moved the
// ENGINE to sink B and persisted B, then a load moved the doc back to A —
// both inside one 250 ms poll. "Last seen" was A, the doc read A, nothing
// looked changed, and the engine sat on B. Comparing against what the engine
// actually holds has no such window: any route that moves the engine or the
// doc leaves the two visibly different until they agree.
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
  /** Pure projection of the keys this module hydrates, read off the DOC.
   *  Must tolerate a missing `data` (a fresh node has none). */
  project: (node: ModuleNode) => T;
  /** The same projection of what the ENGINE currently holds — the module's
   *  own live variables, not a copy of the last thing this seam saw. */
  current: () => T;
  /** Called when the two differ, with the doc's value and the engine's.
   *  Apply per-key: a load that moves one setting must not re-fire the
   *  others. Must leave `current()` equal to `next` for every key it owns,
   *  or the seam will (correctly) call again on the next tick. */
  onChange: (next: T, current: T) => void;
  /** Equality override for projections where some keys carry "no opinion"
   *  (a legacy value that only applies when the param path is absent).
   *  Defaults to value equality of the whole projection. */
  equal?: (next: T, current: T) => boolean;
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
 * Watch the LIVE node and re-apply whenever the doc's projection differs from
 * the engine's.
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
  const equal = opts.equal ?? projectionsEqual;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    const live = readLiveNode(opts.nodeId);
    if (!live) return;
    let next: T;
    let cur: T;
    try {
      next = opts.project(live);
      cur = opts.current();
    } catch {
      return; // a half-written node mid-transaction; the next tick re-reads
    }
    if (equal(next, cur)) return;
    try {
      opts.onChange(next, cur);
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
