<script lang="ts">
  // InwardsCard — radial pattern source. Mirrors LinesCard's shape; only
  // the param + handle list differs.
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { inwardsDef } from '$lib/video/modules/inwards';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = inwardsDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs: PortDescriptor[] = [
    { id: 'speed',     label: 'SPEED',   cable: 'cv' },
    { id: 'density',   label: 'DENSITY', cable: 'cv' },
    { id: 'thickness', label: 'THICK',   cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'mono-video' },
  ];
</script>

<div class="card video">
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
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px 8px;
    justify-items: center;
  }
</style>
