<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { vcaDef } from '$lib/audio/modules/vca';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramProps, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live, paramVal } = cardParams(vcaDef, () => id, () => node);

  // RANGES **AND VOCABULARY** COME FROM THE DEF, never re-typed here. This card
  // used to spell out both faders' min / max / defaultValue as literals —
  // numbers that AGREED with the def, but only by maintenance rather than by
  // construction, and no gate in this repo reads both sides (CLAUDE.md: "A CARD
  // can silently disagree with its DEF"). Guarded by card-def-ranges.test.ts.
  //
  // The spread carries `format` too, which is why these faders' value tags say
  // `CLOSED` / `-12 dB` / `DUCK` — the same words the curated face prints —
  // instead of the raw number. Two surfaces, one vocabulary, one source.
  // `card-kit.test.ts` pins what the spread must contain (a DROPPED def claim
  // is invisible to the re-typing matcher: spreading everything and spreading
  // half look identical in source).
  const baseProps = paramProps(vcaDef, 'base');
  const cvAmountProps = paramProps(vcaDef, 'cvAmount');

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
      <Fader {...baseProps}     value={base}     onchange={set('base')}     readLive={live('base')}     moduleId={id} paramId="base" />
      <Fader {...cvAmountProps} value={cvAmount} onchange={set('cvAmount')} readLive={live('cvAmount')} moduleId={id} paramId="cvAmount" />
    </div>
  </PatchPanel>
</div>

<style>
  .vca-card { width: 160px; }
</style>
