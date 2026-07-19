// packages/web/src/lib/ui/canvas/import-confirm.ts
//
// PURE guard decision for the destructive "Import JSON" path (persistence-
// hardening P4). `loadEnvelopeIntoStore` clears-then-re-adds the whole graph;
// in a shared rack that clear propagates tombstones to every peer + the relay
// snapshot + the journal — a durable, multi-user content wipe. So before that
// step, when the current rack is NON-EMPTY, we confirm.
//
// Framework-free + injectable so the decision is unit-testable without a
// browser (the Svelte call site passes `() => window.confirm(MSG)`).

/** Copy shown in the confirm dialog. Mirrors the resetSession confirm on
 *  r/[id]/+page.svelte — explicit that the wipe is multi-user. */
export const IMPORT_REPLACE_CONFIRM_MESSAGE =
  'Replace the current rack with the imported patch? This clears the existing modules for everyone in this rack.';

/**
 * Decide whether a destructive import may proceed.
 *
 *   - Empty rack (nodeCount <= 0): nothing to clobber → proceed WITHOUT
 *     prompting (`confirmFn` is not called).
 *   - Non-empty rack: ask; return whatever the user chose.
 *
 * @param currentNodeCount `Object.keys(patch.nodes).length` at call time.
 * @param confirmFn        a `() => boolean` (e.g. `() => window.confirm(msg)`).
 * @returns `true` to proceed with the destructive load, `false` to abort.
 */
export function confirmDestructiveImport(
  currentNodeCount: number,
  confirmFn: () => boolean,
): boolean {
  if (currentNodeCount <= 0) return true;
  return confirmFn();
}
