// packages/web/src/lib/ui/dock/dock.ts
//
// DOCKING — pure zone model (P1: the workflow M/E/C bottom drawer).
//
// The workflow-mode bottom drawer was the FIRST INSTANCE of a general
// docking system; P2.5a generalizes it: allowlisted modules dock to the
// TOP rail, the LEFT rail (= the workflow left toolbar, owner Q5) or the
// bottom drawer, stay FIXED independent of canvas scroll/pan, and zoom
// independently of canvas zoom (50–150% discrete — dock-entries.ts). The
// bottom drawer keeps its P1 duties (the pinned M/E/C occupant, toggled
// by M/E/C keys, ESC closes) alongside docked cards.
//
// Dock state is LOCAL VIEW STATE (per tab, like rear-view / minimap) —
// never synced into the Y.Doc. Which drawer a performer has open is their
// own business; rack-mates each keep their own dock state.
//
// PURE + framework-free: the reactive store lives in dock-store.svelte.ts;
// this module is types + transition helpers so the semantics unit-test
// against plain values.

/** Every dock zone the system will ever place cards in. P2.5a implements
 *  'bottom' + 'top' + 'left' (owner answer Q5: three zones in v1); 'right'
 *  stays typed-but-unimplemented (P3's asset column owns that edge). */
export type DockZone = 'bottom' | 'top' | 'left' | 'right';

/** Zones the dock rails actually render today. Attempting to dock into an
 *  unimplemented zone is a no-op (guarded in the store). */
export const IMPLEMENTED_DOCK_ZONES: readonly DockZone[] = ['bottom', 'top', 'left'];

/** Is `zone` renderable in this build? */
export function isImplementedDockZone(zone: DockZone): boolean {
  return IMPLEMENTED_DOCK_ZONES.includes(zone);
}

/**
 * Toggle semantics for a single-occupancy zone: toggling the id that's
 * already docked closes the zone (→ null); toggling anything else docks
 * it (replacing a different occupant — "one drawer open at a time").
 */
export function toggleDockedId(current: string | null, nodeId: string): string | null {
  return current === nodeId ? null : nodeId;
}
