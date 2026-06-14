<script lang="ts">
  // ColorizerCard — mono-video → tinted video. Three CV inputs let an
  // upstream LFO/sequencer drive the tint color.
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { colorizerDef } from '$lib/video/modules/colorizer';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = colorizerDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs: PortDescriptor[] = [
    { id: 'in',    label: 'IN', cable: 'mono-video' },
    { id: 'tintR', label: 'R',  cable: 'cv' },
    { id: 'tintG', label: 'G',  cable: 'cv' },
    { id: 'tintB', label: 'B',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'video' },
  ];
</script>

<div class="card video">
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
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--cable-video); }
  .title { font-size: 0.85rem; font-weight: 500; text-align: center; margin: 0 0 8px; letter-spacing: 0.05em; }
  .fader-grid {
    margin-top: 12px;
    padding: 0 12px;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px 8px;
    justify-items: center;
  }
</style>
