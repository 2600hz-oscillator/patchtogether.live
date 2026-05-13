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
  import type { XYPosition } from '@xyflow/system';
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
    };
    return () => {
      api = null;
    };
  });
</script>
