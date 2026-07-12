// packages/web/src/lib/graph/rack-mode.ts
//
// WORKFLOW MODE P1 — the rack MODE seam.
//
// A rackspace is either 'dawless' (the existing rack UI, unchanged) or
// 'workflow' (the workflow shell: WorkflowTopbar + left rail + pinned
// M/E/C drawer singletons). The AUTHORITATIVE value is the `racks.mode`
// DB column (db/schema/005_rackspace_mode.sql), served to the client by
// /r/[id]/+page.server.ts — the shell renders from that server value.
//
// This module owns:
//   - the shared `RackMode` type + `normalizeRackMode` (old rows / absent
//     values / garbage all read as 'dawless'), used by BOTH the server
//     data layer (lib/server/rackspaces.ts) and the client;
//   - the DOC-META MIRROR: the mode is mirrored into the patch Y.Doc's
//     `rackMeta` map so collaborators + future tooling (P2+ toolbar
//     surfaces, bots, exports) can read the agreed mode straight off the
//     doc without a server round-trip. Members re-assert the server value
//     on mount and whenever the map churns (ensureRackModeInDoc is
//     idempotent), so a foreign snapshot or stray write cannot flip the
//     agreed mode.
//
// The mirror write deliberately uses a NON-tracked transaction origin
// (RACK_MODE_ORIGIN, not LOCAL_ORIGIN) so it never lands on the user's
// Cmd-Z stack — it is programmatic rack identity, not a user edit. (The
// UndoManager only tracks nodes/edges maps anyway; the origin keeps the
// intent explicit and future-proof.)
//
// Dependency-light on purpose: yjs only — no registry imports — so the
// server data layer can import the type + normalizer without dragging
// client module registries into the Worker bundle.

import type * as Y from 'yjs';

/** The two rack shells. See the file header. */
export type RackMode = 'dawless' | 'workflow';

/** The Y.Doc map holding cross-cutting rack IDENTITY meta (mode, …).
 *  Distinct from persistence.ts's 'settings' map (patch content that
 *  loads/saves with the envelope): rack meta describes the CONTAINER and
 *  is re-asserted from the server value, never applied from an import. */
export const RACK_META_MAP_KEY = 'rackMeta';
/** rackMeta entry: the rack mode ('dawless' | 'workflow'). */
export const RACK_META_MODE_KEY = 'mode';

/** Transaction origin for the doc-meta mirror writes. NOT in the
 *  UndoManager's trackedOrigins set → never undoable. */
export const RACK_MODE_ORIGIN = 'rack-mode-mirror';

/**
 * Coerce an unknown persisted value to a RackMode. Anything that isn't
 * exactly 'workflow' — including null/undefined from a pre-migration row
 * — reads as 'dawless', the "old rows must read as dawless" contract.
 */
export function normalizeRackMode(value: unknown): RackMode {
  return value === 'workflow' ? 'workflow' : 'dawless';
}

/** Read the mirrored mode off a live Y.Doc, or null when never written
 *  (e.g. a brand-new doc before any member's ensure ran). */
export function readRackModeFromDoc(ydoc: Y.Doc): RackMode | null {
  const v = ydoc.getMap(RACK_META_MAP_KEY).get(RACK_META_MODE_KEY);
  return v === 'workflow' || v === 'dawless' ? v : null;
}

/**
 * Idempotently mirror `mode` into the doc's rackMeta map. No-op (and no
 * transaction) when the stored value already matches — safe to call from
 * an observer without ping-ponging writes between clients that agree.
 * Returns true when a write happened.
 */
export function ensureRackModeInDoc(ydoc: Y.Doc, mode: RackMode): boolean {
  const meta = ydoc.getMap(RACK_META_MAP_KEY);
  if (meta.get(RACK_META_MODE_KEY) === mode) return false;
  ydoc.transact(() => {
    meta.set(RACK_META_MODE_KEY, mode);
  }, RACK_MODE_ORIGIN);
  return true;
}
