// packages/web/src/lib/ui/media/archivist-status-registry.ts
//
// THE ARCHIVE-BROWSE STATUS SEAM — how a SECOND surface can show, and drive, an
// archive.org search whose three media elements have exactly ONE owner.
//
// WHY THIS EXISTS (the same measured reason `camera-status-registry` exists, on
// the third and last member of `DOM_SOURCE_LANE_TYPES`). Promoting `archivist`
// stops its real card rendering in the lane and moves it into
// `<HeadlessSourceHost>` — which parks at `left:-9999px` with
// `pointer-events: none` and `aria-hidden="true"`. The three NODE-owned
// elements survive that move (see ./node-media-registry) and a loaded item
// keeps playing. What does NOT survive is every INTERACTIVE affordance the card
// draws, because an off-screen pointer-events-none subtree cannot be clicked:
//
//   * SEARCH — the type picker, the term, the year bounds and the Search
//     gesture. This is the whole module. archivist's factory loads nothing on
//     its own: `node.data.item` is null until a search writes one, so a
//     promoted archivist with no reachable search box is a media source that
//     can never be given any media. That is the owner's original "no video at
//     all" P0 reproduced through a third mechanism.
//   * ↻ NEXT — re-roll another random match from the same result page. The
//     module's stated interaction ("picks a RANDOM matching item") only has a
//     second draw through this button.
//   * the TRANSPORT — play/pause, ±10s, the random-position jump and the seek
//     bar for a loaded audio or video item.
//   * the LOAD PROGRESS and the FAILURE text. `statusMsg` names which item is
//     being fetched and `errorMsg` carries the recovery instruction ("No
//     results — try another term or media type"). A spinner with no words
//     cannot say which of the two happened.
//
// WHY A REGISTRY AND NOT A SECOND SEARCH MACHINE. The three elements, the
// fetch/parse/best-file-pick chain, the engine attach and the audio wire have
// ONE owner — `ArchivistCard.svelte` — and that must not change: two callers
// would be two owners, and whichever tore down last would strand the survivor.
// So this file moves no ownership. The card PUBLISHES what it knows and
// REGISTERS its commands; another surface READS the status and INVOKES a
// command. It is a remote control, not a second machine.
//
// ⚠ WHY THE STATUS IS BROWSER-LOCAL AND NEVER TOUCHES Yjs, and why the split is
// not arbitrary. The DURABLE half of archivist's state is already synced:
// `searchTerm`, `mediaType`, `yearFrom`, `yearTo`, `item` and `isPlaying` live
// on `node.data` and always did, so a peer sees the same item. What is in
// THIS registry is the part that is true of ONE browser only — whether THIS tab
// is mid-fetch, what THIS tab's fetch failed with, how many docs THIS tab's
// last search page holds, and where THIS tab's element playhead is. Syncing any
// of them would assert something false about every other participant's machine,
// exactly as `camera-status-registry`'s header says of a permission grant.
//
// ⚠ DELIVERY IS REPORTED, NEVER DROPPED. `request()` returns whether a command
// owner was actually there to receive it. An action-shaped affordance writes
// nothing to the graph, so `readParam`/`readData` are structurally blind to it
// — the returned `delivered` flag is the only observable, and a caller that
// discarded it would make "the button works" and "the button is wired to
// nothing" indistinguishable.
//
// ⚠ THE REQUEST IS A DISCRIMINATED UNION, NOT A BARE COMMAND ID, and that is
// the one place this departs from its two siblings. camera's `acquire()` and
// loopback's `acquire()`/`stop()` take no arguments, so `request(nodeId, id)`
// suffices there. Two of archivist's carry a NUMBER — `skip` a signed delta and
// `seek` an absolute position — and a seam that could not carry it would have
// forced the body to reach the element itself, which is precisely the second
// owner this file exists to prevent. `$lib/ui/media/node-hls-source`'s
// `request(nodeId, { kind, … })` is the in-tree shape and this follows it.
//
// OWNER-CHECKED HAND-OVER, verbatim the discipline ./node-media-registry uses
// and for the same reason: the card is remounted by view moves (lane → headless
// host → dock), Svelte gives no cross-tree ordering guarantee, and a stale
// mount's teardown must never unregister the live one's command.
//
// HASH TRANSPARENCY: this lives under `lib/ui/**`, NOT `lib/video/**` — that
// directory is hashed WHOLESALE for the WebGL attest, so a change there costs a
// GPU re-attest window. Keeping it here is deliberate and is a constraint on any
// future edit: do not move this file.
//
// TESTABILITY: no DOM, no framework, no globals — the web package's vitest runs
// in `environment: 'node'`, and this file needs nothing from a browser.

