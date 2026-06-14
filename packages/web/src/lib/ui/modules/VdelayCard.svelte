<script lang="ts">
  // VdelayCard — UI for VDELAY (video delay + feedback echo). Mirrors
  // FeedbackCard's flat-card layout (no on-card preview canvas) since
  // VDELAY publishes its result via the `out` port; users wire it into
  // an OUTPUT / MONOGLITCH / RUTTETRA card to see the result.

  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { vdelayDef, VDELAY_MAX_DELAY } from '$lib/video/modules/vdelay';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = vdelayDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs: PortDescriptor[] = [
    { id: 'in',          label: 'IN', cable: 'video' },
    { id: 'time_cv',     label: 'T',  cable: 'cv' },
    { id: 'feedback_cv', label: 'FB', cable: 'cv' },
    { id: 'mix_cv',      label: 'M',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', cable: 'video' },
  ];
</script>

<div class="card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="VDELAY" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
  <div class="fader-grid">
    <Fader value={p('delayTime')}  min={1} max={VDELAY_MAX_DELAY} defaultValue={vdelayDef.params.find((x) => x.id === 'delayTime')!.defaultValue}  label="Time"  curve="linear" onchange={setParam('delayTime')} moduleId={id} paramId="delayTime" />
    <Fader value={p('feedback')}   min={0} max={0.95}             defaultValue={vdelayDef.params.find((x) => x.id === 'feedback')!.defaultValue}   label="FB"    curve="linear" onchange={setParam('feedback')} moduleId={id} paramId="feedback" />
    <Fader value={p('mix')}        min={0} max={1}                defaultValue={vdelayDef.params.find((x) => x.id === 'mix')!.defaultValue}        label="Mix"   curve="linear" onchange={setParam('mix')} moduleId={id} paramId="mix" />
    <Fader value={p('colorShift')} min={0} max={1}                defaultValue={vdelayDef.params.find((x) => x.id === 'colorShift')!.defaultValue} label="Color" curve="linear" onchange={setParam('colorShift')} moduleId={id} paramId="colorShift" />
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
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--cable-video); }
  .title { font-size: 0.85rem; font-weight: 500; text-align: center; margin: 0 0 8px; letter-spacing: 0.05em; }
  .fader-grid {
    margin-top: 16px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px 6px;
    justify-items: center;
  }
</style>
