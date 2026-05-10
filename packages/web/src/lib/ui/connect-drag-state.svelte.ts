// connect-drag-state.svelte.ts
//
// Singleton store tracking an in-flight Svelte Flow cable drag, so the
// PatchPanel that opens during the drag can stay locked open until the
// drag commits (onconnect) or releases (onconnectend).
//
// Why a module-level singleton instead of a Svelte context? The drag
// driver is Canvas.svelte (which calls svelte-flow's onconnectstart /
// onconnectend); the readers are PatchPanel instances on every module
// card. They live in different sub-trees and don't share an ancestor
// that can host the context. A simple module-level rune keeps the
// wiring trivial — Canvas writes, every PatchPanel reads.

class ConnectDragState {
  /** True while Svelte Flow has an active connect-drag in progress. */
  active = $state(false);
  /** The nodeId of the PatchPanel that opened FIRST during this drag.
   *  Cleared when the drag ends. Used by PatchPanel to decide whether
   *  it should resist closing (only the locked panel does). */
  lockedPanelNodeId = $state<string | null>(null);
  /** The nodeId whose port triggered an active patch-to cascade (right-
   *  click or double-click). Cleared when the cascade closes (commit /
   *  Esc / new cascade). PatchPanel reads this to keep itself open
   *  while the cascade is active for one of its handles — even past
   *  hover/post-click expiry. */
  cascadeActiveForPanel = $state<string | null>(null);

  /** Canvas calls this from svelte-flow's onconnectstart. */
  begin(): void {
    this.active = true;
    this.lockedPanelNodeId = null;
  }

  /** Canvas calls this from onconnect AND onconnectend. */
  end(): void {
    this.active = false;
    this.lockedPanelNodeId = null;
  }

  /** PatchPanel calls this when it opens during an active drag. First
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
