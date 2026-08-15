<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { CHARLOTTES_ECHOS_RANGES, charlottesEchosDef } from '$lib/audio/modules/charlottes-echos';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(charlottesEchosDef, () => id, () => node);

  // EVERY range, curve, unit, default and label comes off the def — this card
  // re-types none of them (card-range-source / card-def-agreement). Two of the
  // labels used to disagree with the def outright and were ledgered as debt;
  // binding them here is what paid that ledger off.
  const P = CHARLOTTES_ECHOS_RANGES;

  let delay    = $derived(node?.params.delay    ?? P.delay!.defaultValue);
  let feedback = $derived(node?.params.feedback ?? P.feedback!.defaultValue);
  let decay    = $derived(node?.params.decay    ?? P.decay!.defaultValue);
  let pitchUp  = $derived(node?.params.pitchUp  ?? P.pitchUp!.defaultValue);
  let mix      = $derived(node?.params.mix      ?? P.mix!.defaultValue);

  // Stripe shimmer activates when feedback is high enough that artifacts
  // become audibly compounding.
  let shimmer = $derived(feedback > 0.6);


  const inputs = portsFromDef(charlottesEchosDef.inputs);
  const outputs = portsFromDef(charlottesEchosDef.outputs);
</script>

<div class="mod-card charlottes-echos-card">
  <div class="stripe" class:shimmer style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="CHARLOTTE&#39;S ECHOS" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="knob-row">
      <Knob value={delay}    min={P.delay!.min}    max={P.delay!.max}    defaultValue={P.delay!.defaultValue}    label={P.delay!.label!}    units={P.delay!.units}    curve={P.delay!.curve}    onchange={set('delay')} moduleId={id} paramId="delay"    readLive={live('delay')} />
      <Knob value={feedback} min={P.feedback!.min} max={P.feedback!.max} defaultValue={P.feedback!.defaultValue} label={P.feedback!.label!} units={P.feedback!.units} curve={P.feedback!.curve} onchange={set('feedback')} moduleId={id} paramId="feedback" readLive={live('feedback')} />
      <Knob value={decay}    min={P.decay!.min}    max={P.decay!.max}    defaultValue={P.decay!.defaultValue}    label={P.decay!.label!}    units={P.decay!.units}    curve={P.decay!.curve}    onchange={set('decay')} moduleId={id} paramId="decay"    readLive={live('decay')} />
      <Knob value={pitchUp}  min={P.pitchUp!.min}  max={P.pitchUp!.max}  defaultValue={P.pitchUp!.defaultValue}  label={P.pitchUp!.label!}  units={P.pitchUp!.units}  curve={P.pitchUp!.curve}  onchange={set('pitchUp')} moduleId={id} paramId="pitchUp"  readLive={live('pitchUp')} />
      <Knob value={mix}      min={P.mix!.min}      max={P.mix!.max}      defaultValue={P.mix!.defaultValue}      label={P.mix!.label!}      units={P.mix!.units}      curve={P.mix!.curve}      onchange={set('mix')} moduleId={id} paramId="mix"      readLive={live('mix')} />
    </div>
  </PatchPanel>
</div>

<style>
  .charlottes-echos-card {
    width: 320px;
  }  .charlottes-echos-card .stripe.shimmer {
    background: linear-gradient(
      90deg,
      var(--cable-audio) 0%,
      rgba(255, 255, 255, 0.6) 50%,
      var(--cable-audio) 100%
    );
    background-size: 200% 100%;
    animation: ce-shimmer 1.6s linear infinite;
  }
  :global(body.reduced-effects) .charlottes-echos-card .stripe.shimmer {
    animation: none;
    background: var(--cable-audio);
  }
  @media (prefers-reduced-motion: reduce) {
    .charlottes-echos-card .stripe.shimmer {
      animation: none;
      background: var(--cable-audio);
    }
  }
  @keyframes ce-shimmer {
    0%   { background-position: 0% 0; }
    100% { background-position: 200% 0; }
  }
  .charlottes-echos-card .knob-row {
    margin-top: 14px;
    display: flex;
    justify-content: center;
    gap: 12px;
    padding: 0 18px;
    flex-wrap: wrap;
  }
</style>
