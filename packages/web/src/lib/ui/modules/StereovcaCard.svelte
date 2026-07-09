<script lang="ts">
  // StereovcaCard — stereo VCA + ring modulator. PatchPanel pattern
  // (mirrors VcaCard). Two faders: master LEVEL post-multiply and a
  // bipolar OFFSET that lifts the strength signal so an unpatched
  // (0V) strength can still pass audio at unity (offset=+1).
  //
  // Strength inputs declare cable type `cv` so LFOs / ADSRs land
  // natively (no cross-type cast). The card surfaces L/R-grouped port
  // labels so the panel hover layout matches the L-on-top, R-below
  // stereo convention.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { stereovcaDef } from '$lib/audio/modules/stereovca';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(stereovcaDef, () => id, () => node);

  let level  = $derived(node?.params.level  ?? stereovcaDef.params[0]!.defaultValue);
  let offset = $derived(node?.params.offset ?? stereovcaDef.params[1]!.defaultValue);


  const inputs = portsFromDef(stereovcaDef.inputs, {
    in_l: 'IN L', in_r: 'IN R', strength_l: 'STR L', strength_r: 'STR R',
  });
  const outputs = portsFromDef(stereovcaDef.outputs, { out_l: 'OUT L', out_r: 'OUT R' });
</script>

<div class="mod-card stereovca-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="STEREOVCA" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={level}  min={0}  max={1} defaultValue={1.0} label="Level"  curve="linear" onchange={set('level')} moduleId={id} paramId="level"  readLive={live('level')} />
      <Fader value={offset} min={-1} max={1} defaultValue={0}   label="Offset" curve="linear" onchange={set('offset')} moduleId={id} paramId="offset" readLive={live('offset')} />
    </div>
  </PatchPanel>
</div>

<style>
  .stereovca-card { width: 180px; }
  .stereovca-card .fader-row { padding: 0 14px; display: flex; gap: 12px; }
</style>
