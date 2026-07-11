// packages/web/src/lib/graph/workflow-pins.ts
//
// WORKFLOW MODE P1 — the PINNED SINGLETON trio + the M/E/C drawer keymap.
//
// Every workflow rackspace always has exactly one MIXMSTRS, one
// ELECTRA CONTROL and one CLIPPLAYER, spawned automatically and flagged
// `data.pinned: true`. Pinned nodes:
//   - render ONLY in their bottom drawer (M / E / C toggles), never as
//     canvas cards (Canvas's flowNodes derivation skips them). This is a
//     REVERSIBLE default pending owner question Q3 (drawer-only vs. also
//     on canvas) — flipping it is deleting one `continue` in Canvas.
//   - are UNDELETABLE: mutate.ts's removePatchNode refuses them, Clear
//     skips them, and the singleton-cleanup pass never plans them.
//   - are EXCLUDED from `maxInstances` counting (graph/cap.ts), so the
//     pinned ELECTRA CONTROL does not consume the type's canvas cap —
//     "additional instances spawn as normal canvas cards".
//
// The pinned flag lives at `node.data.pinned` — the platform's documented
// home for cross-cutting per-node keys (`name`, `controlColor`,
// `rackLocked`) — NOT a new top-level field, so the snapshot bus /
// persistence / sync all carry it with zero plumbing.
//
// DETERMINISTIC IDS make the auto-spawn idempotent under CRDT merge: two
// clients racing the ensure both write `pinned-<type>` and the Y.Map
// converges to ONE entry per type — no duplicate-singleton race, unlike
// the random-id TIMELORDE auto-spawn (which needs the elected-deleter
// cleanup pass to mop up).
//
// PURE + framework-free (no Svelte, no Yjs, no $lib imports beyond types)
// so the plan is unit-testable against plain fixtures; the actual Yjs
// transact lives in Canvas.svelte's workflow ensure $effect.

/** Transaction origin for the pinned-trio auto-spawn. NOT in the
 *  UndoManager's trackedOrigins → the ensure is never undoable (Cmd-Z must
 *  not fight the always-on invariant by removing a pinned module). */
export const WORKFLOW_PIN_SPAWN_ORIGIN = 'workflow-pin-spawn';

/** One pinned singleton spec: the module type, its registry domain, and
 *  the deterministic node id every client agrees on. */
export interface PinnedModuleSpec {
  /** Registered module type id. */
  type: string;
  /** Registry domain the type lives in ('audio' | 'meta'). */
  domain: 'audio' | 'meta';
  /** Deterministic node id (`pinned-<type>`) — the CRDT convergence key. */
  id: string;
  /** Drawer toggle key (lowercase). */
  key: 'm' | 'e' | 'c';
  /** Drawer header label. */
  label: string;
}

/** The workflow trio, in M / E / C order. */
export const WORKFLOW_PINNED_MODULES: readonly PinnedModuleSpec[] = [
  { type: 'mixmstrs', domain: 'audio', id: 'pinned-mixmstrs', key: 'm', label: 'mixmstrs' },
  { type: 'electraControl', domain: 'meta', id: 'pinned-electraControl', key: 'e', label: 'electra control' },
  { type: 'clipplayer', domain: 'audio', id: 'pinned-clipplayer', key: 'c', label: 'clipplayer' },
] as const;

/** Lowercase key → pinned spec (the M/E/C drawer toggles). */
export const DRAWER_KEY_TO_PINNED: ReadonlyMap<string, PinnedModuleSpec> = new Map(
  WORKFLOW_PINNED_MODULES.map((s) => [s.key, s]),
);

/** Minimal node shape the planner inspects. */
export interface PinnedNodeLike {
  type: string;
  data?: { pinned?: unknown } | null;
}

/** True when the node carries the pinned flag. */
export function isPinnedNode(node: PinnedNodeLike | null | undefined): boolean {
  return node?.data?.pinned === true;
}

/**
 * Which of the pinned trio is MISSING from `nodes`? A spec counts as
 * present when any node of its type carries `data.pinned === true` (the
 * deterministic id is how writers converge, but presence is judged by
 * type+flag so a hand-migrated doc still satisfies the invariant).
 *
 * Pure predicate — callers re-check `patch.nodes[spec.id]` inside their
 * Yjs transact before writing (belt + braces; the deterministic id makes
 * a double-write converge anyway).
 */
export function planPinnedSpawns(
  nodes: ReadonlyArray<PinnedNodeLike>,
): PinnedModuleSpec[] {
  const presentTypes = new Set<string>();
  for (const n of nodes) {
    if (isPinnedNode(n)) presentTypes.add(n.type);
  }
  return WORKFLOW_PINNED_MODULES.filter((s) => !presentTypes.has(s.type));
}

/** Minimal event-target shape for the typing guard (structural, so unit
 *  tests need no DOM). Matches HTMLElement's relevant surface. */
export interface TypingTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/**
 * True when a keydown landed in a text-entry context — an <input>,
 * <textarea>, <select> or contenteditable — where the M/E/C drawer keys
 * (and every other single-letter shortcut) must stay INERT so typing
 * "mec" into a module-name box doesn't strobe three drawers.
 */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const t = target as TypingTargetLike;
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return t.isContentEditable === true;
}
