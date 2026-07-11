// packages/web/src/lib/ui/dock/dock.ts
//
// DOCKING — pure zone model (P1: the workflow M/E/C bottom drawer).
//
// The workflow-mode bottom drawer is the FIRST INSTANCE of a general
// docking system: later phases let ANY module dock to the top / left /
// right toolbars, stay FIXED independent of canvas scroll/pan, and be
// zoomed/scaled independently of canvas zoom (owner direction,
// 2026-07-10). So the framework is named and typed as DOCK ZONES from day
// one — P1 implements ONLY 'bottom' (one docked card at a time, toggled
// by M/E/C, ESC closes), while 'top' | 'left' | 'right' exist in the type
// so P2+ never has to break these names.
//
// Dock state is LOCAL VIEW STATE (per tab, like rear-view / minimap) —
// never synced into the Y.Doc. Which drawer a performer has open is their
// own business; rack-mates each keep their own dock state.
//
// PURE + framework-free: the reactive store lives in dock-store.svelte.ts;
// this module is types + transition helpers so the semantics unit-test
// against plain values.

/** Every dock zone the system will ever place cards in. P1 renders only
 *  'bottom'; the others are typed-but-unimplemented on purpose. */
export type DockZone = 'bottom' | 'top' | 'left' | 'right';

/** Zones DockZoneContainer actually renders today. Attempting to dock
 *  into an unimplemented zone is a no-op (guarded in the store). */
export const IMPLEMENTED_DOCK_ZONES: readonly DockZone[] = ['bottom'];

/** Is `zone` renderable in this build? */
export function isImplementedDockZone(zone: DockZone): boolean {
  return IMPLEMENTED_DOCK_ZONES.includes(zone);
}

/** Default per-zone content scale. Each zone carries a scale applied to
 *  its docked card independently of canvas zoom (`--dock-scale` on the
 *  zone container + the standalone flow host's viewport zoom). No UI sets
 *  it yet — P1 always renders at 1. */
export const DEFAULT_DOCK_SCALE = 1;

/**
 * Toggle semantics for a single-occupancy zone: toggling the id that's
 * already docked closes the zone (→ null); toggling anything else docks
 * it (replacing a different occupant — "one drawer open at a time").
 */
export function toggleDockedId(current: string | null, nodeId: string): string | null {
  return current === nodeId ? null : nodeId;
}
