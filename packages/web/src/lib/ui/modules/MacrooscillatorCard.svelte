<script lang="ts">
  // MacrooscillatorCard — Plaits-style macro oscillator card.
  //
  // Six faders, the engine name, and the STRIKE audition.
  //
  // ⚠ EVERY RANGE IS BOUND TO THE DEF (`paramSpec`), NEVER RE-TYPED. This card
  // used to re-type all six min/max/default/curve/unit sets while already
  // importing the def and even carrying a `defaultFor()` helper. They all
  // agreed — which is exactly how that class hides: contract-lock,
  // module-docs-lint and every range assertion read the DEF, so a card that
  // disagrees with its own def is invisible to the entire gate set (the
  // backdraft ±0.2-vs-±1 lesson). Guarded at source level by
  // card-range-source.test.ts, which this card is now enrolled in.
  //
  // ⚠ THE ENGINE NAMES COME FROM THE ROSTER, not from a local array. There used
  // to be a private `MODEL_NAMES` here and a BYTE-IDENTICAL copy in macseq.ts
  // (whose own comment admitted it was "duplicated from
  // MacrooscillatorCard.svelte's local copy rather than imported"). Both now
  // read `$lib/audio/modules/macro-engine-roster`, which is also what the def
  // hands the platform as `ParamDef.options`.
  //
  // ⚠ THE STRIKE BUTTON SHARES THE ENGINE-NAME ROW, AND THAT IS MEASURED, NOT
  // taste. On its own row it overflowed the card's bottom edge by 30.2 CSS px
  // (card-control-overflow); the card has ~8 px of slack. Sharing the readout
  // row costs zero height because that row is already taller than its text.
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import { macrooscillatorDef } from '$lib/audio/modules/macrooscillator';
  import { macroEngineAt } from '$lib/audio/modules/macro-engine-roster';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';
  import { fireManualStrike } from './manual-strike-actions';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live, paramVal, defaultFor } = cardParams(macrooscillatorDef, () => id, () => node);

  /** Every range, curve, unit and LABEL from the def — one place, never
   *  re-typed here. */
  const P = {
    model:     paramSpec(macrooscillatorDef, 'model'),
    note:      paramSpec(macrooscillatorDef, 'note'),
    harmonics: paramSpec(macrooscillatorDef, 'harmonics'),
    timbre:    paramSpec(macrooscillatorDef, 'timbre'),
    morph:     paramSpec(macrooscillatorDef, 'morph'),
    level:     paramSpec(macrooscillatorDef, 'level'),
  } as const;

  let model     = $derived(paramVal('model'));
  let note      = $derived(paramVal('note'));
  let harmonics = $derived(paramVal('harmonics'));
  let timbre    = $derived(paramVal('timbre'));
  let morph     = $derived(paramVal('morph'));
  let level     = $derived(paramVal('level'));

  let engine = $derived(macroEngineAt(model));

  // Manual STRIKE — the audition. Five of the fourteen engines (FM 6OP,
  // STRING, KICK, SNARE, HIHAT) are SILENT with nothing patched into TRIG, so
  // on a bare rack this is the only way to hear them at all.
  //
  // The flash follows the TRUTH (whether a strike actually fired) rather than
  // the click, so a press before the audio gate boots does not pretend to have
  // struck anything — the karplus precedent, and the reason the shell's action
  // cell carries an `audition` probe rather than a click assertion.
  let strikePulse = $state(false);
  function strike(): void {
    if (!fireManualStrike(id)) return;
    strikePulse = true;
    setTimeout(() => { strikePulse = false; }, 120);
  }

  const inputs = portsFromDef(macrooscillatorDef.inputs);
  const outputs = portsFromDef(macrooscillatorDef.outputs);
</script>

<div class="mod-card macro-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="MACROOSCILLATOR" />
  <div class="model-row">
    <span class="model-readout" data-testid="macro-model-name">{engine.name}</span>
    <!-- The `macro-strike` control family (one member). The testid follows the
         DOCUMENTED member convention `${testidPrefix}-${nodeId}-${i}`
         (graph/types ControlFamily). -->
    <button
      class="strike"
      class:pulse={strikePulse}
      onclick={strike}
      data-testid={`macro-strike-${id}-1`}
      title="Audition: strike the engine once (same as a TRIG rising edge). FM 6OP, STRING, KICK, SNARE and HIHAT are silent until something strikes them."
    >⟋ STRIKE</button>
  </div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <NeonFader value={model}     min={P.model.min}     max={P.model.max}     defaultValue={defaultFor('model')}     label={P.model.label}     curve={P.model.curve}     units={P.model.units}     onchange={set('model')}     moduleId={id} paramId="model"     readLive={live('model')} />
      <NeonFader value={note}      min={P.note.min}      max={P.note.max}      defaultValue={defaultFor('note')}      label={P.note.label}      curve={P.note.curve}      units={P.note.units}      onchange={set('note')}      moduleId={id} paramId="note"      readLive={live('note')} />
      <NeonFader value={harmonics} min={P.harmonics.min} max={P.harmonics.max} defaultValue={defaultFor('harmonics')} label={P.harmonics.label} curve={P.harmonics.curve} units={P.harmonics.units} onchange={set('harmonics')} moduleId={id} paramId="harmonics" readLive={live('harmonics')} />
      <NeonFader value={timbre}    min={P.timbre.min}    max={P.timbre.max}    defaultValue={defaultFor('timbre')}    label={P.timbre.label}    curve={P.timbre.curve}    units={P.timbre.units}    onchange={set('timbre')}    moduleId={id} paramId="timbre"    readLive={live('timbre')} />
      <NeonFader value={morph}     min={P.morph.min}     max={P.morph.max}     defaultValue={defaultFor('morph')}     label={P.morph.label}     curve={P.morph.curve}     units={P.morph.units}     onchange={set('morph')}     moduleId={id} paramId="morph"     readLive={live('morph')} />
      <NeonFader value={level}     min={P.level.min}     max={P.level.max}     defaultValue={defaultFor('level')}     label={P.level.label}     curve={P.level.curve}     units={P.level.units}     onchange={set('level')}     moduleId={id} paramId="level"     readLive={live('level')} />
    </div>
  </PatchPanel>
  <OssAttribution author={macrooscillatorDef.ossAttribution?.author} />
</div>

<style>
  .macro-card { width: 320px; }
  /* Engine name + the STRIKE audition on ONE row. Measured: a strike button on
     its own row overflows this card's bottom edge by 30.2 CSS px against ~8 px
     of slack, so it shares the row that was already here. */
  .macro-card .model-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: -2px;
    margin-bottom: 2px;
  }
  .macro-card .model-readout {
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    color: var(--text-muted, #999);
  }
  .macro-card .strike {
    appearance: none;
    background: rgb(255 255 255 / 0.06);
    border: 1px solid rgb(255 255 255 / 0.14);
    border-radius: 3px;
    color: var(--text-muted, #999);
    font: inherit;
    font-size: 0.6rem;
    letter-spacing: 0.06em;
    padding: 1px 6px;
    cursor: pointer;
  }
  .macro-card .strike:hover { background: rgb(255 255 255 / 0.12); }
  .macro-card .strike:active,
  .macro-card .strike.pulse {
    background: var(--cable-audio, #4dd6c1);
    color: #06110f;
  }
  .macro-card .fader-row {
    margin-top: 10px;
    display: flex;
    justify-content: center;
    gap: 10px;
    padding: 0 16px;
  }
</style>
