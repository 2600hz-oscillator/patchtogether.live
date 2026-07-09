<script lang="ts">
  // ColorizerCard — mono-video → tinted video. Three CV inputs let an
  // upstream LFO/sequencer drive the tint color.
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { colorizerDef } from '$lib/video/modules/colorizer';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = colorizerDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs = portsFromDef(colorizerDef.inputs, { tintR: 'R', tintG: 'G', tintB: 'B' });
  const outputs = portsFromDef(colorizerDef.outputs);
</script>

<div class="vcard card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="COLORIZER" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-grid">
      <Fader value={p('tintR')} min={0} max={1} defaultValue={colorizerDef.params.find((x) => x.id === 'tintR')!.defaultValue} label="R" curve="linear" onchange={setParam('tintR')} moduleId={id} paramId="tintR" />
      <Fader value={p('tintG')} min={0} max={1} defaultValue={colorizerDef.params.find((x) => x.id === 'tintG')!.defaultValue} label="G" curve="linear" onchange={setParam('tintG')} moduleId={id} paramId="tintG" />
      <Fader value={p('tintB')} min={0} max={1} defaultValue={colorizerDef.params.find((x) => x.id === 'tintB')!.defaultValue} label="B" curve="linear" onchange={setParam('tintB')} moduleId={id} paramId="tintB" />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 240px;
    min-height: 180px;
  }
  .fader-grid {
    margin-top: 12px;
    padding: 0 12px;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px 8px;
    justify-items: center;
  }
</style>
