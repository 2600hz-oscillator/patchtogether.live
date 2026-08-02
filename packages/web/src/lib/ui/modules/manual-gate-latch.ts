// packages/web/src/lib/ui/modules/manual-gate-latch.ts
//
// THE HELD-GATE LATCH — a PURE state machine over "which nodes have a HELD
// AUDITION gate open right now".
//
// ⚠ THIS FILE WAS `snaredrum-roll-latch.ts`. Not one line of its logic is
// snaredrum-specific — it only ever knew NODE IDS — so leaving it named after
// the first module that needed it would have made the private state machine of
// a GENERIC seam (manual-strike-actions.ts) advertise itself as belonging to
// one module. Renamed; the transitions, the reports and the invariant are
// unchanged, and `manual-gate-latch.test.ts` is the same suite retargeted.
//
// WHY A MODEL AND NOT THREE BOOLEANS. The one-shot audition (`fireManualStrike`)
// is a trigger: the worst a lost event can do is drop a hit. A HELD audition
// (`setManualGate`) opens a ConstantSource into a gate input and the module's
// engine runs until something closes it. If the release edge is ever missed the
// module runs FOREVER — snaredrum rolls, and nothing in the graph reverts it:
// this is the tidyVco `hold` stuck-value class relocated out of the Y.Doc and
// into the audio graph, where there is no undo and no remote peer to notice.
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
// normal pointerup, and the engine call must happen exactly once. `closeGate`
// on a node that is not open returns `closed: false` so the caller skips the
// redundant close rather than scheduling a second AudioParam event at the
// same timestamp.
//
// ⚠ THE LATCH KEY IS THE NODE ID, so a module gets exactly ONE held audition.
// That is a real constraint, not an oversight: snaredrum's ROLL is its only
// held pad, and a second one on the same node would alias onto the first. A
// module that genuinely needs two held auditions must key this by node+read-key
// AND give `manual-strike-actions.ts` a second gate key — do both, or the
// second pad silently steals the first pad's release.
//
// PURE + IMMUTABLE: every function returns a NEW state, so the reducer is
// trivially unit-testable with no DOM, no AudioContext and no store — and the
// interesting half (can a node be left open?) is provable rather than observed.

/** The open-gate set. Opaque by convention — build it with `emptyGateLatch()`. */
export interface GateLatchState {
  /** Node ids whose held audition gate is currently OPEN. */
  readonly open: readonly string[];
}

/** A latch with nothing held. */
export function emptyGateLatch(): GateLatchState {
  return { open: [] };
}

/** Is this node's audition gate open? */
export function isGateOpen(state: GateLatchState, nodeId: string): boolean {
  return state.open.includes(nodeId);
}

/**
 * Open `nodeId`'s audition gate. `opened` is false when it was ALREADY open — a
 * repeated pointerdown (auto-repeat on the keyboard path, a synthetic replay)
 * must not schedule a second open at the same context time.
 */
export function openGate(
  state: GateLatchState,
  nodeId: string,
): { state: GateLatchState; opened: boolean } {
  if (isGateOpen(state, nodeId)) return { state, opened: false };
  return { state: { open: [...state.open, nodeId] }, opened: true };
}

/**
 * Close `nodeId`'s audition gate. `closed` is false when it was not open, so the
 * SECOND caller on a normal release (the button fires `onGate(false)`, the
 * window-level panic fires on the same `pointerup`) is a no-op instead of a
 * duplicate engine write.
 */
export function closeGate(
  state: GateLatchState,
  nodeId: string,
): { state: GateLatchState; closed: boolean } {
  if (!isGateOpen(state, nodeId)) return { state, closed: false };
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
export function panicGates(state: GateLatchState): { state: GateLatchState; closed: string[] } {
  if (state.open.length === 0) return { state, closed: [] };
  return { state: emptyGateLatch(), closed: [...state.open] };
}