import type { ArchivistMediaType } from '$lib/video/modules/archivist-query';

/**
 * What the owning card publishes about its search and its loaded element.
 * Everything here is browser-local; none of it is in the shared document.
 */
export interface ArchivistStatus {
  /** A fetch (search or metadata/attach) is in flight. */
  readonly loading: boolean;
  /** Progress prose for the in-flight fetch ("Loading \"…\"…"), else null. */
  readonly statusMsg: string | null;
  /** The card's recovery guidance for a failed search/load, or null. */
  readonly errorMsg: string | null;
  /**
   * How many docs the last search page holds. Zero disables ↻ next exactly as
   * it does on the card, because a re-roll with no page falls back to a full
   * search and the button must not claim otherwise.
   */
  readonly docCount: number;
  /**
   * The live element playhead in seconds. THIS IS THE ONE FIELD THAT TICKS, and
   * it is here rather than on the graph for the reason the whole registry is:
   * writing a per-100ms playhead into Y.Doc is the CV-modulation write storm
   * this repo already has a rule against.
   */
  readonly positionSec: number;
}

/** A request a status consumer may make of the owning card. */
export type ArchivistRequest =
  /** Run a fresh archive.org search from the graph's CURRENT inputs. */
  | { kind: 'search' }
  /** Re-roll another random match from the same result page. */
  | { kind: 'next' }
  /** Toggle play/pause for a loaded time-media item. */
  | { kind: 'togglePlay' }
  /** Nudge the playhead by a signed number of seconds. */
  | { kind: 'skip'; deltaS: number }
  /** Move the playhead to an absolute position in seconds. */
  | { kind: 'seek'; positionS: number }
  /** Jump to a random position in a loaded time-media item. */
  | { kind: 'jumpRandom' };

/** Which command a request names — the handler map's keys. */
export type ArchivistCommandId = ArchivistRequest['kind'];

/**
 * The commands a status consumer may invoke on the owning card.
 *
 * ⚠ `search` AND `next` READ THEIR INPUTS FROM THE GRAPH, NOT FROM ARGUMENTS,
 * and that is load-bearing rather than a simplification. The type, term and
 * year bounds are Y.Doc-synced `node.data` keys with two possible writers (the
 * legacy card's controls and the faceplate's), so passing them through this
 * seam would mean the surface that INVOKED the search decided the query — and a
 * search invoked from the tile would then use a term the dock's box had already
 * replaced. The graph is the single answer; the handler reads it.
 */
export interface ArchivistCommands {
  search(): void;
  next(): void;
  togglePlay(): void;
  skip(deltaS: number): void;
  seek(positionS: number): void;
  jumpRandom(): void;
}

/** A card's claim on a node's command slot. `release()` is idempotent AND
 *  owner-checked: it does nothing once another mount has registered. */
export interface ArchivistCommandLease {
  release(): void;
}

/** What `request()` reports. See the DELIVERY paragraph in the header. */
export interface ArchivistRequestResult {
  /** Was a command owner registered to receive this? */
  readonly delivered: boolean;
  /** Set when the owner's handler threw — delivered is still true. */
  readonly error: unknown;
}

export interface ArchivistStatusRegistry {
  /** The owning card publishes its current search/playback state. */
  publish(nodeId: string, status: ArchivistStatus): void;
  /** The current status for a node, or null when no card has published one —
   *  which is a REAL state a consumer must render ("no card is mounted"), not a
   *  missing value to paper over. */
  read(nodeId: string): ArchivistStatus | null;
  /**
   * The owning card registers its command handlers. TRANSFERS ownership away
   * from any previous mount, so mount/unmount ORDER between two component trees
   * cannot strand the slot.
   */
  registerCommands(nodeId: string, commands: ArchivistCommands): ArchivistCommandLease;
  /** Is a command owner currently registered? Lets a consumer disable an
   *  affordance it cannot deliver rather than offering a dead button. */
  hasCommands(nodeId: string): boolean;
  /** Invoke one command. Reports delivery — see the header. */
  request(nodeId: string, req: ArchivistRequest): ArchivistRequestResult;
  /** Subscribe to status/command-ownership changes for one node. Returns the
   *  unsubscribe. Fires on publish, on register and on release. */
  subscribe(nodeId: string, fn: () => void): () => void;
  /** Drop everything for one node. Called when the node leaves the GRAPH,
   *  never when a card unmounts. */
  clear(nodeId: string): void;
  /** Drop every node NOT present in `liveIds`. The graph is the authority. */
  sweep(liveIds: Iterable<string>): void;
}

/** The status a consumer paints when NO card has published — every field at the
 *  value that makes a surface render "idle, and nothing is in flight". Exported
 *  so a consumer never hand-rolls a fallback that drifts from this one. */
