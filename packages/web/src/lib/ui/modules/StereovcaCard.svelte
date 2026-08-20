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
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { stereovcaDef } from '$lib/audio/modules/stereovca';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { paramVal, set, live } = cardParams(stereovcaDef, () => id, () => node);

  /** THE ONE COPY of every number, curve and label this card paints. Bound
   *  with the FACEPLATE (queue Q42): this card re-typed `min={0} max={1}
   *  defaultValue={1.0}` / `min={-1} max={1} defaultValue={0}` beside a def
   *  declaring exactly those numbers. They agreed, so nothing was red — and
   *  that is the point: every range gate reads the DEF, so a card that drifts
   *  is invisible to the whole gate set (the backdraft class, CLAUDE.md). */
  const P = {
    level: paramSpec(stereovcaDef, 'level'),
    offset: paramSpec(stereovcaDef, 'offset'),
  };

  let level  = $derived(paramVal('level'));
  let offset = $derived(paramVal('offset'));


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
      <NeonFader value={level}  min={P.level.min}  max={P.level.max}  defaultValue={P.level.defaultValue}  label={P.level.label}  curve={P.level.curve}  onchange={set('level')}  moduleId={id} paramId="level"  readLive={live('level')} />
      <NeonFader value={offset} min={P.offset.min} max={P.offset.max} defaultValue={P.offset.defaultValue} label={P.offset.label} curve={P.offset.curve} onchange={set('offset')} moduleId={id} paramId="offset" readLive={live('offset')} />
    </div>
  </PatchPanel>
</div>

<style>
  .stereovca-card { width: 180px; }
  .stereovca-card .fader-row { padding: 0 14px; display: flex; gap: 12px; }
</style>
