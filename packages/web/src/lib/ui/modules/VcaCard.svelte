<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { vcaDef } from '$lib/audio/modules/vca';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let base = $derived(node?.params.base ?? vcaDef.params[0]!.defaultValue);
  let cvAmount = $derived(node?.params.cvAmount ?? vcaDef.params[1]!.defaultValue);

  const set = (id_: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[id_] = v;
  };
  const live = (id_: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, id_);
  };
</script>

<div class="mod-card vca-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <header class="title">VCA</header>

  <Handle type="target" position={Position.Left} id="audio" style="top: 56px; --handle-color: var(--cable-audio);" />
  <Handle type="target" position={Position.Left} id="cv"    style="top: 92px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">audio</span>
  <span class="port-label left" style="top: 86px;">cv</span>

  <Handle type="source" position={Position.Right} id="audio" style="top: 56px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 50px;">out</span>

  <div class="fader-row">
    <Fader value={base}     min={0}  max={1} defaultValue={0}   label="Base" curve="linear" onchange={set('base')}     readLive={live('base')} />
    <Fader value={cvAmount} min={-1} max={1} defaultValue={1.0} label="CV Amt" curve="linear" onchange={set('cvAmount')} readLive={live('cvAmount')} />
  </div>
</div>

<style>
  .vca-card { width: 160px; min-height: 200px; }
</style>
