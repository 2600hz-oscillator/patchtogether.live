<script lang="ts">
  // VideoMixerCard — 4-channel video mixer. Each row pairs an `in{N}`
  // video input with an `amount{N}` CV input + corresponding fader.
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { mixerVideoDef } from '$lib/video/modules/mixer';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = mixerVideoDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs = portsFromDef(mixerVideoDef.inputs, {
    amount1: 'AMOUNT 1', amount2: 'AMOUNT 2', amount3: 'AMOUNT 3', amount4: 'AMOUNT 4',
  });
  const outputs = portsFromDef(mixerVideoDef.outputs);
</script>

<div class="vcard card video">
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
  }/* 1u: the 4 channel faders in one row under the title. */
  .fader-grid {
    margin-top: 4px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px 4px;
    justify-items: center;
  }
</style>
