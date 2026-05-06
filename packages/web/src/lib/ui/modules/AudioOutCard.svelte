<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
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
</script>

<div class="card">
  <div class="stripe"></div>
  <header class="title">Audio Out</header>

  <Handle type="target" position={Position.Left} id="L" style="top: 56px; --handle-color: var(--cable-audio);" />
  <Handle type="target" position={Position.Left} id="R" style="top: 92px; --handle-color: var(--cable-audio);" />
  <span class="port-label left" style="top: 50px;">L</span>
  <span class="port-label left" style="top: 86px;">R</span>

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
</div>

<style>
  .card {
    width: 160px;
    min-height: 170px;
    background: var(--module-bg);
    border: 1px solid #2a2f3a;
    border-radius: 6px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 6px 6px 0 0;
    background: var(--text-dim);
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
  }
  .port-label {
    position: absolute;
    font-size: 0.6rem;
    color: var(--text-dim);
    pointer-events: none;
    font-family: ui-monospace, monospace;
  }
  .port-label.left { left: 14px; }
  .fader-row {
    margin-top: 28px;
    display: flex;
    justify-content: center;
  }
</style>
