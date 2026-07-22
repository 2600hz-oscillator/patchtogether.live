// packages/web/src/lib/ui/workflow/strict-faces.ts
//
// The RATCHET set for the workflow-mode UI-CURATION system — the face analog of
// STRICT_DOCS ($lib/docs/strict-docs). A module type in this set has been
// PROMOTED to the full curation bar: its co-located `face` MUST be COMPLETE —
// every param, every declared control family, and every numbered-legend control
// appears in `face.order` (the deny-missing-curation guarantee at the control
// surface), enforced by module-face-lint.test.ts.
//
// Modules NOT in this set are checked only for CONSISTENCY (no orphaned face
// keys) — they degrade gracefully while the ratchet rolls out. The set only
// grows:
//  - every NEW faced module ships into it,
//  - a module incidentally reskinned for a fix is brought up + added (boy-scout),
//  - background batches promote the tail.
//
// SEEDED EMPTY (P0.4): no module carries a `face` yet — P1 is the first reskin
// wave (dx7, kickdrum, tidyvco, …). The gate + ratchet floor are live now so the
// FIRST faced module lands green-gated. See the workflow-mode UI refactor plan
// (§3.6 + §5) in .myrobots/plans.

export const STRICT_FACES: ReadonlySet<string> = new Set<string>([
  // (empty — the first faced-module batch lands in P1)
]);

/**
 * The legacy-fallback MIGRATION derivation: is this module type MIGRATED to a
 * curated ModuleShell face? Drives the workflow `flowNodes` swap (migrated →
 * ModuleShell curated face; un-migrated → styled placeholder + legacy card in
 * the dock). The bridge and the face-lint gate read the SAME set, so a module is
 * "migrated" exactly when it's on the curation bar.
 *
 * A module is only truly migrated once it is BOTH faced AND promoted, so this
 * keys off STRICT_FACES membership (an authored-but-unpromoted `face` is a
 * draft-in-progress, not a shipped face). Pure — no registry read; the caller
 * already has the type. The bridge itself is wired in a later phase (P0.3 / P1).
 */
export function migrated(type: string): boolean {
  return STRICT_FACES.has(type);
}
