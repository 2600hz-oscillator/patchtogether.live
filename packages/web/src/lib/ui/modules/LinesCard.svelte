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
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { linesDef } from '$lib/video/modules/lines';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = linesDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs: PortDescriptor[] = [
    { id: 'fm',        label: 'FM',     cable: 'mono-video' },
    { id: 'orient',    label: 'ORIENT', cable: 'cv' },
    { id: 'amp',       label: 'AMP',    cable: 'cv' },
    { id: 'thickness', label: 'THICK',  cable: 'cv' },
    { id: 'phase',     label: 'PHASE',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'mono-video' },
  ];
</script>

<div class="card video">
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
    background: var(--cable-mono-video);
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.05em;
  }
  .fader-grid {
    margin-top: 14px;
    padding: 0 12px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 16px;
    justify-items: center;
  }
</style>
