<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
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

  const inputs: PortDescriptor[] = [
    { id: 'audio', cable: 'audio' },
    { id: 'cv',    cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'audio',     cable: 'audio' },
    { id: 'audio_inv', label: 'AUDIO INV', cable: 'audio' },
  ];
</script>

<div class="mod-card vca-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <header class="title">VCA</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={base}     min={0}  max={1} defaultValue={0}   label="Base" curve="linear" onchange={set('base')}     readLive={live('base')}     moduleId={id} paramId="base" />
      <Fader value={cvAmount} min={-1} max={1} defaultValue={1.0} label="CV Amt" curve="linear" onchange={set('cvAmount')} readLive={live('cvAmount')} moduleId={id} paramId="cvAmount" />
    </div>
  </PatchPanel>
</div>

<style>
  .vca-card { width: 160px; min-height: 180px; }
</style>
