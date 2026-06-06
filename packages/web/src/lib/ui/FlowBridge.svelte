<script lang="ts">
  // Bridges xyflow's context-bound `useSvelteFlow()` API up to the parent.
  //
  // The hook can only be called inside a `<SvelteFlow>` provider. The parent
  // (Canvas.svelte) needs `screenToFlowPosition` for anchoring spawned modules
  // at the right-click point and `getInternalNode` for measured node sizes
  // (used by the Organize-modules layout pass). This tiny child component
  // sits inside `<SvelteFlow>`, calls the hook, and forwards the API via the
  // bound api prop. Renders nothing.
  import { useSvelteFlow, useStore } from '@xyflow/svelte';
  import { initialConnection, type XYPosition } from '@xyflow/system';
  import type { Node as FlowNode } from '@xyflow/svelte';

  /** xyflow's per-handle bounds entry (relative to the node's top-left
   *  in flow-space). Inlined here so the canvas's insert-on-cable code
   *  can read it without importing from @xyflow/system. */
  export interface HandleBoundsEntry {
    id: string | null;
    x: number;
    y: number;
    width: number;
    height: number;
  }

  /** Shape of `useSvelteFlow().getInternalNode(id)` — a FlowNode plus an
   *  `internals` bag holding the measured positionAbsolute + handle
   *  bounds. We type just the fields the canvas reads. */
  export type InternalFlowNode = FlowNode & {
    measured?: { width?: number; height?: number };
    internals?: {
      positionAbsolute?: { x: number; y: number };
      handleBounds?: {
        source?: HandleBoundsEntry[];
        target?: HandleBoundsEntry[];
      };
    };
  };

  export interface FlowBridgeApi {
    screenToFlowPosition: (p: XYPosition) => XYPosition;
    /** Inverse of screenToFlowPosition — convert a flow-space point to
     *  client-space pixels. Used by the lasso overlay so the anchor stays
     *  glued to its flow-space click point while the user pans/zooms. */
    flowToScreenPosition: (p: XYPosition) => XYPosition;
    getNode: (id: string) => FlowNode | undefined;
    getInternalNode: (id: string) => InternalFlowNode | undefined;
    getNodes: () => FlowNode[];
    /** Current viewport: pan offset (x,y in screen px) + zoom factor. Used by
     *  Organize-modules to compute the visible region in flow-space. */
    getViewport: () => { x: number; y: number; zoom: number };
    /** Clear xyflow's internal click-connect-start handle. Used by the
     *  pickup-mode Esc handler — without this, xyflow would still think
     *  the user's mid-click-connect and a subsequent click on a handle
     *  would commit instead of starting a fresh pickup. */
    cancelClickConnect: () => void;
    /** Reset xyflow's in-progress connection state (`store._connection`)
     *  back to the no-connection sentinel. Used when the PortContextMenu
     *  opens on a port: xyflow's own pointerdown on the handle would
     *  otherwise start a drag-connection and render the dashed yellow
     *  preview line to the cursor — which then sits behind the menu
     *  for as long as the menu is open. Calling this on menu-open kills
     *  that preview cleanly. Also used by the click-and-hold gesture
     *  (PR-204) when the 50ms hold timer fires: xyflow's pointerdown
     *  already started a drag, and we need to abort that drag before
     *  the menu commits.  */
    cancelConnection: () => void;
    /** Mark an edge selected (or not) in xyflow's store. Headless Playwright
     *  can't reliably click the thin SVG edge interaction band, so the
     *  edge-delete e2e selects the edge through this real xyflow mutation
     *  (the SAME `selected` flag a user's click sets), then presses the real
     *  Backspace deleteKey — exercising xyflow's genuine KeyHandler →
     *  deleteElements → ondelete teardown path end-to-end. */
    setEdgeSelected: (id: string, selected: boolean) => void;
  }

  interface Props {
    api: FlowBridgeApi | null;
  }

  let { api = $bindable(null) }: Props = $props();

  const flow = useSvelteFlow();
  const store = useStore();

  $effect(() => {
    api = {
      screenToFlowPosition: flow.screenToFlowPosition,
      flowToScreenPosition: flow.flowToScreenPosition,
      getNode: flow.getNode,
      getInternalNode: (id: string) => flow.getInternalNode(id) as unknown as InternalFlowNode | undefined,
      getNodes: () => flow.getNodes(),
      getViewport: () => flow.getViewport(),
      cancelClickConnect: () => {
        store.clickConnectStartHandle = null;
      },
      cancelConnection: () => {
        // Reset both the click-connect handle AND the drag-connection
        // state so no in-flight gesture is left hanging when the port
        // context menu takes over. Defensive: xyflow's store shape can
        // change between minor versions, and this is called from a
        // pointerdown path where a thrown error would prevent the
        // port-context menu from opening (and, transitively, break any
        // downstream render work in the same microtask). Never crash
        // the caller — the menu must open even if cleanup fails.
        try {
          if (store && 'clickConnectStartHandle' in store) {
            store.clickConnectStartHandle = null;
          }
        } catch { /* swallow — defensive */ }
        try {
          if (store && '_connection' in store) {
            (store as unknown as { _connection: unknown })._connection = initialConnection;
          }
        } catch { /* swallow — defensive */ }
      },
      setEdgeSelected: (id: string, selected: boolean) => {
        flow.updateEdge(id, { selected });
      },
    };
    return () => {
      api = null;
    };
  });
</script>
