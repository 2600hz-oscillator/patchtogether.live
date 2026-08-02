// packages/web/src/lib/graph/load-diagnostics.ts
//
// THE USER-FACING HALF OF "degrades gracefully".
//
// `loadEnvelopeIntoStore` has skipped unknown module types with a
// `LoadDiagnostic` since #1013, and 18 deleted module types have relied on
// that path. But the only surface it ever reached was `console.warn` — so a
// rack that lost nodes AND every cable touching them loaded "successfully",
// and the sole evidence was in a devtools console nobody has open. #1033
// promised graceful degradation and delivered it IN THE LOADER; the
// user-facing half was never built.
//
// This module is that half, as a PURE function so it is unit-testable at
// zero CI cost: diagnostics in, one human sentence out (or null when there
// is nothing to say). The Canvas renders it as a non-blocking notice next to
// the existing `load-error` surface — never a modal, because the rack DID
// load and the user must be able to keep working.
//
// It benefits every retired type, not just this PR's: the same summary now
// fires for a rack carrying any of the 18.

import type { LoadDiagnostic } from './persistence';

/** The loader's own reason string for a type that no longer resolves. */
const UNKNOWN_TYPE_REASON = 'module type not registered in this build';
/** The loader's own reason string for an edge whose endpoint was dropped. */
const ORPHAN_EDGE_REASON = 'edge references a dropped node';

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Fold a load's diagnostics into ONE non-blocking sentence, or null when the
 * load was clean.
 *
 * The three buckets are named separately on purpose — "1 module could not be
 * loaded" and "1 module was migrated" need opposite reactions from the user
 * (rebuild it vs. re-check its controls), and a single count would hide that.
 * Dropped and invalid edges are folded into one cable count because from the
 * user's side both mean the same thing: a patch cord that is no longer there.
 */
export function summarizeLoadDiagnostics(diagnostics: readonly LoadDiagnostic[]): string | null {
  if (diagnostics.length === 0) return null;

  const droppedTypes = new Map<string, number>();
  const migratedNotes = new Map<string, number>();
  let edgesLost = 0;

  for (const d of diagnostics) {
    if (d.type === 'edge') {
      edgesLost++;
      continue;
    }
    if (d.reason === UNKNOWN_TYPE_REASON) {
      droppedTypes.set(d.type, (droppedTypes.get(d.type) ?? 0) + 1);
      continue;
    }
    // Anything else on a NODE is a migration (or a future per-node note): key
    // it by its reason so the wording the alias table authored survives to
    // the user verbatim rather than being flattened to "changed".
    migratedNotes.set(d.reason, (migratedNotes.get(d.reason) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const [reason, n] of migratedNotes) {
    parts.push(`${plural(n, 'module')} ${reason}`);
  }
  for (const [type, n] of droppedTypes) {
    parts.push(`${plural(n, 'module')} of type \`${type}\` could not be loaded (not in this build)`);
  }
  if (edgesLost > 0) {
    parts.push(`${plural(edgesLost, 'cable')} removed`);
  }
  if (parts.length === 0) return null;
  return `This rack loaded with changes: ${parts.join('; ')}.`;
}

/** Test/asserting helper: does this load contain anything worth surfacing? */
export function hasLoadDiagnostics(diagnostics: readonly LoadDiagnostic[]): boolean {
  return summarizeLoadDiagnostics(diagnostics) !== null;
}

/** Exported for the loader's own reason strings to stay in ONE place. */
export const LOAD_DIAGNOSTIC_REASONS = {
  unknownType: UNKNOWN_TYPE_REASON,
  orphanEdge: ORPHAN_EDGE_REASON,
} as const;
