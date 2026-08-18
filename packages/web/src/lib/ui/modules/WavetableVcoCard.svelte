<script lang="ts">
  // #1681. ⚠ EVERY RANGE, CURVE, UNIT AND LABEL IS BOUND TO THE DEF (`paramSpec`),
  // NEVER RE-TYPED. This card is the reason that rule has teeth: it shipped
  // `min={0}` on `fmAmount` and `pmAmount` where the def declares `min: -1`, so
  // the documented polarity inversion ("negative values invert the modulator's
  // polarity") was UNREACHABLE from the card while the def-driven dock face
  // reached all of it — one param, two travels, depending on which surface you
  // touched. That is the `analogVco` backdraft class verbatim, and it was
  // invisible to `contract-lock`, `module-docs-lint` and every range assertion,
  // because they all read the DEF.
  //
  // It was carried as a NAMED `OPERATIONAL_DEBT` entry deferred until "a PR
  // that also carries the vrt-update.yml dispatch", because binding `min` moves
  // the fader handle for value 0 from the bottom of the track to its middle and
  // this module is in `STRICT_VRT_MODULES`. The faceplate PR is that PR: the
  // ledger entry is deleted, the card is enrolled in RANGE_BOUND_CARDS +
  // MAPPING_BOUND_CARDS, and the baseline is re-captured by the same dispatch
  // that authors the two new face scenes.
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { wavetableVcoDef } from '$lib/audio/modules/wavetable-vco';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { paramVal, set, live } = cardParams(wavetableVcoDef, () => id, () => node);

  /** THE ONE COPY of every number, curve, unit and label this card paints. */
  const P = {
    tune:     paramSpec(wavetableVcoDef, 'tune'),
    fine:     paramSpec(wavetableVcoDef, 'fine'),
    wavePos:  paramSpec(wavetableVcoDef, 'wavePos'),
    fmAmount: paramSpec(wavetableVcoDef, 'fmAmount'),
    pmAmount: paramSpec(wavetableVcoDef, 'pmAmount'),
  };


  const inputs = portsFromDef(wavetableVcoDef.inputs, {
    wavePos: 'WAVE POSITION', fmAmount: 'FM AMT', pmAmount: 'PM AMT',
  });
  const outputs = portsFromDef(wavetableVcoDef.outputs);
</script>

<div class="mod-card wt-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="Wavetable VCO" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <NeonFader value={paramVal('tune')} min={P.tune.min} max={P.tune.max} defaultValue={P.tune.defaultValue} label={P.tune.label} units={P.tune.units} curve={P.tune.curve} onchange={set('tune')} moduleId={id} paramId="tune" readLive={live('tune')} />
      <NeonFader value={paramVal('fine')} min={P.fine.min} max={P.fine.max} defaultValue={P.fine.defaultValue} label={P.fine.label} units={P.fine.units} curve={P.fine.curve} onchange={set('fine')} moduleId={id} paramId="fine" readLive={live('fine')} />
      <NeonFader value={paramVal('wavePos')} min={P.wavePos.min} max={P.wavePos.max} defaultValue={P.wavePos.defaultValue} label={P.wavePos.label} units={P.wavePos.units} curve={P.wavePos.curve} onchange={set('wavePos')} moduleId={id} paramId="wavePos" readLive={live('wavePos')} />
      <NeonFader value={paramVal('fmAmount')} min={P.fmAmount.min} max={P.fmAmount.max} defaultValue={P.fmAmount.defaultValue} label={P.fmAmount.label} units={P.fmAmount.units} curve={P.fmAmount.curve} onchange={set('fmAmount')} moduleId={id} paramId="fmAmount" readLive={live('fmAmount')} />
      <NeonFader value={paramVal('pmAmount')} min={P.pmAmount.min} max={P.pmAmount.max} defaultValue={P.pmAmount.defaultValue} label={P.pmAmount.label} units={P.pmAmount.units} curve={P.pmAmount.curve} onchange={set('pmAmount')} moduleId={id} paramId="pmAmount" readLive={live('pmAmount')} />
    </div>
  </PatchPanel>
</div>

<style>
  .wt-card { width: 240px; }
  .wt-card .fader-row { padding: 0 18px; margin-top: 14px; }
</style>
