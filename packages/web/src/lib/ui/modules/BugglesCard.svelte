<script lang="ts">
  // ⚠ EVERY RANGE, CURVE, DEFAULT AND LABEL IS BOUND TO THE DEF (`paramSpec`),
  // NEVER RE-TYPED. The Q13 audit found NO disagreement here — all five
  // controls' restated `min`/`max`/`defaultValue`/`curve`/`label` matched the
  // def exactly — which is precisely why the conversion is safe to make in the
  // faceplate PR: because the numbers already agree, binding them is provably
  // PIXEL-NEUTRAL, so this module's `STRICT_VRT_MODULES` card baseline must not
  // move. That is the difference from wavetableVco (#1681), where binding `min`
  // moved a fader handle from the bottom of its track to the middle and the
  // baseline had to be re-captured. A card that re-types a number is a HAZARD
  // even when the number is right — `card-def-agreement.ts` catches the wrong
  // one, and this removes the chance of a future wrong one.
  //
  // The index-based `bugglesDef.params[0]!` lookups this replaces were a second
  // hazard of their own: they bind by POSITION, so re-ordering `params` (which
  // no gate forbids) would have silently re-pointed every default.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { bugglesDef } from '$lib/audio/modules/buggles';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(bugglesDef, () => id, () => node);

  /** THE ONE COPY of every number, curve and label this card paints. */
  const P = {
    rate: paramSpec(bugglesDef, 'rate'),
    chaos: paramSpec(bugglesDef, 'chaos'),
    smoothness: paramSpec(bugglesDef, 'smoothness'),
    burst_probability: paramSpec(bugglesDef, 'burst_probability'),
    level: paramSpec(bugglesDef, 'level'),
  };

  let rate       = $derived(node?.params.rate              ?? P.rate.defaultValue);
  let chaos      = $derived(node?.params.chaos             ?? P.chaos.defaultValue);
  let smoothness = $derived(node?.params.smoothness        ?? P.smoothness.defaultValue);
  let burstProb  = $derived(node?.params.burst_probability ?? P.burst_probability.defaultValue);
  let level      = $derived(node?.params.level             ?? P.level.defaultValue);


  const inputs = portsFromDef(bugglesDef.inputs, {
    clock_cv: 'CLOCK CV', chaos_cv: 'CHAOS CV', external_clock: 'EXT CLK',
  });
  const outputs = portsFromDef(bugglesDef.outputs);
</script>

<div class="mod-card buggles-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="BUGGLES" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={rate}       min={P.rate.min}              max={P.rate.max}              defaultValue={P.rate.defaultValue}              label={P.rate.label}              curve={P.rate.curve}              onchange={set('rate')} moduleId={id} paramId="rate"              readLive={live('rate')} />
      <Fader value={chaos}      min={P.chaos.min}             max={P.chaos.max}             defaultValue={P.chaos.defaultValue}             label={P.chaos.label}             curve={P.chaos.curve}             onchange={set('chaos')} moduleId={id} paramId="chaos"             readLive={live('chaos')} />
      <Fader value={smoothness} min={P.smoothness.min}        max={P.smoothness.max}        defaultValue={P.smoothness.defaultValue}        label={P.smoothness.label}        curve={P.smoothness.curve}        onchange={set('smoothness')} moduleId={id} paramId="smoothness"        readLive={live('smoothness')} />
      <Fader value={burstProb}  min={P.burst_probability.min} max={P.burst_probability.max} defaultValue={P.burst_probability.defaultValue} label={P.burst_probability.label} curve={P.burst_probability.curve} onchange={set('burst_probability')} moduleId={id} paramId="burst_probability" readLive={live('burst_probability')} />
      <Fader value={level}      min={P.level.min}             max={P.level.max}             defaultValue={P.level.defaultValue}             label={P.level.label}             curve={P.level.curve}             onchange={set('level')} moduleId={id} paramId="level"             readLive={live('level')} />
    </div>
  </PatchPanel>
</div>

<style>
  .buggles-card { width: 280px; }
  .buggles-card .fader-row { padding: 0 14px; margin-top: 18px; gap: 4px; }
</style>
