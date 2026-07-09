<script lang="ts">
  // MapperCard — UI for MAPPER (video keyer / matte processor).
  //
  // Shows the VIDEO input only where the KEY input is active (key luma ≥
  // threshold), black elsewhere — generalises OUTLINES' `mapped` output to
  // an arbitrary key. Two video inputs (VID + KEY) → one video output
  // (OUT). One THRESHOLD knob with a matching per-param CV input. Mirrors
  // the EdgesCard / LumakeyCard processor-card layout (handles on the
  // left, OUT on the right, fader grid below).
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { mapperDef } from '$lib/video/modules/mapper';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = mapperDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function pdef(name: string): number {
    return mapperDef.params.find((d) => d.id === name)!.defaultValue;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs: PortDescriptor[] = [
    { id: 'video',     label: 'VID', cable: 'video' },
    { id: 'key',       label: 'KEY', cable: 'mono-video' },
    // CV input — id MUST match the param id (cross-domain CV bridge routes
    // cv onto setParam(portId)).
    { id: 'threshold', label: 'THRESH', cable: 'cv' },
  ];
  const outputs = portsFromDef(mapperDef.outputs);
</script>

<div class="vcard card video" data-testid="mapper-card">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="MAPPER" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-grid">
      <Fader value={p('threshold')} min={0} max={1} defaultValue={pdef('threshold')} label="Thresh" curve="linear" onchange={setParam('threshold')} moduleId={id} paramId="threshold" />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 200px;
    min-height: 180px;
  }
  .fader-grid {
    margin-top: 16px;
    padding: 0 12px;
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px 16px;
    justify-items: center;
  }
</style>
