// patch-menu-state.ts
//
// PURE reducer for the redesigned patch menu's view + carry state machine. No
// Svelte / DOM imports — the component holds one of these in a rune and feeds
// it transition events; the reducer returns the next immutable state.
//
// THE MODEL (user spec items 1–5):
//   * The menu opens edge-aligned to a card SIDE ('left' | 'right' trigger).
//   * Top level (view='root') shows just INPUT and OUTPUT (+ any sections).
//   * Clicking INPUT/OUTPUT REPLACES the view IN PLACE (parent hides; nothing
//     stacks side-by-side) → view='inputs' | 'outputs' | {section}. There's a
//     back affordance returning to 'root'.
//   * Drill-in is by CLICK (hover may also drill, but must never fight a click).
//   * Left-clicking a JACK opens the menu in CARRY mode with a "patch to" entry
//     (carrying=true, a cable dangles from the cursor). Clicking "patch to"
//     hides the dangling cable visually but RETAINS carry/source state for the
//     eventual commit, and shows the patch-to picker (the module/port list).
//   * A valid commit makes the patch + closes. An invalid attempt discards the
//     cable + closes SILENTLY. Esc discards.
//
// This reducer owns ONLY the view/side/carrying bookkeeping — the actual edge
// write, validity check (validateEdge), and cable-ghost lifecycle live in the
// component/Canvas. The reducer is the single source of truth for "what is the
// menu showing right now and is a cable in flight?", so the UI never derives it
// ad-hoc.

/** Which logical view the menu is showing. 'root' = top-level INPUT/OUTPUT
 *  pivot; 'inputs'/'outputs' = the flat port list for that direction; a
 *  {section} view shows one named section's ports (sectioned mega-modules);
 *  'picker' = the carry-mode "patch to" target module/port picker. */
export type PatchMenuView =
  | { kind: 'root' }
  | { kind: 'inputs' }
  | { kind: 'outputs' }
  | { kind: 'section'; label: string }
  | { kind: 'picker' };

export interface PatchMenuState {
  /** Whether the menu is open at all. Closed = the inert resting state. */
  open: boolean;
  /** The current overlay-replace view. */
  view: PatchMenuView;
  /** Which card side the menu edge-aligns to. */
  side: 'left' | 'right';
  /** True while a cable is dangling from the cursor (carry mode). */
  carrying: boolean;
  /** True once "patch to" was clicked in carry mode: the dangling cable is
   *  hidden but source/carry state is retained for the eventual commit. The
   *  component reads this to hide the PickupCable ghost. */
  cableHidden: boolean;
}

export const CLOSED: PatchMenuState = {
  open: false,
  view: { kind: 'root' },
  side: 'left',
  carrying: false,
  cableHidden: false,
};

/** Open the menu from a trigger (item 1) — top-level root view, edge-aligned to
 *  the given side, no cable in flight. */
export function openFromTrigger(side: 'left' | 'right'): PatchMenuState {
  return { open: true, view: { kind: 'root' }, side, carrying: false, cableHidden: false };
}

/** Open the menu from a JACK left-click (item 4) — carry mode. A cable now
 *  dangles from the cursor AND the menu shows the root with a "patch to" entry.
 *  The cable is still visible (cableHidden=false) until "patch to" is clicked. */
export function openFromJack(side: 'left' | 'right'): PatchMenuState {
  return { open: true, view: { kind: 'root' }, side, carrying: true, cableHidden: false };
}

/** Drill into a sub-view (item 2) — replaces the current view in place. The
 *  parent (root) hides; only the chosen view renders. Works the same whether or
 *  not a cable is in flight. */
export function drillInto(state: PatchMenuState, view: PatchMenuView): PatchMenuState {
  if (!state.open) return state;
  return { ...state, view };
}

/** Back affordance (item 2) — return to the top-level root view in place. From
 *  the picker, back also returns to root (still carrying). */
export function back(state: PatchMenuState): PatchMenuState {
  if (!state.open) return state;
  return { ...state, view: { kind: 'root' } };
}

/** Click "patch to" in carry mode (item 4) — the dangling cable VISUALLY
 *  DISAPPEARS (cableHidden=true) but carry/source state is retained; the
 *  patch-to picker takes over. No-op if not carrying. */
export function clickPatchTo(state: PatchMenuState): PatchMenuState {
  if (!state.open || !state.carrying) return state;
  return { ...state, cableHidden: true, view: { kind: 'picker' } };
}

/** A valid patch was committed (item 5) — close everything; carry ends. */
export function commit(): PatchMenuState {
  return CLOSED;
}

/** An invalid carry-commit attempt (item 5) — cable goes away, menus close, NO
 *  patch is made, SILENTLY. Same terminal close as commit; the distinction
 *  (write-an-edge vs. not) is the caller's, not the reducer's. */
export function invalidDiscard(): PatchMenuState {
  return CLOSED;
}

/** Esc (item 6) — discard the cable + close the menu. */
export function esc(): PatchMenuState {
  return CLOSED;
}
