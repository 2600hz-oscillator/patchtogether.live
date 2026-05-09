<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { audioOutDef } from '$lib/audio/modules/audio-out';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let master = $derived(node?.params.master ?? audioOutDef.params[0]!.defaultValue);

  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  function readLive(paramId: string) {
    return () => {
      const e = engineCtx.get();
      if (!e || !node) return undefined;
      return e.readParam(node, paramId);
    };
  }

  const inputs: PortDescriptor[] = [
    { id: 'L', cable: 'audio' },
    { id: 'R', cable: 'audio' },
  ];
</script>

<div class="card">
  <div class="stripe"></div>
  <header class="title">Audio Out</header>

  <PatchPanel nodeId={id} {inputs}>
    <div class="fader-row">
      <Fader
        value={master}
        min={0}
        max={1}
        defaultValue={0.7}
        label="Master"
        curve="linear"
        onchange={setParam('master')}
        readLive={readLive('master')}
      />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 160px;
    min-height: 170px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  :global(.svelte-flow__node:hover) .card {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--text-dim);
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
  }
  .fader-row {
    margin-top: 12px;
    display: flex;
    justify-content: center;
  }
</style>
