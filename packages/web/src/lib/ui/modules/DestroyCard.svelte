<script lang="ts">
  // ⚠ EVERY RANGE, CURVE, UNIT **AND LABEL** IS BOUND TO THE DEF (`paramSpec`),
  // NEVER RE-TYPED — the #1746 / featurecv treatment, paid rather than deferred
  // because promotion is what makes the divergence user-visible.
  //
  // All three of this card's numeric props AGREED with the def; ONE label did
  // not:
  //
  //     decimate   def 'Dec'   card 'Decimate'
  //
  // It sat in `VOCABULARY_DEBT` (card-def-debt.ts), and a face PR IS that
  // ledger's release condition: `ModuleShell` renders the dock full view
  // straight off the `ParamDef`, so shipping the face without binding labels
  // would have left the dock calling this control `Dec` and the card calling it
  // `Decimate`, with nobody reviewing the rename. The entry is DELETED, not
  // re-worded (CLAUDE.md: when debt is paid, delete the mechanism). The DEF
  // took the CARD's wording — `Decimate` is unambiguous where `Dec` could be
  // decay — so NO PIXEL MOVED on this card and nothing was renamed for a user.
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { destroyDef } from '$lib/audio/modules/destroy';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { paramVal, set, live } = cardParams(destroyDef, () => id, () => node);

  /** THE ONE COPY of every number, curve, unit and label this card paints. */
  const P = {
    decimate: paramSpec(destroyDef, 'decimate'),
    bits: paramSpec(destroyDef, 'bits'),
    wet: paramSpec(destroyDef, 'wet'),
  };

  let decimate = $derived(paramVal('decimate'));
  let bits = $derived(paramVal('bits'));
  let wet = $derived(paramVal('wet'));

  const inputs = portsFromDef(destroyDef.inputs);
  const outputs = portsFromDef(destroyDef.outputs, { audio: 'OUT' });
</script>

<div class="mod-card destroy-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="DESTROY" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <NeonFader value={decimate} min={P.decimate.min} max={P.decimate.max} defaultValue={P.decimate.defaultValue} label={P.decimate.label} units={P.decimate.units} curve={P.decimate.curve} onchange={set('decimate')} moduleId={id} paramId="decimate" readLive={live('decimate')} />
      <NeonFader value={bits} min={P.bits.min} max={P.bits.max} defaultValue={P.bits.defaultValue} label={P.bits.label} units={P.bits.units} curve={P.bits.curve} onchange={set('bits')} moduleId={id} paramId="bits" readLive={live('bits')} />
      <NeonFader value={wet} min={P.wet.min} max={P.wet.max} defaultValue={P.wet.defaultValue} label={P.wet.label} units={P.wet.units} curve={P.wet.curve} onchange={set('wet')} moduleId={id} paramId="wet" readLive={live('wet')} />
    </div>
  </PatchPanel>
</div>

<style>
  .destroy-card { width: 220px; }
  .destroy-card .fader-row { padding: 0 18px; margin-top: 14px; }
</style>
