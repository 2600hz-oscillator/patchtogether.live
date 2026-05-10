<script lang="ts">
  // Bridges xyflow's context-bound `useSvelteFlow()` API up to the parent.
  //
  // The hook can only be called inside a `<SvelteFlow>` provider. The parent
  // (Canvas.svelte) needs `screenToFlowPosition` for anchoring spawned modules
  // at the right-click point and `getInternalNode` for measured node sizes
  // (used by the Organize-modules layout pass). This tiny child component
  // sits inside `<SvelteFlow>`, calls the hook, and forwards the API via the
  // bound api prop. Renders nothing.
  import { useSvelteFlow } from '@xyflow/svelte';
  import type { XYPosition } from '@xyflow/system';
  import type { Node as FlowNode } from '@xyflow/svelte';

  export interface FlowBridgeApi {
    screenToFlowPosition: (p: XYPosition) => XYPosition;
    getNode: (id: string) => FlowNode | undefined;
    getInternalNode: (id: string) => { measured: { width?: number; height?: number } } | undefined;
    getNodes: () => FlowNode[];
    /** Current viewport: pan offset (x,y in screen px) + zoom factor. Used by
     *  Organize-modules to compute the visible region in flow-space. */
    getViewport: () => { x: number; y: number; zoom: number };
  }

  interface Props {
    api: FlowBridgeApi | null;
  }

  let { api = $bindable(null) }: Props = $props();

  const flow = useSvelteFlow();

  $effect(() => {
    api = {
      screenToFlowPosition: flow.screenToFlowPosition,
      getNode: flow.getNode,
      getInternalNode: (id: string) => flow.getInternalNode(id) as unknown as
        { measured: { width?: number; height?: number } } | undefined,
      getNodes: () => flow.getNodes(),
      getViewport: () => flow.getViewport(),
    };
    return () => {
      api = null;
    };
  });
</script>
