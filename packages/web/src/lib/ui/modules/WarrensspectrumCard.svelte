<script lang="ts">
  // WARREN'S SPECTRUM — spectral-resynth engine (phase 1).
  //
  // Card pattern: PatchPanel (yellow drill-down jacks, no raw Handles) +
  // two Fader rows. The first row carries the six PERFORMATIVE controls —
  // the ones that change what the module IS rather than how it is trimmed:
  // PARTIALS (density + the CPU dial), LOCK (musical vs. faithful), RESIDUAL
  // (the noise half that stops it sounding like a vocoder), SLICE (the
  // rhythmic axis), FREEZE (the one gesture), SHAPE (the voice waveform).
  // The second row is the analysis/trim tail.
  //
  // ⚠ NO curated dock FACE here on purpose. The generic faceplate platform
  // is in flight (#1301, branch feat/faceplate-platform-v2) and is NOT
  // merged; authoring a `face` block against the shipped platform now would
  // either duplicate that work or special-case the shell. The curated face
  // (order + pages, per §5 of .myrobots/plans/warrens-spectrum-2026-08-02.md)
  // is an explicit follow-up that lands ON the platform once #1301 is in.
  //
  // EVERY range, curve, unit, label and format comes from the DEF — see
  // card-range-source.test.ts for why re-typing any of them is a bug class
  // and not a style preference.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import { warrensspectrumDef } from '$lib/audio/modules/warrensspectrum';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live, paramVal } = cardParams(warrensspectrumDef, () => id, () => node);

  const p = (pid: string) => paramSpec(warrensspectrumDef, pid);
  const pPartials = p('spectralPartials');
  const pLock     = p('spectralLock');
  const pResidual = p('spectralResidual');
  const pSlice    = p('spectralSlice');
  const pFreeze   = p('engineFreeze');
  const pShape    = p('spectralShape');
  const pFloor    = p('spectralFloor');
  const pStab     = p('spectralStab');
  const pSlew     = p('spectralSlew');
  const pCenter   = p('spectralCenter');
  const pGain     = p('gain');

  let partials = $derived(paramVal('spectralPartials'));
  let lock     = $derived(paramVal('spectralLock'));
  let residual = $derived(paramVal('spectralResidual'));
  let slice    = $derived(paramVal('spectralSlice'));
  let freeze   = $derived(paramVal('engineFreeze'));
  let shape    = $derived(paramVal('spectralShape'));
  let floorDb  = $derived(paramVal('spectralFloor'));
  let stab     = $derived(paramVal('spectralStab'));
  let slew     = $derived(paramVal('spectralSlew'));
  let center   = $derived(paramVal('spectralCenter'));
  let gain     = $derived(paramVal('gain'));

  // FREEZE is engaged by the control OR a high GATE — mirror that in the
  // readout so a cable-driven freeze is visible on the card, not just audible.
  let frozen = $derived(freeze >= 0.5);

  const inputs = portsFromDef(warrensspectrumDef.inputs, { audio_in: 'IN' });
  const outputs = portsFromDef(warrensspectrumDef.outputs, { out: 'OUT' });
</script>

