<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ScopeScreen from '$lib/ui/controls/ScopeScreen.svelte';
  import { adsrDef } from '$lib/audio/modules/adsr';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(adsrDef, () => id, () => node);

  // RANGE / CURVE / DEFAULT / FORMAT come from the DEF — never re-typed here. A
  // card that restates its def's numbers can silently disagree with it, and
  // every gate we own (contract-lock, module-docs-lint, the range assertions)
  // reads only the def, so the disagreement is invisible to CI. See card-kit's
  // `paramSpec`. Guarded at the SOURCE level by card-range-source.test.ts.
  //
  // ⚠ `formatValue` IS PART OF THAT SET, and it was the one field left behind.
  // Without it the Fader falls back to its own magnitude ladder
  // (`abs < 10 → toFixed(2)`), which prints the attack DEFAULT as `0.01 s` and
  // collapses the whole 1–9 ms decade onto `0.00 s`/`0.01 s` — while the dock,
  // reading the same param's declared `format`, prints `5 MS`. One param, two
  // surfaces, two laws, and the def says which is right. This is a ZERO-PIXEL
  // change to every baseline: `Fader.svelte` renders the value tag inside
  // `{#if dragging || hovering}`, and no VRT scene hovers or drags an adsr
  // fader (the sustain-low/high composites set the value through `setup`).
  const pAttack  = paramSpec(adsrDef, 'attack');
  const pDecay   = paramSpec(adsrDef, 'decay');
  const pSustain = paramSpec(adsrDef, 'sustain');
  const pRelease = paramSpec(adsrDef, 'release');

  let attack  = $derived(node?.params.attack  ?? pAttack.defaultValue);
  let decay   = $derived(node?.params.decay   ?? pDecay.defaultValue);
  let sustain = $derived(node?.params.sustain ?? pSustain.defaultValue);
  let release = $derived(node?.params.release ?? pRelease.defaultValue);

  const inputs = portsFromDef(adsrDef.inputs);
  // No label override: `env` derives to ENVELOPE and `env_inv` to ENV INV
  // already (patch-panel-labels), so restating either here would just be a
  // second copy that can drift.
  const outputs = portsFromDef(adsrDef.outputs);
</script>

<div class="mod-card adsr-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="ADSR" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Live DECAY-screen glyph: the ADSR curve recomputed as the faders move. -->
    <div class="env-screen">
      <ScopeScreen
        mode="envelope"
        {attack}
        {decay}
        {sustain}
        {release}
        width={204}
        height={56}
        testid="adsr-envelope-screen"
        ariaLabel="ADSR envelope shape"
      />
    </div>
    <div class="fader-row">
      <NeonFader value={attack}  min={pAttack.min}  max={pAttack.max}  defaultValue={pAttack.defaultValue}  label="Attack"  units={pAttack.units}  curve={pAttack.curve}  formatValue={pAttack.format}  onchange={set('attack')}  readLive={live('attack')}  moduleId={id} paramId="attack" />
      <NeonFader value={decay}   min={pDecay.min}   max={pDecay.max}   defaultValue={pDecay.defaultValue}   label="Decay"   units={pDecay.units}   curve={pDecay.curve}   formatValue={pDecay.format}   onchange={set('decay')}   readLive={live('decay')}   moduleId={id} paramId="decay" />
      <NeonFader value={sustain} min={pSustain.min} max={pSustain.max} defaultValue={pSustain.defaultValue} label="Sustain" units={pSustain.units} curve={pSustain.curve} formatValue={pSustain.format} onchange={set('sustain')} readLive={live('sustain')} moduleId={id} paramId="sustain" />
      <NeonFader value={release} min={pRelease.min} max={pRelease.max} defaultValue={pRelease.defaultValue} label="Release" units={pRelease.units} curve={pRelease.curve} formatValue={pRelease.format} onchange={set('release')} readLive={live('release')} moduleId={id} paramId="release" />
    </div>
  </PatchPanel>
</div>

<style>
  .adsr-card { width: 240px; }
  .adsr-card .env-screen { padding: 12px 18px 0; display: flex; justify-content: center; }
  .adsr-card .fader-row { padding: 0 18px; margin-top: 12px; }
</style>
