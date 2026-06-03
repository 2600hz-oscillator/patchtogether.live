<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();

  const inputs: PortDescriptor[] = [
    { id: 'in1', label: 'IN 1', cable: 'gate' },
    { id: 'in2', label: 'IN 2', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'flip', label: 'FLIP', cable: 'gate' },
    { id: 'flop', label: 'FLOP', cable: 'gate' },
  ];
</script>

<div class="mod-card flipper-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="FLIPPER" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="flipper-body">
      <span class="ff">FLIP</span>
      <span class="ff-sep">↔</span>
      <span class="ff">FLOP</span>
    </div>
  </PatchPanel>
</div>

<style>
  .flipper-card {
    width: 176px;
  }
  .flipper-body {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 18px 0 8px;
    font-size: 0.72rem;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }
  .ff {
    font-weight: 600;
  }
  .ff-sep {
    opacity: 0.6;
  }
</style>
