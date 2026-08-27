// packages/web/src/lib/audio/modules/score-transport-deps.ts
//
// SCORE's quicksave wiring, as ONE object both surfaces build.
//
// ⚠ WHY THIS IS EXTRACTED RATHER THAN COPIED. This is 70 lines of live-read
// discipline whose `nodeId` GETTER records a real bug in its own comment below:
// XYFlow may reuse a card instance for a different node, and a captured `nodeId`
// would write this sequencer's quicksave slots into ANOTHER node. A second copy
// in the faceplate's slots panel is that bug waiting to be reintroduced in a
// file nobody associates with it.
//
// ⚠ AND FOUR DECLARED INPUT PORTS DEPEND ON THIS WIDGET EXISTING ON THE
// FACEPLATE AT ALL. `queue1_cv … queue4_cv` resolve through
// `pollTransportCv → pickQueuedSlotFromEvents → data.queuedSlot →
// maybeApplyQueuedSlot → data.slots[queued]`, and `data.slots` is written by
// exactly one thing in the repo: `handleSlotClick`, driven by
// `QuicksaveControls.svelte`. Promote SCORE without a quicksave surface and four
// of its eleven inputs fire, resolve a slot, find it empty and clear
// `queuedSlot` — declared, documented, and permanently inert.
//
// ⚠ THE TRANSACT IS ORIGIN-TAGGED. `ScoreCard.svelte` passed
// `(fn) => ydoc.transact(fn)`, i.e. origin `null`, which the UndoManager's
// `trackedOrigins: new Set([LOCAL_ORIGIN])` silently does not capture — so
// SAVE / LOAD / QUEUE were outside Cmd-Z along with every note. `mutateDoc`
// tags it.

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ScoreNote, DynamicMarker, Tie } from './score-data';
import { MAX_PAGES, DEFAULT_PAGES, coerceScoreData } from './score-data';
import type { TransportCardDeps } from './transport-card';
import type { Snapshot } from './transport-helpers';

/**
 * Build SCORE's `TransportCardDeps` for one node.
 *
 * ⚠ `nodeId` IS A GETTER, NOT A CAPTURED STRING, and that is load-bearing:
 * every other field re-reads `patch.nodes[nodeId]` live, and a plain
 * `nodeId: id` would freeze the id at construction. XYFlow may reuse a card
 * instance for a different node, and a stale id would write this sequencer's
 * quicksave slots into a different module.
 */
export function createScoreTransportDeps(getNodeId: () => string): TransportCardDeps {
  return {
    get nodeId() {
      return getNodeId();
    },
    patch,
    transact: (fn) => ydoc.transact(fn, LOCAL_ORIGIN),
    snapshot: (): Snapshot => {
      const t = patch.nodes[getNodeId()];
      const d = coerceScoreData(t?.data);
      return {
        notes: d.notes.map((n) => ({ ...n })),
        dynamics: d.dynamics.map((m) => ({ ...m })),
        ties: d.ties.map((tt) => ({ ...tt })),
        keySignature: d.keySignature,
        pages: d.pages,
        loop: d.loop,
        stopBar: d.stopBar ? { ...d.stopBar } : undefined,
        bpm: t?.params.bpm ?? 120,
        attack: t?.params.attack ?? 0.005,
        decay: t?.params.decay ?? 0.1,
        sustain: t?.params.sustain ?? 0.7,
        release: t?.params.release ?? 0.3,
      };
    },
    applySnapshot: (snap: Snapshot) => {
      const t = patch.nodes[getNodeId()];
      if (!t) return;
      // Deep-clone array/object fields: the snapshot may itself live inside
      // `slots[N]`, and Yjs forbids the same Y.Map appearing at two paths
      // ("Not supported: reassigning object that already occurs in the tree").
      ydoc.transact(() => {
        if (!t.data) t.data = {};
        const td = t.data as Record<string, unknown>;
        if (Array.isArray(snap.notes)) {
          td.notes = (snap.notes as ScoreNote[]).map((n) => ({ ...n }));
        }
        if (Array.isArray(snap.dynamics)) {
          td.dynamics = (snap.dynamics as DynamicMarker[]).map((d) => ({ ...d }));
        }
        if (Array.isArray(snap.ties)) {
          td.ties = (snap.ties as Tie[]).map((tt) => ({ ...tt }));
        }
        if (typeof snap.keySignature === 'number') td.keySignature = snap.keySignature;
        if (typeof snap.pages === 'number') {
          td.pages = Math.max(1, Math.min(MAX_PAGES, snap.pages)) || DEFAULT_PAGES;
        }
        if (typeof snap.loop === 'boolean') td.loop = snap.loop;
        if (snap.stopBar && typeof snap.stopBar === 'object') {
          const sb = snap.stopBar as { bar: number; tick: number };
          td.stopBar = { bar: sb.bar, tick: sb.tick };
        } else if ('stopBar' in snap) {
          td.stopBar = undefined;
        }
        // ⚠ THE SELECTION IS CLEARED, NOT CARRIED. A snapshot restores a
        // DIFFERENT roster of notes, so a surviving `selectedNoteId` would name
        // a note that no longer exists. `readSelectedNote` resolves against the
        // live roster and would return null anyway; clearing it here is what
        // keeps `node.data` from accumulating a dead key.
        td.selectedNoteId = null;
        for (const k of ['bpm', 'attack', 'decay', 'sustain', 'release'] as const) {
          const v = snap[k];
          if (typeof v === 'number') t.params[k] = v; // guard:allow-raw-write
        }
      }, LOCAL_ORIGIN);
    },
  };
}