export const ARCHIVIST_STATUS_IDLE: ArchivistStatus = {
  loading: false,
  statusMsg: null,
  errorMsg: null,
  docCount: 0,
  positionSec: 0,
};

/**
 * The media types the picker offers, in the card's own order.
 *
 * ⚠ EXPORTED FROM HERE RATHER THAN RE-TYPED IN EACH SURFACE. Two surfaces now
 * draw this roster (the legacy card's select and the faceplate's), and a
 * hand-copied option list is how one of them silently stops offering a type the
 * query layer supports. `ArchivistMediaType` is the union in
 * `archivist-query.ts`; this is its render order, and `archivist-status-
 * registry.test.ts` asserts the two agree in both directions so a new member of
 * the union cannot ship unreachable.
 */
export const ARCHIVIST_MEDIA_TYPES: readonly ArchivistMediaType[] = [
  'image',
  'audio',
  'video',
  'any',
];

interface Entry {
  status: ArchivistStatus | null;
  commands: ArchivistCommands | null;
  /** Identity of the mount that registered `commands` — the owner check. */
  owner: object | null;
  listeners: Set<() => void>;
}

/** Build a registry. Pure — no DOM, no globals, no transport. */
export function createArchivistStatusRegistry(): ArchivistStatusRegistry {
  const entries = new Map<string, Entry>();

  function entryFor(nodeId: string): Entry {
    let e = entries.get(nodeId);
    if (!e) {
      e = { status: null, commands: null, owner: null, listeners: new Set() };
      entries.set(nodeId, e);
    }
    return e;
  }

  /** Drop everything for one node and tell its consumers. A LOCAL function
   *  rather than a method, so `sweep` can call it without depending on `this`
   *  — the destructuring hazard `camera-status-registry` names at its own
   *  sweep. */
  function clearEntry(nodeId: string): void {
    const e = entries.get(nodeId);
    if (!e) return;
    e.status = null;
    e.commands = null;
    e.owner = null;
    notify(e);
    entries.delete(nodeId);
  }

  function notify(e: Entry): void {
    // Copy before iterating: a listener may unsubscribe itself.
    for (const fn of [...e.listeners]) {
      try {
        fn();
      } catch {
        /* a broken consumer must never break the publisher */
      }
    }
  }

  return {
    publish(nodeId, status) {
      const e = entryFor(nodeId);
      e.status = status;
      notify(e);
    },

    read(nodeId) {
      return entries.get(nodeId)?.status ?? null;
    },

    registerCommands(nodeId, commands) {
      const e = entryFor(nodeId);
      // TRANSFER: the newest mount always wins.
      const token = {};
      e.commands = commands;
      e.owner = token;
      notify(e);
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          // OWNER CHECK: a stale mount's teardown must do nothing once another
          // mount has taken the slot.
          if (e.owner !== token) return;
          e.owner = null;
          e.commands = null;
          notify(e);
        },
      };
    },

    hasCommands(nodeId) {
      return entries.get(nodeId)?.commands != null;
    },

    request(nodeId, req) {
      const c = entries.get(nodeId)?.commands;
      if (!c) return { delivered: false, error: null };
      try {
        switch (req.kind) {
          case 'search': c.search(); break;
          case 'next': c.next(); break;
          case 'togglePlay': c.togglePlay(); break;
          case 'skip': c.skip(req.deltaS); break;
          case 'seek': c.seek(req.positionS); break;
          case 'jumpRandom': c.jumpRandom(); break;
        }
        return { delivered: true, error: null };
      } catch (error) {
        // Delivered but threw: the distinction matters, because "nobody was
        // listening" and "the owner failed" need different fixes.
        return { delivered: true, error };
      }
    },

    subscribe(nodeId, fn) {
      const e = entryFor(nodeId);
      e.listeners.add(fn);
      return () => {
        e.listeners.delete(fn);
      };
    },

    clear: clearEntry,

    sweep(liveIds) {
      const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
      for (const nodeId of [...entries.keys()]) {
        // The LOCAL function, never `this.clear` — see the note on clearEntry.
        if (!live.has(nodeId)) clearEntry(nodeId);
      }
    },
  };
}

/**
 * The process-wide archive-browse status registry.
 *
 * `ArchivistCard.svelte` publishes into it and registers its six commands;
 * `ArchivistBrowseControls.svelte` (mounted by BOTH the card and the faceplate
 * bodies) reads and invokes. Per-tab by construction — see the Yjs paragraph in
 * the header.
 */
export const archivistStatus: ArchivistStatusRegistry = createArchivistStatusRegistry();
