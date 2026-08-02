// packages/web/src/lib/ui/modules/snaredrum-roll-latch.ts
//
// THE HELD-GATE LATCH — a PURE state machine over "which snaredrum nodes have
// their ROLL audition gate open right now".
//
// WHY A MODEL AND NOT THREE BOOLEANS. The HIT audition is a one-shot: the worst
// a lost event can do is drop a hit. The ROLL audition is a HELD GATE — it
// opens a ConstantSource into `gate_in` and the two-hand engine rolls until
// something closes it. If the release edge is ever missed the drum rolls
// FOREVER, and nothing in the graph reverts it: this is the tidyVco `hold`
// stuck-value class relocated out of the Y.Doc and into the audio graph, where
// there is no undo and no remote peer to notice.
//
// The release edge can go missing in ways the button itself cannot see:
//   * the dock pane is closed mid-hold — the <Button> unmounts, so no
//     pointerup ever reaches it (pointer capture protects a MOVING pointer,
//     not a DELETED element);
//   * the tab is hidden / the window blurs while the pad is down;
//   * a pointercancel from a touch gesture the browser took over.
// Each of those needs a PANIC path, and a panic path needs to know exactly
// which gates are open — hence a set, hence a model.
//
// EVERY TRANSITION RETURNS WHETHER IT ACTUALLY DID ANYTHING, which is the
// whole point: the panic path and the button's own release BOTH fire on a
// normal pointerup, and the engine call must happen exactly once. `closeRoll`
// on a node that is not open returns `closed: false` so the caller skips the
// redundant `closeGate` rather than scheduling a second AudioParam event at the
// same timestamp.
//
// PURE + IMMUTABLE: every function returns a NEW state, so the reducer is
// trivially unit-testable with no DOM, no AudioContext and no store — and the
// interesting half (can a node be left open?) is provable rather than observed.

/** The open-gate set. Opaque by convention — build it with `emptyRollLatch()`. */
export interface RollLatchState {
  /** Node ids whose ROLL audition gate is currently OPEN. */
  readonly open: readonly string[];
}

/** A latch with nothing held. */
export function emptyRollLatch(): RollLatchState {
  return { open: [] };
}

/** Is this node's roll gate open? */
export function isRolling(state: RollLatchState, nodeId: string): boolean {
  return state.open.includes(nodeId);
}

/**
 * Open `nodeId`'s roll gate. `opened` is false when it was ALREADY open — a
 * repeated pointerdown (auto-repeat on the keyboard path, a synthetic replay)
 * must not schedule a second `openGate` at the same context time.
 */
export function openRoll(
  state: RollLatchState,
  nodeId: string,
): { state: RollLatchState; opened: boolean } {
  if (isRolling(state, nodeId)) return { state, opened: false };
  return { state: { open: [...state.open, nodeId] }, opened: true };
}

/**
 * Close `nodeId`'s roll gate. `closed` is false when it was not open, so the
 * SECOND caller on a normal release (the button fires `onGate(false)`, the
 * window-level panic fires on the same `pointerup`) is a no-op instead of a
 * duplicate engine write.
 */
export function closeRoll(
  state: RollLatchState,
  nodeId: string,
): { state: RollLatchState; closed: boolean } {
  if (!isRolling(state, nodeId)) return { state, closed: false };
  return { state: { open: state.open.filter((n) => n !== nodeId) }, closed: true };
}

/**
 * THE PANIC PATH. Close EVERY open gate and report exactly which ones were
 * closed, in the order they were opened, leaving the latch empty. Idempotent:
 * a second panic returns `[]`.
 *
 * The returned list is what the caller must actually close on the engine — a
 * panic that returned nothing while leaving state populated would be the
 * silent-leak bug wearing the fix's clothes.
 */
export function panicRoll(state: RollLatchState): { state: RollLatchState; closed: string[] } {
  if (state.open.length === 0) return { state, closed: [] };
  return { state: emptyRollLatch(), closed: [...state.open] };
}
