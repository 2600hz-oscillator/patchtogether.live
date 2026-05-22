// connect-drag-state.svelte.ts
//
// Singleton store tracking an in-flight cable patch gesture, so the
// PatchPanel that opens during the gesture can stay locked open until the
// gesture commits or releases.
//
// Two gestures are tracked:
//   * `dragging` — Svelte Flow connect-drag (mousedown on handle, drag past
//     dragThreshold, mouseup on target).
//   * `pickup` — click-to-pickup (mousedown + mouseup on same handle inside
//     dragThreshold). Cable then "sticks" to the cursor and follows it
//     around until the user clicks a target handle or hits Esc.
//
// Both modes share the same `active` getter so PatchPanel's expand-all,
// drag-lock, and section visibility logic works uniformly for both.
//
// Why a module-level singleton instead of a Svelte context? The drag
// driver is Canvas.svelte (which calls svelte-flow's onconnectstart /
// onconnectend / onclickconnectstart / onclickconnectend); the readers
// are PatchPanel instances on every module card. They live in different
// sub-trees and don't share an ancestor that can host the context. A
// simple module-level rune keeps the wiring trivial — Canvas writes,
// every PatchPanel reads.

export type ConnectDragMode = 'idle' | 'dragging' | 'pickup';

export interface PickupSource {
  nodeId: string;
  portId: string;
  /** 'source' = output (cable starts here, target is an input).
   *  'target' = input (cable target is this input, source is an output). */
  handleType: 'source' | 'target';
  /** Cable type for compatibility filtering on commit ('audio' | 'cv' | ...). */
  cableType?: string;
}

class ConnectDragState {
  /** Current gesture mode. `idle` = nothing in flight. */
  mode = $state<ConnectDragMode>('idle');
  /** True while any patch gesture is in flight (dragging OR pickup).
   *  PatchPanel reads this for drag-lock and expand-all behaviour. */
  active = $state(false);
  /** The nodeId of the PatchPanel that opened FIRST during this gesture.
   *  Cleared when the gesture ends. Used by PatchPanel to decide whether
   *  it should resist closing (only the locked panel does). */
  lockedPanelNodeId = $state<string | null>(null);
  /** The nodeId whose port triggered an active patch-to cascade (right-
   *  click or double-click). Cleared when the cascade closes (commit /
   *  Esc / new cascade). PatchPanel reads this to keep itself open
   *  while the cascade is active for one of its handles. */
  cascadeActiveForPanel = $state<string | null>(null);
  /** Pickup-mode source port info. Non-null only while mode === 'pickup'. */
  pickupSource = $state<PickupSource | null>(null);
  /** Pickup-mode cursor position (screen-space). Updated on every mousemove
   *  while pickup is active. Canvas reads this to render the ghost cable
   *  from the source port to the cursor. */
  pickupCursor = $state<{ x: number; y: number } | null>(null);
  /** Live cursor-over-card tracking while a connect gesture is in flight.
   *  The drag tracks the cable's endpoint, not the panel-trigger glyph —
   *  if we relied solely on the trigger's mouseenter the destination
   *  panel would never auto-open as the cable approaches a target card.
   *  Instead the singleton owns a document-level pointermove listener
   *  (installed in begin/pickup, torn down in end/cancelPickup) that
   *  publishes whichever svelte-flow node is under the cursor. PatchPanel
   *  includes this in its `open` derived so the destination card unfolds
   *  the moment the cable hovers over it. */
  hoveredCardNodeId = $state<string | null>(null);
  private hoverPointerListener: ((e: PointerEvent) => void) | null = null;

  /** Canvas calls this from svelte-flow's onconnectstart. */
  begin(): void {
    this.mode = 'dragging';
    this.active = true;
    this.lockedPanelNodeId = null;
    this.installHoverTracker();
  }

  /** Canvas calls this from onconnect AND onconnectend. */
  end(): void {
    this.mode = 'idle';
    this.active = false;
    this.lockedPanelNodeId = null;
    this.uninstallHoverTracker();
  }

  /** Canvas calls this from onclickconnectstart — user clicked a handle
   *  without dragging, so the cable is now "picked up" and follows the
   *  cursor until they click a target handle or hit Esc. */
  pickup(source: PickupSource): void {
    this.mode = 'pickup';
    this.active = true;
    this.lockedPanelNodeId = null;
    this.pickupSource = source;
    this.pickupCursor = null;
    this.installHoverTracker();
  }

  /** Canvas calls this on every mousemove while pickup mode is active —
   *  updates the ghost-cable endpoint. */
  updatePickupCursor(x: number, y: number): void {
    if (this.mode !== 'pickup') return;
    this.pickupCursor = { x, y };
  }

  /** Canvas calls this from onclickconnectend (commit on target click) OR
   *  from the Esc handler (cancel). Either way: clear pickup state and
   *  return to idle. */
  cancelPickup(): void {
    if (this.mode !== 'pickup') return;
    this.mode = 'idle';
    this.active = false;
    this.lockedPanelNodeId = null;
    this.pickupSource = null;
    this.pickupCursor = null;
    this.uninstallHoverTracker();
  }

  /** Document-level pointermove tracker. While a gesture is active we
   *  resolve the svelte-flow node under the cursor and publish its id;
   *  PatchPanel watches that id to auto-open on cable hover. Hit-tests
   *  via elementFromPoint so xyflow's connection-line overlay is
   *  transparent to us (it sets `pointer-events: none` by default). */
  private installHoverTracker(): void {
    if (this.hoverPointerListener || typeof document === 'undefined') return;
    this.hoverPointerListener = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const node = el?.closest('.svelte-flow__node') as HTMLElement | null;
      const id = node?.dataset.id ?? null;
      if (id !== this.hoveredCardNodeId) this.hoveredCardNodeId = id;
    };
    document.addEventListener('pointermove', this.hoverPointerListener, { passive: true });
  }

  private uninstallHoverTracker(): void {
    if (!this.hoverPointerListener || typeof document === 'undefined') return;
    document.removeEventListener('pointermove', this.hoverPointerListener);
    this.hoverPointerListener = null;
    this.hoveredCardNodeId = null;
  }

  /** PatchPanel calls this when it opens during an active gesture. First
   *  panel to register wins the lock. */
  tryLock(nodeId: string): void {
    if (!this.active) return;
    if (this.lockedPanelNodeId === null) {
      this.lockedPanelNodeId = nodeId;
    }
  }

  /** Canvas calls this when the patch-to cascade opens (regardless of
   *  trigger gesture). nodeId is the source port's nodeId. */
  beginCascade(nodeId: string): void {
    this.cascadeActiveForPanel = nodeId;
  }

  /** Canvas calls this when the cascade closes. */
  endCascade(): void {
    this.cascadeActiveForPanel = null;
  }
}

export const connectDragState = new ConnectDragState();
