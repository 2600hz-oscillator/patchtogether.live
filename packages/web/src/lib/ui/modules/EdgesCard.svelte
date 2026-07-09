<script lang="ts">
  // EdgesCard — UI for EDGES (Sobel edge-detection video processor).
  //
  // Single video input (in) → mono-video output (out). Two knobs:
  // THRESHOLD (edge trigger) + THICKNESS (rendered edge width), each with
  // a matching per-param CV input. The yellow PatchPanel hosts the handles.
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { edgesDef, EDGES_MAX_THICKNESS } from '$lib/video/modules/edges';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = edgesDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function pdef(name: string): number {
    return edgesDef.params.find((d) => d.id === name)!.defaultValue;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs = portsFromDef(edgesDef.inputs, { threshold: 'THRESH', thickness: 'THICK' });
  const outputs = portsFromDef(edgesDef.outputs);
</script>

<div class="vcard card video" data-testid="edges-card">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="EDGES" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-grid">
      <Fader value={p('threshold')} min={0} max={1}                  defaultValue={pdef('threshold')} label="Thresh" curve="linear" onchange={setParam('threshold')} moduleId={id} paramId="threshold" />
      <Fader value={p('thickness')} min={1} max={EDGES_MAX_THICKNESS} units="px" defaultValue={pdef('thickness')} label="Thick"  curve="linear" onchange={setParam('thickness')} moduleId={id} paramId="thickness" />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 200px;
    min-height: 250px;
  }/* Mono-video stripe — same accent the OUT handle uses, so the card reads
     as a mono-video producer at a glance. */
  .stripe {background: var(--cable-mono-video); }  /* 1u (180px tall): the two faders sit in one row, just under the title. */
  .fader-grid {
    margin-top: 2px;
    padding: 0 18px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 16px;
    justify-items: center;
  }
</style>
