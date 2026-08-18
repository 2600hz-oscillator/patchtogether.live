<script lang="ts">
  // DELAY — mono delay line with time / feedback / mix. Pure-JS
  // factory wires a DelayNode + feedback loop; see
  // /Users/2600hz/Documents/workspace/inet.modular/packages/web/src/lib/audio/modules/delay.ts
  // for the topology.
  //
  // RANGES, MAPPING **AND VOCABULARY** COME FROM THE DEF, never re-typed here.
  // This card used to spell out all three faders as literals — nine range
  // numbers, two curves, a unit and a caption — on the line BELOW one that
  // already read the def for the initial value, so it read the def for half of
  // each param and hardcoded the other half. Every number AGREED with the def,
  // but by maintenance rather than by construction, and no gate in this repo
  // reads both sides (CLAUDE.md: "A CARD can silently disagree with its DEF").
  // `card-range-source.test.ts` guards it at the SOURCE level, which is the
  // only place the divergence is visible at all.
  //
  // ONE of the re-typed props was ALREADY WRONG rather than merely fragile:
  // the middle fader was captioned `Fb` while the def declares `Feedback`, so
  // the same control had two names depending on which surface you looked at.
  // Binding the label removes the choice.
  //
  // `formatValue` is the half a re-typing matcher structurally CANNOT see: a
  // def-declared `format` the card never passes on is a DISAGREEMENT, not a
  // downgrade. Without it these faders print `0.40` while the curated face,
  // reading the SAME param, prints `8 REP`.
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { delayDef } from '$lib/audio/modules/delay';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live, paramVal } = cardParams(delayDef, () => id, () => node);

  const pTime     = paramSpec(delayDef, 'time');
  const pFeedback = paramSpec(delayDef, 'feedback');
  const pMix      = paramSpec(delayDef, 'mix');

  let time     = $derived(paramVal('time'));
  let feedback = $derived(paramVal('feedback'));
  let mix      = $derived(paramVal('mix'));

  const inputs = portsFromDef(delayDef.inputs, { audio: 'IN' });
  const outputs = portsFromDef(delayDef.outputs, { audio: 'OUT' });
</script>

<div class="mod-card delay-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="DELAY" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <NeonFader value={time}     min={pTime.min}     max={pTime.max}     defaultValue={pTime.defaultValue}     label={pTime.label}     units={pTime.units}     curve={pTime.curve}     formatValue={pTime.format}     onchange={set('time')}     readLive={live('time')}     moduleId={id} paramId="time" />
      <NeonFader value={feedback} min={pFeedback.min} max={pFeedback.max} defaultValue={pFeedback.defaultValue} label={pFeedback.label} units={pFeedback.units} curve={pFeedback.curve} formatValue={pFeedback.format} onchange={set('feedback')} readLive={live('feedback')} moduleId={id} paramId="feedback" />
      <NeonFader value={mix}      min={pMix.min}      max={pMix.max}      defaultValue={pMix.defaultValue}      label={pMix.label}      units={pMix.units}      curve={pMix.curve}      formatValue={pMix.format}      onchange={set('mix')}      readLive={live('mix')}      moduleId={id} paramId="mix" />
    </div>
  </PatchPanel>
</div>

<style>
  .delay-card { width: 200px; }
  .delay-card .fader-row { margin-top: 14px; padding: 0 18px; }
</style>
