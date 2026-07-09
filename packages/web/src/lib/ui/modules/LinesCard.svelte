<script lang="ts">
  // LinesCard — UI for the Phase 0 LINES procedural source.
  //
  // Mirrors the audio-side card pattern (one Handle per declared port,
  // one fader per param). Visual style sits in the video-domain palette
  // (border accent uses --cable-mono-video so users immediately read the
  // card as "video-domain output").
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { linesDef } from '$lib/video/modules/lines';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = linesDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs = portsFromDef(linesDef.inputs, { thickness: 'THICK' });
  const outputs = portsFromDef(linesDef.outputs);
</script>

<div class="vcard card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="LINES" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-grid">
      <Fader value={p('orient')}    min={0}    max={1}  defaultValue={linesDef.params.find((x) => x.id === 'orient')!.defaultValue}    label="Orient"    curve="linear" onchange={setParam('orient')} moduleId={id} paramId="orient" />
      <Fader value={p('amp')}       min={0.5}  max={50} defaultValue={linesDef.params.find((x) => x.id === 'amp')!.defaultValue}       label="Amp"       curve="linear" onchange={setParam('amp')} moduleId={id} paramId="amp" />
      <Fader value={p('thickness')} min={0}    max={1}  defaultValue={linesDef.params.find((x) => x.id === 'thickness')!.defaultValue} label="Thickness" curve="linear" onchange={setParam('thickness')} moduleId={id} paramId="thickness" />
      <Fader value={p('phase')}     min={0}    max={1}  defaultValue={linesDef.params.find((x) => x.id === 'phase')!.defaultValue}     label="Phase"     curve="linear" onchange={setParam('phase')} moduleId={id} paramId="phase" />
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
    grid-template-columns: 1fr 1fr;
    gap: 12px 16px;
    justify-items: center;
  }
</style>
