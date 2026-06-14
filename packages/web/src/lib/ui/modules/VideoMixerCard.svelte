<script lang="ts">
  // VideoMixerCard — 4-channel video mixer. Each row pairs an `in{N}`
  // video input with an `amount{N}` CV input + corresponding fader.
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { mixerVideoDef } from '$lib/video/modules/mixer';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = mixerVideoDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs: PortDescriptor[] = [
    { id: 'in1', label: 'IN1', cable: 'video' },
    { id: 'in2', label: 'IN2', cable: 'video' },
    { id: 'in3', label: 'IN3', cable: 'video' },
    { id: 'in4', label: 'IN4', cable: 'video' },
    { id: 'amount1', label: 'AMOUNT 1', cable: 'cv' },
    { id: 'amount2', label: 'AMOUNT 2', cable: 'cv' },
    { id: 'amount3', label: 'AMOUNT 3', cable: 'cv' },
    { id: 'amount4', label: 'AMOUNT 4', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'video' },
  ];
</script>

<div class="card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="V-MIXER" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-grid">
      <Fader value={p('amount1')} min={0} max={1} defaultValue={mixerVideoDef.params.find((x) => x.id === 'amount1')!.defaultValue} label="A1" curve="linear" onchange={setParam('amount1')} moduleId={id} paramId="amount1" />
      <Fader value={p('amount2')} min={0} max={1} defaultValue={mixerVideoDef.params.find((x) => x.id === 'amount2')!.defaultValue} label="A2" curve="linear" onchange={setParam('amount2')} moduleId={id} paramId="amount2" />
      <Fader value={p('amount3')} min={0} max={1} defaultValue={mixerVideoDef.params.find((x) => x.id === 'amount3')!.defaultValue} label="A3" curve="linear" onchange={setParam('amount3')} moduleId={id} paramId="amount3" />
      <Fader value={p('amount4')} min={0} max={1} defaultValue={mixerVideoDef.params.find((x) => x.id === 'amount4')!.defaultValue} label="A4" curve="linear" onchange={setParam('amount4')} moduleId={id} paramId="amount4" />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 280px;
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
  /* 1u: the 4 channel faders in one row under the title. */
  .fader-grid {
    margin-top: 4px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px 4px;
    justify-items: center;
  }
</style>
