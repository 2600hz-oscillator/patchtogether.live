<script lang="ts">
  // LumaCard — single-input POSTERIZE / CONTRAST / GAMMA / BIAS processor.
  // The old version was a confused mask-extractor; see luma.ts header for
  // the migration story. Use LUMAKEY for the proper 2-input luma-key
  // compositor.
  //
  // All ports live in the shared yellow drill-down <PatchPanel> (the post-#767
  // hard standard — NO raw side <Handle> jacks). Port `id`s are byte-identical
  // to lumaDef so the CV bridge + persisted edges route unchanged.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { lumaDef } from '$lib/video/modules/luma';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = lumaDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // Ports — ids byte-identical to lumaDef (in/out = video, gamma/contrast/
  // posterizeLevels/bias = cv).
  const inputs = portsFromDef(lumaDef.inputs, { contrast: 'CNTR', posterizeLevels: 'POST' });
  const outputs = portsFromDef(lumaDef.outputs);
</script>

<div class="vcard card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="LUMA" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <div class="fader-grid">
        <Fader value={p('gamma')}           min={0.1} max={3.0}  defaultValue={lumaDef.params.find((x) => x.id === 'gamma')!.defaultValue}           label="Gamma" curve="linear" onchange={setParam('gamma')}           moduleId={id} paramId="gamma" />
        <Fader value={p('contrast')}        min={0}   max={2}    defaultValue={lumaDef.params.find((x) => x.id === 'contrast')!.defaultValue}        label="Cntr"  curve="linear" onchange={setParam('contrast')}        moduleId={id} paramId="contrast" />
        <Fader value={p('posterizeLevels')} min={2}   max={16}   defaultValue={lumaDef.params.find((x) => x.id === 'posterizeLevels')!.defaultValue} label="Post"  curve="linear" onchange={setParam('posterizeLevels')} moduleId={id} paramId="posterizeLevels" />
        <Fader value={p('bias')}            min={-0.5} max={0.5} defaultValue={lumaDef.params.find((x) => x.id === 'bias')!.defaultValue}            label="Bias"  curve="linear" onchange={setParam('bias')}            moduleId={id} paramId="bias" />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 220px;
    min-height: 260px;
  }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances. */
    margin-top: 24px;
  }
  .fader-grid {
    padding: 0 12px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px 6px;
    justify-items: center;
  }
</style>