<div class="mod-card warrensspectrum-card" data-testid="warrensspectrum-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="WARREN'S SPECTRUM" />
  <div class="state-readout" class:frozen data-testid="warrensspectrum-state">
    {frozen ? 'FROZEN' : 'RESYNTH'}
  </div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={partials} min={pPartials.min} max={pPartials.max} defaultValue={pPartials.defaultValue} label={pPartials.label} units={pPartials.units} curve={pPartials.curve} formatValue={pPartials.format} onchange={set('spectralPartials')} readLive={live('spectralPartials')} moduleId={id} paramId="spectralPartials" />
      <Fader value={lock}     min={pLock.min}     max={pLock.max}     defaultValue={pLock.defaultValue}     label={pLock.label}     units={pLock.units}     curve={pLock.curve}     formatValue={pLock.format}     onchange={set('spectralLock')}     readLive={live('spectralLock')}     moduleId={id} paramId="spectralLock" />
      <Fader value={residual} min={pResidual.min} max={pResidual.max} defaultValue={pResidual.defaultValue} label={pResidual.label} units={pResidual.units} curve={pResidual.curve} formatValue={pResidual.format} onchange={set('spectralResidual')} readLive={live('spectralResidual')} moduleId={id} paramId="spectralResidual" />
      <Fader value={slice}    min={pSlice.min}    max={pSlice.max}    defaultValue={pSlice.defaultValue}    label={pSlice.label}    units={pSlice.units}    curve={pSlice.curve}    formatValue={pSlice.format}    onchange={set('spectralSlice')}    readLive={live('spectralSlice')}    moduleId={id} paramId="spectralSlice" />
      <Fader value={freeze}   min={pFreeze.min}   max={pFreeze.max}   defaultValue={pFreeze.defaultValue}   label={pFreeze.label}   units={pFreeze.units}   curve={pFreeze.curve}   formatValue={pFreeze.format}   onchange={set('engineFreeze')}     readLive={live('engineFreeze')}     moduleId={id} paramId="engineFreeze" />
      <Fader value={shape}    min={pShape.min}    max={pShape.max}    defaultValue={pShape.defaultValue}    label={pShape.label}    units={pShape.units}    curve={pShape.curve}    formatValue={pShape.format}    onchange={set('spectralShape')}    readLive={live('spectralShape')}    moduleId={id} paramId="spectralShape" />
    </div>
    <div class="fader-row">
      <Fader value={floorDb} min={pFloor.min}  max={pFloor.max}  defaultValue={pFloor.defaultValue}  label={pFloor.label}  units={pFloor.units}  curve={pFloor.curve}  formatValue={pFloor.format}  onchange={set('spectralFloor')}  readLive={live('spectralFloor')}  moduleId={id} paramId="spectralFloor" />
      <Fader value={stab}    min={pStab.min}   max={pStab.max}   defaultValue={pStab.defaultValue}   label={pStab.label}   units={pStab.units}   curve={pStab.curve}   formatValue={pStab.format}   onchange={set('spectralStab')}   readLive={live('spectralStab')}   moduleId={id} paramId="spectralStab" />
      <Fader value={slew}    min={pSlew.min}   max={pSlew.max}   defaultValue={pSlew.defaultValue}   label={pSlew.label}   units={pSlew.units}   curve={pSlew.curve}   formatValue={pSlew.format}   onchange={set('spectralSlew')}   readLive={live('spectralSlew')}   moduleId={id} paramId="spectralSlew" />
      <Fader value={center}  min={pCenter.min} max={pCenter.max} defaultValue={pCenter.defaultValue} label={pCenter.label} units={pCenter.units} curve={pCenter.curve} formatValue={pCenter.format} onchange={set('spectralCenter')} readLive={live('spectralCenter')} moduleId={id} paramId="spectralCenter" />
      <Fader value={gain}    min={pGain.min}   max={pGain.max}   defaultValue={pGain.defaultValue}   label={pGain.label}   units={pGain.units}   curve={pGain.curve}   formatValue={pGain.format}   onchange={set('gain')}           readLive={live('gain')}           moduleId={id} paramId="gain" />
    </div>
  </PatchPanel>
  <OssAttribution author={warrensspectrumDef.ossAttribution?.author} />
</div>

<style>
  .warrensspectrum-card { width: 360px; }
  .warrensspectrum-card .state-readout {
    text-align: center;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    color: var(--text-muted, #999);
    margin-top: -3px;
    margin-bottom: 0;
  }
  .warrensspectrum-card .state-readout.frozen { color: var(--cable-gate, #7fd); }
  .warrensspectrum-card .fader-row {
    margin-top: 3px;
    display: flex;
    justify-content: center;
    gap: 8px;
    padding: 0 12px;
  }
</style>
