<script lang="ts">
  // VdelayCard — UI for VDELAY (video delay + feedback echo). Mirrors
  // FeedbackCard's flat-card layout (no on-card preview canvas) since
  // VDELAY publishes its result via the `out` port; users wire it into
  // an OUTPUT / MONOGLITCH / RUTTETRA card to see the result.

  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { vdelayDef, VDELAY_MAX_DELAY } from '$lib/video/modules/vdelay';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = vdelayDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs = portsFromDef(vdelayDef.inputs, { time_cv: 'T', feedback_cv: 'FB', mix_cv: 'M' });
  const outputs = portsFromDef(vdelayDef.outputs);
</script>

<div class="vcard card video">
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
  }
  .fader-grid {
    margin-top: 16px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px 6px;
    justify-items: center;
  }
</style>
