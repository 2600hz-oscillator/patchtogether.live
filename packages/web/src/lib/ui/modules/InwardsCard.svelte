<script lang="ts">
  // InwardsCard — radial pattern source. Mirrors LinesCard's shape; only
  // the param + handle list differs.
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { inwardsDef } from '$lib/video/modules/inwards';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = inwardsDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs = portsFromDef(inwardsDef.inputs, { thickness: 'THICK' });
  const outputs = portsFromDef(inwardsDef.outputs);
</script>

<div class="vcard card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="INWARDS" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-grid">
      <Fader value={p('speed')}     min={-2}  max={2}  defaultValue={inwardsDef.params.find((x) => x.id === 'speed')!.defaultValue}     label="Speed"     curve="linear" onchange={setParam('speed')} moduleId={id} paramId="speed" />
      <Fader value={p('density')}   min={1}   max={50} defaultValue={inwardsDef.params.find((x) => x.id === 'density')!.defaultValue}   label="Density"   curve="linear" onchange={setParam('density')} moduleId={id} paramId="density" />
      <Fader value={p('thickness')} min={0}   max={1}  defaultValue={inwardsDef.params.find((x) => x.id === 'thickness')!.defaultValue} label="Thick"     curve="linear" onchange={setParam('thickness')} moduleId={id} paramId="thickness" />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 220px;
    min-height: 200px;
  }
  .stripe {
    background: var(--cable-mono-video);
  }  .fader-grid {
    margin-top: 14px;
    padding: 0 12px;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px 8px;
    justify-items: center;
  }
</style>
