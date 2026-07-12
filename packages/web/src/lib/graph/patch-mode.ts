// packages/web/src/lib/graph/patch-mode.ts
//
// CROSS-MODE PATCH-IMPORT GUARD (owner directive): a patch made in a WORKFLOW
// rack must NOT be importable into a DAWLESS (non-workflow) rack, and a dawless
// patch must NOT be importable into a workflow rack. The importer FAILS THE LOAD
// with a clear user-facing error instead of half-loading a rack the patch was
// never authored for (a workflow patch carries pinned singletons + default
// wires that make no sense in a dawless rack, and vice-versa).
//
// This module owns the two PURE, framework-free (no Svelte, no Yjs) decisions
// the loaders call as a PRECONDITION — before any destructive step:
//
//   * detectPatchMode(patch)          — what mode was the incoming patch made in?
//   * assertLoadable(patchMode, rack)  — may it load into THIS rack? (+ message)
//   * stampEnvelopeMode(env, mode)     — record the source mode on an export.
//
// mode DETECTION is stamp-first, infer-second:
//   * NEW exports carry an explicit `mode` field (the stamp) — authoritative.
//   * LEGACY exports (saved before this shipped) have no stamp, so we INFER
//     from CONTENT: a workflow rack always contains pinned singletons
//     (data.pinned), the default-wire latch (data.workflowDefaultWired), and/or
//     hiddenCard nodes; a dawless patch contains none of those. Any such marker
//     present ⇒ 'workflow', else 'dawless'.
//
// The node markers mirror the predicates in workflow-pins.ts (isPinnedNode) and
// hidden-card.ts (isHiddenCardNode) — kept as a local structural read here so
// this stays Yjs/registry-free and unit-tests against plain fixtures.

import type { RackMode } from './rack-mode';

/** Minimal node shape the mode inference inspects — just the workflow markers
 *  that live on `node.data` (the platform's home for cross-cutting per-node
 *  keys). Structural so callers pass plain decoded objects. */
export interface PatchModeNode {
  type?: string;
  data?: {
    /** Pinned always-on singleton (workflow M/E/C trio + topbar surfaces). */
    pinned?: unknown;
    /** Headless "render no card" instance (workflow camera manager). */
    hiddenCard?: unknown;
    /** The one-shot MIXMSTRS→AUDIO OUT default-wire latch (pinned audioOut). */
    workflowDefaultWired?: unknown;
  } | null;
}

/** The patch a loader hands the guard: an optional explicit mode STAMP (from a
 *  new export's envelope/manifest) plus the decoded nodes (for legacy
 *  inference). Either may be absent — see detectPatchMode. */
export interface PatchModeInput {
  /** The `mode` stamp read off the export (envelope.mode / manifest.mode).
   *  Absent/garbage for a legacy export ⇒ fall back to node inference. */
  mode?: unknown;
  /** Decoded patch nodes for content inference (empty ⇒ dawless). */
  nodes?: readonly PatchModeNode[] | null;
}

/**
 * Coerce a raw stamp value to a RackMode, or null when it isn't one of the two
 * known modes. Distinct from rack-mode.ts's `normalizeRackMode` (which coerces
 * anything, incl. undefined, to 'dawless'): here an ABSENT stamp must return
 * null so detectPatchMode falls through to content inference rather than
 * silently deciding 'dawless'.
 */
export function normalizeStampMode(value: unknown): RackMode | null {
  return value === 'workflow' || value === 'dawless' ? value : null;
}

/** True when a node carries any workflow-only marker (pinned / hiddenCard /
 *  default-wire latch). A dawless patch's nodes carry none of these. */
export function hasWorkflowMarker(node: PatchModeNode | null | undefined): boolean {
  const d = node?.data;
  if (!d) return false;
  return d.pinned === true || d.hiddenCard === true || d.workflowDefaultWired === true;
}

/** Infer the mode from patch CONTENT (the legacy, stamp-less path): any
 *  workflow marker present ⇒ 'workflow', else 'dawless'. */
export function inferPatchMode(nodes: readonly PatchModeNode[] | null | undefined): RackMode {
  if (nodes) {
    for (const n of nodes) if (hasWorkflowMarker(n)) return 'workflow';
  }
  return 'dawless';
}

/**
 * Determine the mode the incoming patch was authored in. Stamp-first: a valid
 * explicit `mode` stamp wins; otherwise INFER from the decoded nodes. Pure.
 */
export function detectPatchMode(patch: PatchModeInput): RackMode {
  const stamped = normalizeStampMode(patch.mode);
  if (stamped) return stamped;
  return inferPatchMode(patch.nodes);
}

/**
 * Stamp the source rack's `mode` onto an export payload (raw-JSON envelope /
 * perf-zip manifest input). Additive + backward-compatible: an old importer
 * that doesn't read `mode` simply ignores it. Returns a new object (does not
 * mutate the input).
 */
export function stampEnvelopeMode<T extends object>(env: T, mode: RackMode): T & { mode: RackMode } {
  return { ...env, mode };
}

/** The verdict of the cross-mode precondition. On failure it carries the
 *  user-facing message the loader surfaces (visible notice, never a bare
 *  console.error). */
export type LoadableVerdict = { ok: true } | { ok: false; message: string };

/** User-facing rejection messages, one per mismatch direction. Exported so a
 *  test (or a future toast component) can assert the exact copy. */
export const CROSS_MODE_MESSAGES = {
  /** A workflow patch dropped onto a dawless rack. */
  workflowIntoDawless:
    'This patch was made in a WORKFLOW rack — open a workflow rack to load it.',
  /** A dawless patch dropped onto a workflow rack. */
  dawlessIntoWorkflow: 'This is a dawless patch — load it in a dawless rack.',
} as const;

/**
 * May a patch authored in `patchMode` load into a rack running `rackMode`?
 * Same mode ⇒ ok. Cross-mode ⇒ { ok:false } with the direction-specific
 * message. Pure — the loader decides what to do with a failure (surface the
 * message + abort BEFORE any destructive step).
 */
export function assertLoadable(patchMode: RackMode, rackMode: RackMode): LoadableVerdict {
  if (patchMode === rackMode) return { ok: true };
  return {
    ok: false,
    message:
      patchMode === 'workflow'
        ? CROSS_MODE_MESSAGES.workflowIntoDawless
        : CROSS_MODE_MESSAGES.dawlessIntoWorkflow,
  };
}
