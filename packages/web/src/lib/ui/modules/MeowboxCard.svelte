<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { meowboxDef } from '$lib/audio/modules/meowbox';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(meowboxDef, () => id, () => node);

  let pitch = $derived(node?.params.pitch ?? meowboxDef.params[0]!.defaultValue);
  let morph = $derived(node?.params.morph ?? meowboxDef.params[1]!.defaultValue);
  let decay = $derived(node?.params.decay ?? meowboxDef.params[2]!.defaultValue);
  let level = $derived(node?.params.level ?? meowboxDef.params[3]!.defaultValue);


  const inputs = portsFromDef(meowboxDef.inputs);
  const outputs = portsFromDef(meowboxDef.outputs);
</script>

<div class="mod-card meowbox-card">
  <div class="ear ear-left"></div>
  <div class="ear ear-right"></div>
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="MEOWBOX" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="knob-row">
      <Knob value={pitch} min={-36}  max={36} defaultValue={0}    label="Pitch"  units="st" curve="linear" onchange={set('pitch')} moduleId={id} paramId="pitch" readLive={live('pitch')} />
      <Knob value={morph} min={0}    max={1}  defaultValue={0.25} label="Morph"             curve="linear" onchange={set('morph')} moduleId={id} paramId="morph" readLive={live('morph')} />
      <Knob value={decay} min={0.05} max={2}  defaultValue={0.4}  label="Decay"  units="s"  curve="log"    onchange={set('decay')} moduleId={id} paramId="decay" readLive={live('decay')} />
      <Knob value={level} min={0}    max={2}  defaultValue={1}    label="Level"             curve="linear" onchange={set('level')} moduleId={id} paramId="level" readLive={live('level')} />
    </div>
  </PatchPanel>
</div>

<style>
  .meowbox-card {
    width: 240px;
    overflow: visible;
  }
  .meowbox-card .ear {
    position: absolute;
    top: -16px;
    width: 0;
    height: 0;
    border-left: 14px solid transparent;
    border-right: 14px solid transparent;
    border-bottom: 22px solid var(--meowbox-ear-color, #6e8aa6);
  }
  .meowbox-card .ear-left {
    left: 30px;
    transform: rotate(-12deg);
  }
  .meowbox-card .ear-right {
    right: 30px;
    transform: rotate(12deg);
  }
  .meowbox-card .knob-row {
    margin-top: 32px;
    display: flex;
    justify-content: center;
    gap: 14px;
    padding: 0 16px;
    flex-wrap: wrap;
  }
</style>
