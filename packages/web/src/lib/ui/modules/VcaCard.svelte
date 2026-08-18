<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { vcaDef } from '$lib/audio/modules/vca';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live, paramVal } = cardParams(vcaDef, () => id, () => node);

  // RANGES **AND VOCABULARY** COME FROM THE DEF, never re-typed here. This card
  // used to spell out both faders' min / max / defaultValue as literals —
  // numbers that AGREED with the def, but only by maintenance rather than by
  // construction, and no gate in this repo reads both sides (CLAUDE.md: "A CARD
  // can silently disagree with its DEF"). `card-range-source.test.ts` guards it
  // at the SOURCE level, which is the only place the divergence is visible.
  //
  // `formatValue` is the half a re-typing matcher structurally CANNOT see: a
  // def-declared `format` the card never passes on is a DISAGREEMENT, not a
  // downgrade — a card that binds everything and a card that binds half look
  // identical in source. Without it these faders printed `0.25` while the
  // curated face, reading the SAME param, printed `-12 dB`. The
  // format-omission test in card-range-source reads the DEF and requires
  // `formatValue={…}` on every control whose param declares one, so it cannot
  // be quietly dropped again. ZERO-PIXEL: the value tag renders inside
  // `{#if dragging || hovering}` and no VRT scene hovers a vca fader.
  const pBase     = paramSpec(vcaDef, 'base');
  const pCvAmount = paramSpec(vcaDef, 'cvAmount');

  let base = $derived(paramVal('base'));
  let cvAmount = $derived(paramVal('cvAmount'));

  // Jack labels are authored on the def (PortDef.label), so the card carries no
  // override map: the rear card, the drill-down and this panel all say `OUT` /
  // `OUT INV` because there is only one place that string exists.
  const inputs = portsFromDef(vcaDef.inputs);
  const outputs = portsFromDef(vcaDef.outputs);
</script>

<div class="mod-card vca-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="VCA" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <NeonFader value={base}     min={pBase.min}     max={pBase.max}     defaultValue={pBase.defaultValue}     label={pBase.label}     units={pBase.units}     curve={pBase.curve}     formatValue={pBase.format}     onchange={set('base')}     readLive={live('base')}     moduleId={id} paramId="base" />
      <NeonFader value={cvAmount} min={pCvAmount.min} max={pCvAmount.max} defaultValue={pCvAmount.defaultValue} label={pCvAmount.label} units={pCvAmount.units} curve={pCvAmount.curve} formatValue={pCvAmount.format} onchange={set('cvAmount')} readLive={live('cvAmount')} moduleId={id} paramId="cvAmount" />
    </div>
  </PatchPanel>
</div>

<style>
  .vca-card { width: 160px; }
</style>
