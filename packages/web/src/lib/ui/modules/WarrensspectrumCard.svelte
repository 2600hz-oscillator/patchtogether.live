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
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import {
    WARRENSSPECTRUM_BAND_SPEC,
    WARRENSSPECTRUM_BANDS_KEY,
    WARRENSSPECTRUM_BANDS_REV_KEY,
    warrensspectrumBands,
    warrensspectrumDef,
    wsDefaultBands,
    WS_ENGINE_MASSPASS,
    type WsBandSettings,
  } from '$lib/audio/modules/warrensspectrum';
  import { mutateNode } from '$lib/graph/mutate';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live, paramVal } = cardParams(warrensspectrumDef, () => id, () => node);

  const p = (pid: string) => paramSpec(warrensspectrumDef, pid);
  const pMode     = p('engineMode');
  const pBands    = p('spectralBandCount');
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
  const pWet      = p('resynthLevel');
  const pInMix    = p('inputMix');
  const pGain     = p('gain');

  let mode = $derived(paramVal('engineMode'));
  // NB: `bandCountIdx`, NOT `bands` — `bands` is the 8-entry FILTERBANK table
  // further down. Two different "bands" on one card; keep them apart.
  let bandCountIdx = $derived(paramVal('spectralBandCount'));
  let partials = $derived(paramVal('spectralPartials'));

  // MASSPASS selected? Drives the DIM on the controls that engine owns.
  //
  // ⚠ DIM, never hide and never `disabled` — the convention
  // `card-control-ranges.test.ts` enforces on BackdraftCard, for two reasons
  // that both apply here: a `{#if}`-ed control makes the card's height
  // mode-dependent (and so its VRT baseline unstable), and a `disabled`
  // control is unreachable by the user while CV and automation keep writing
  // the very same param. A dimmed control keeps its drag, its double-click
  // reset and its MIDI-learn, and explains itself in a `title`.
  let massPassOn = $derived(Math.round(mode) === WS_ENGINE_MASSPASS);
  let lock     = $derived(paramVal('spectralLock'));
  let residual = $derived(paramVal('spectralResidual'));
  let slice    = $derived(paramVal('spectralSlice'));
  let freeze   = $derived(paramVal('engineFreeze'));
  let shape    = $derived(paramVal('spectralShape'));
  let floorDb  = $derived(paramVal('spectralFloor'));
  let stab     = $derived(paramVal('spectralStab'));
  let slew     = $derived(paramVal('spectralSlew'));
  let center   = $derived(paramVal('spectralCenter'));
  let wet      = $derived(paramVal('resynthLevel'));
  let inMix    = $derived(paramVal('inputMix'));
  let gain     = $derived(paramVal('gain'));

  // ── THE 8-BAND FILTERBANK (phase 2) ────────────────────────────────────
  //
  // ⚠ NOT 40 faders. The band table is ONE control family (`ws-filterbank`,
  // 8 addressable cells) — the plan's §5.3 calls that "the only honest way
  // to fit this module", and it is also why the bank costs one authored doc
  // blob instead of forty. A band is SELECTED from the strip and its five
  // values are edited by the row beneath it.
  //
  // ⚠ AND THIS IS NOT THE CURATED DOCK FACE. The faceplate platform (#1301)
  // is still in flight; the filterbank's dock band (a CURVE EDITOR, per the
  // plan) lands ON that platform. This is the ordinary card surface, built
  // from the primitives already in the repo so nothing here is thrown away
  // when the face arrives.
  let selectedBand = $state(0);
  let bands = $derived(warrensspectrumBands(node));
  let sel = $derived(bands[selectedBand] ?? bands[0]!);

  /** Write one band field and bump the revision the factory polls. Values go
   *  through `warrensspectrumBands` on the way out so the table written to
   *  the Y.Doc is always a complete, normalized 8 — never a sparse patch. */
  function setBand(i: number, patch: Partial<WsBandSettings>): void {
    const next = warrensspectrumBands(node).map((b, k) => (k === i ? { ...b, ...patch } : { ...b }));
    mutateNode(id, (liveNode) => {
      if (!liveNode.data) liveNode.data = {};
      liveNode.data[WARRENSSPECTRUM_BANDS_KEY] = next;
      // The counter is what the factory watches — a deep mutation inside the
      // array would not be visible to a poll on the array identity, and a
      // REMOTE peer's edit fires no local callback at all.
      liveNode.data[WARRENSSPECTRUM_BANDS_REV_KEY] =
        Number(liveNode.data[WARRENSSPECTRUM_BANDS_REV_KEY] ?? 0) + 1;
    });
  }

  const bandField = (i: number, key: keyof WsBandSettings) => (v: number) => setBand(i, { [key]: v });

  // Ranges, curve, units and labels ALL come from the def's band spec — the
  // card re-types none of them (card-range-source.test.ts greps for exactly
  // that, and it does not exempt a control just because it has no ParamDef).
  const bandSpec = WARRENSSPECTRUM_BAND_SPEC;
  const BAND_FIELDS = ['cutoffHz', 'q', 'type', 'pan', 'send'] as const;
  // Per-band DEFAULTS differ (cutoffs are log-spaced, type is HP/BP/LP by
  // position), so a double-click "reset" has to restore THIS band's default,
  // not a single shared number.
  const bandDefaults = wsDefaultBands();

  /** Bank is audible only once WET is up — say so rather than letting a user
   *  move eight bands against silence. */
  let bankLive = $derived(wet > 0);

  // FREEZE is engaged by the control OR a high GATE — mirror that in the
  // readout so a cable-driven freeze is visible on the card, not just audible.
  let frozen = $derived(freeze >= 0.5);

  const inputs = portsFromDef(warrensspectrumDef.inputs, { audio_in: 'IN' });
  const outputs = portsFromDef(warrensspectrumDef.outputs, { out: 'OUT' });
