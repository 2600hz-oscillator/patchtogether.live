<script lang="ts">
  // RINGBACK — stereo crush effect (the TWOTRACKS record-time artifact, made
  // intentional). Stereo in (L/R) → stereo out (L/R). Four knobs expose the
  // mechanism: RATE (cells per sample), SIZE (ring length), FEEDBACK (regen),
  // MIX (dry/wet). See packages/web/src/lib/audio/modules/ringback.ts.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { ringbackDef } from '$lib/audio/modules/ringback';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, paramVal } = cardParams(ringbackDef, () => id, () => node);

  // RANGES, MAPPING **AND VOCABULARY** COME FROM THE DEF — never re-typed here.
  // This card used to spell out all four knobs' min / max / defaultValue /
  // curve / units as literals, plus its own captions (`FB` where the def says
  // `Feedback`). They agreed with the def by maintenance rather than by
  // construction, and NO gate we own reads both sides (CLAUDE.md: "A CARD can
  // silently disagree with its DEF"). `card-range-source.test.ts` guards it at
  // the SOURCE level, which is the only place the divergence is visible.
  //
  // `formatValue` is the half a re-typing matcher structurally cannot see: a
  // def-declared `format` the card never passes on is a DISAGREEMENT, not a
  // downgrade — the curated face would print `SR/2.0` while this card printed
  // `0.50` for the same param. ZERO-PIXEL here: Knob renders its value tag only
  // inside `{#if dragging || hovering}`, and no VRT scene hovers a knob.
  const pRate = paramSpec(ringbackDef, 'rate');
  const pSize = paramSpec(ringbackDef, 'size');
  const pFeedback = paramSpec(ringbackDef, 'feedback');
  const pMix = paramSpec(ringbackDef, 'mix');

  let rate = $derived(paramVal('rate'));
  let size = $derived(paramVal('size'));
  let feedback = $derived(paramVal('feedback'));
  let mix = $derived(paramVal('mix'));

  // Jack labels are authored on the def (PortDef.label), so this card carries
  // no override map: the rear card, the lane drill-down and this panel all say
  // `L` / `R` because there is only one place that string exists.
  const inputs = portsFromDef(ringbackDef.inputs);
  const outputs = portsFromDef(ringbackDef.outputs);
</script>

<div class="mod-card ringback-card" data-testid="ringback-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="RINGBACK" />
  <div class="subtitle">STEREO CRUSH · RING + FEEDBACK</div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="knob-row" data-testid="ringback-knobs">
      <!-- `size` is NOT rounded on write. The DSP core rounds it itself
           (`clampSize`), and the curated face's knob does not round either —
           so rounding here would have made the card and the shell store
           different numbers for an identical sound. One law, in the DSP. -->
      <Knob value={rate} min={pRate.min} max={pRate.max} defaultValue={pRate.defaultValue}
        label={pRate.label} units={pRate.units} curve={pRate.curve} formatValue={pRate.format}
        onchange={set('rate')} moduleId={id} paramId="rate" />
      <Knob value={size} min={pSize.min} max={pSize.max} defaultValue={pSize.defaultValue}
        label={pSize.label} units={pSize.units} curve={pSize.curve} formatValue={pSize.format}
        onchange={set('size')} moduleId={id} paramId="size" />
      <Knob value={feedback} min={pFeedback.min} max={pFeedback.max} defaultValue={pFeedback.defaultValue}
        label={pFeedback.label} units={pFeedback.units} curve={pFeedback.curve} formatValue={pFeedback.format}
        onchange={set('feedback')} moduleId={id} paramId="feedback" />
      <Knob value={mix} min={pMix.min} max={pMix.max} defaultValue={pMix.defaultValue}
        label={pMix.label} units={pMix.units} curve={pMix.curve} formatValue={pMix.format}
        onchange={set('mix')} moduleId={id} paramId="mix" />
    </div>
  </PatchPanel>
</div>

<style>
  .ringback-card {
    width: 240px;
  }
  .ringback-card .subtitle {
    font-size: 0.50rem;
    color: var(--text-dim, #8b94a5);
    text-align: center;
    letter-spacing: 0.07em;
    margin-top: 2px;
  }
  .ringback-card .knob-row {
    margin-top: 12px;
    padding: 0 12px 6px;
    display: flex;
    align-items: flex-start;
    justify-content: space-around;
    gap: 6px;
  }
  .ringback-card .knob-row :global(.knob) {
    width: 34px;
    height: 34px;
  }
  .ringback-card .knob-row :global(.label) {
    font-size: 0.44rem;
  }
</style>