</script>

<div class="mod-card warrensspectrum-card" data-testid="warrensspectrum-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="WARREN'S SPECTRUM" />
  <!-- The readout names the ENGINE as well as the freeze state: with two DSP
       classes behind one switch, "which one am I hearing" is the first
       question the card has to answer. -->
  <div class="state-readout" class:frozen data-testid="warrensspectrum-state">
    {massPassOn ? 'MASSPASS' : 'SPECTRAL'} · {frozen ? 'FROZEN' : 'RESYNTH'}
  </div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- ⚠ MODE and BANDS are folded into the EXISTING two rows rather than
         given a third. The card is 3u (540 CSS px) and had no vertical slack:
         a third row pushed the OSS attribution 68 CSS px past the bottom edge
         and `card-control-overflow.spec.ts` caught it. Horizontally there is
         room to spare — a Fader is ~22-30 px in a ~41 px slot at 7 across. -->
    <div class="fader-row">
      <NeonFader value={mode}     min={pMode.min}     max={pMode.max}     defaultValue={pMode.defaultValue}     label={pMode.label}     units={pMode.units}     curve={pMode.curve}     formatValue={pMode.format}     onchange={set('engineMode')}      readLive={live('engineMode')}      moduleId={id} paramId="engineMode" />
      <NeonFader value={partials} min={pPartials.min} max={pPartials.max} defaultValue={pPartials.defaultValue} label={pPartials.label} units={pPartials.units} curve={pPartials.curve} formatValue={pPartials.format} onchange={set('spectralPartials')} readLive={live('spectralPartials')} moduleId={id} paramId="spectralPartials" />
      <div class="mode-scoped" class:dim={massPassOn}
           title={massPassOn
             ? 'LOCK snaps tracked partials onto a harmonic comb — it applies to the SPECTRAL engine only, and MODE is on MASSPASS'
             : 'LOCK snaps tracked partials onto a harmonic comb'}>
        <NeonFader value={lock}     min={pLock.min}     max={pLock.max}     defaultValue={pLock.defaultValue}     label={pLock.label}     units={pLock.units}     curve={pLock.curve}     formatValue={pLock.format}     onchange={set('spectralLock')}     readLive={live('spectralLock')}     moduleId={id} paramId="spectralLock" />
      </div>
      <div class="mode-scoped" class:dim={massPassOn}
           title={massPassOn
             ? 'RESIDUAL is the SMS noise half of the spectral rebuild — it applies to the SPECTRAL engine only, and MODE is on MASSPASS'
             : 'RESIDUAL is the SMS noise half of the spectral rebuild'}>
        <NeonFader value={residual} min={pResidual.min} max={pResidual.max} defaultValue={pResidual.defaultValue} label={pResidual.label} units={pResidual.units} curve={pResidual.curve} formatValue={pResidual.format} onchange={set('spectralResidual')} readLive={live('spectralResidual')} moduleId={id} paramId="spectralResidual" />
      </div>
      <NeonFader value={slice}    min={pSlice.min}    max={pSlice.max}    defaultValue={pSlice.defaultValue}    label={pSlice.label}    units={pSlice.units}    curve={pSlice.curve}    formatValue={pSlice.format}    onchange={set('spectralSlice')}    readLive={live('spectralSlice')}    moduleId={id} paramId="spectralSlice" />
      <NeonFader value={freeze}   min={pFreeze.min}   max={pFreeze.max}   defaultValue={pFreeze.defaultValue}   label={pFreeze.label}   units={pFreeze.units}   curve={pFreeze.curve}   formatValue={pFreeze.format}   onchange={set('engineFreeze')}     readLive={live('engineFreeze')}     moduleId={id} paramId="engineFreeze" />
      <NeonFader value={shape}    min={pShape.min}    max={pShape.max}    defaultValue={pShape.defaultValue}    label={pShape.label}    units={pShape.units}    curve={pShape.curve}    formatValue={pShape.format}    onchange={set('spectralShape')}    readLive={live('spectralShape')}    moduleId={id} paramId="spectralShape" />
    </div>
    <div class="fader-row">
      <!-- BANDS lives in the ANALYSIS row: it is a setup control, not a
           performative one. DIMMED while SPECTRAL is selected. -->
      <div
        class="mode-scoped"
        class:dim={!massPassOn}
        data-testid="warrensspectrum-bands-cell"
        title={massPassOn
          ? 'MASSPASS band count — how many bandpass filters the input is split across'
          : 'BANDS applies to the MASSPASS engine only — switch MODE to MASSPASS to hear it'}
      >
        <NeonFader value={bandCountIdx} min={pBands.min} max={pBands.max} defaultValue={pBands.defaultValue} label={pBands.label} units={pBands.units} curve={pBands.curve} formatValue={pBands.format} onchange={set('spectralBandCount')} readLive={live('spectralBandCount')} moduleId={id} paramId="spectralBandCount" />
      </div>
      <div class="mode-scoped" class:dim={massPassOn}
           title={massPassOn
             ? 'FLOOR is the peak-detection threshold — it applies to the SPECTRAL engine only, and MODE is on MASSPASS'
             : 'FLOOR is the peak-detection threshold'}>
        <NeonFader value={floorDb} min={pFloor.min}  max={pFloor.max}  defaultValue={pFloor.defaultValue}  label={pFloor.label}  units={pFloor.units}  curve={pFloor.curve}  formatValue={pFloor.format}  onchange={set('spectralFloor')}  readLive={live('spectralFloor')}  moduleId={id} paramId="spectralFloor" />
      </div>
      <div class="mode-scoped" class:dim={massPassOn}
           title={massPassOn
             ? 'STABILITY gates how long a partial must persist — it applies to the SPECTRAL engine only, and MODE is on MASSPASS'
             : 'STABILITY gates how long a partial must persist'}>
        <NeonFader value={stab}    min={pStab.min}   max={pStab.max}   defaultValue={pStab.defaultValue}   label={pStab.label}   units={pStab.units}   curve={pStab.curve}   formatValue={pStab.format}   onchange={set('spectralStab')}   readLive={live('spectralStab')}   moduleId={id} paramId="spectralStab" />
      </div>
      <div class="mode-scoped" class:dim={massPassOn}
           title={massPassOn
             ? 'SLEW smooths each tracked partial — it applies to the SPECTRAL engine only, and MODE is on MASSPASS'
             : 'SLEW smooths each tracked partial'}>
        <NeonFader value={slew}    min={pSlew.min}   max={pSlew.max}   defaultValue={pSlew.defaultValue}   label={pSlew.label}   units={pSlew.units}   curve={pSlew.curve}   formatValue={pSlew.format}   onchange={set('spectralSlew')}   readLive={live('spectralSlew')}   moduleId={id} paramId="spectralSlew" />
      </div>
      <NeonFader value={center}  min={pCenter.min} max={pCenter.max} defaultValue={pCenter.defaultValue} label={pCenter.label} units={pCenter.units} curve={pCenter.curve} formatValue={pCenter.format} onchange={set('spectralCenter')} readLive={live('spectralCenter')} moduleId={id} paramId="spectralCenter" />
      <NeonFader value={gain}    min={pGain.min}   max={pGain.max}   defaultValue={pGain.defaultValue}   label={pGain.label}   units={pGain.units}   curve={pGain.curve}   formatValue={pGain.format}   onchange={set('gain')}           readLive={live('gain')}           moduleId={id} paramId="gain" />
    </div>

    <div class="bank" class:live={bankLive} data-testid="warrensspectrum-bank">
      <div class="bank-head">
        <span class="bank-label">FILTERBANK</span>
        <span class="bank-state" data-testid="warrensspectrum-bank-state">
          {bankLive ? 'IN CIRCUIT' : 'BYPASSED — RAISE BANK WET'}
        </span>
      </div>

      <div class="band-strip">
        {#each bands as b, i (i)}
          <button
            type="button"
            class="band-cell"
            class:selected={i === selectedBand}
            class:muted={b.send <= 0}
            data-testid={`ws-band-${id}-${i}`}
            aria-pressed={i === selectedBand}
            aria-label={`Band ${i + 1}: ${Math.round(b.cutoffHz)} Hz`}
            onclick={() => (selectedBand = i)}
          >
            <span class="band-bar" style={`height:${Math.round(3 + b.send * 14)}px`}></span>
            <span class="band-hz">{b.cutoffHz >= 1000 ? `${(b.cutoffHz / 1000).toFixed(1)}k` : Math.round(b.cutoffHz)}</span>
          </button>
        {/each}
      </div>

      <div class="fader-row">
        {#each BAND_FIELDS as f (f)}
          <NeonFader
            value={sel[f]}
            min={bandSpec[f].min}
            max={bandSpec[f].max}
            defaultValue={bandDefaults[selectedBand][f]}
            label={bandSpec[f].label}
            units={bandSpec[f].units}
            curve={bandSpec[f].curve}
            onchange={bandField(selectedBand, f)}
            moduleId={id}
            paramId={`wsBand${selectedBand}-${f}`}
          />
        {/each}
      </div>

      <div class="fader-row">
        <NeonFader value={wet}   min={pWet.min}   max={pWet.max}   defaultValue={pWet.defaultValue}   label={pWet.label}   units={pWet.units}   curve={pWet.curve}   formatValue={pWet.format}   onchange={set('resynthLevel')} readLive={live('resynthLevel')} moduleId={id} paramId="resynthLevel" />
        <NeonFader value={inMix} min={pInMix.min} max={pInMix.max} defaultValue={pInMix.defaultValue} label={pInMix.label} units={pInMix.units} curve={pInMix.curve} formatValue={pInMix.format} onchange={set('inputMix')}     readLive={live('inputMix')}     moduleId={id} paramId="inputMix" />
      </div>
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
  /* DIM, never hide and never disable — the card-control-ranges.test.ts
     convention. A dimmed control keeps its box (so card height does not
     depend on mode, which would destabilise the VRT baseline), keeps its
     drag/reset/MIDI-learn, and explains itself in a title. */
  .warrensspectrum-card .mode-scoped { display: flex; }
  .warrensspectrum-card .mode-scoped.dim { opacity: 0.45; }
  .warrensspectrum-card .fader-row {
    margin-top: 3px;
    display: flex;
    justify-content: center;
    gap: 8px;
    padding: 0 12px;
  }
  /* The bank is the tallest block on the card, so its chrome is where the
     height budget is won or lost. Everything here is trimmed to the minimum
     that stays legible — the card is 3u (540 CSS px) and the measured
     natural height must leave real slack, not scrape the tier boundary. */
  .warrensspectrum-card .bank {
    margin-top: 4px;
    padding: 3px 12px 0;
    border-top: 1px solid var(--border-subtle, #333);
    opacity: 0.55;
  }
  .warrensspectrum-card .bank.live { opacity: 1; }
  .warrensspectrum-card .bank-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 0.55rem;
    line-height: 1.1;
    letter-spacing: 0.08em;
    color: var(--text-muted, #999);
  }
  .warrensspectrum-card .bank-state { font-size: 0.5rem; }
  .warrensspectrum-card .bank.live .bank-state { color: var(--cable-audio, #d97); }
  .warrensspectrum-card .band-strip {
    display: flex;
    justify-content: space-between;
    gap: 3px;
    margin-top: 2px;
  }
  .warrensspectrum-card .band-cell {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: 1px;
    height: 30px;
    padding: 2px 0 1px;
    background: var(--surface-sunken, #1a1a1a);
    border: 1px solid var(--border-subtle, #333);
    border-radius: 3px;
    cursor: pointer;
  }
  .warrensspectrum-card .band-cell.selected { border-color: var(--cable-audio, #d97); }
  .warrensspectrum-card .band-cell.muted .band-bar { background: var(--border-subtle, #333); }
  .warrensspectrum-card .band-bar {
    width: 60%;
    background: var(--cable-audio, #d97);
    border-radius: 1px;
  }
  .warrensspectrum-card .band-hz {
    font-size: 0.5rem;
    color: var(--text-muted, #999);
    line-height: 1;
  }
</style>
