<script lang="ts">
  // CallsineCard — spectral-analysis additive resynthesizer.
  //
  // CallSine takes audio in, analyzes it with an FFT, tracks the loudest
  // sinusoidal partials, and resynthesizes them with up to N_TRACKS
  // oscillators. Macros:
  //   harmonics → partial count
  //   timbre    → analyzer slew (smear)
  //   morph     → harmonic LOCK strength (F0 snap)
  //   level     → output gain
  //   note      → ±60 semitone transpose of the resynth output
  //
  // The gate input toggles a FREEZE latch (rising edge flips state).
  //
  // Card pattern matches MACROOSCILLATOR / WARPS: discrete model select +
  // 5 continuous faders, model-name readout strip under the title, OSS
  // attribution at the bottom.

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { callsineDef, CALLSINE_MODEL_NAMES, CALLSINE_MAX_MODEL } from '$lib/audio/modules/callsine';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (id: string): number =>
    callsineDef.params.find((p) => p.id === id)!.defaultValue;

  let model     = $derived(node?.params.model     ?? defaultFor('model'));
  let note      = $derived(node?.params.note      ?? defaultFor('note'));
  let harmonics = $derived(node?.params.harmonics ?? defaultFor('harmonics'));
  let timbre    = $derived(node?.params.timbre    ?? defaultFor('timbre'));
  let morph     = $derived(node?.params.morph     ?? defaultFor('morph'));
  let level     = $derived(node?.params.level     ?? defaultFor('level'));

  let modelLabel = $derived(
    CALLSINE_MODEL_NAMES[
      Math.max(0, Math.min(CALLSINE_MODEL_NAMES.length - 1, Math.round(model)))
    ],
  );

  const set = (k: string) => (v: number) => setNodeParam(id, k, v);
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  const inputs: PortDescriptor[] = [
    { id: 'audio_in', cable: 'audio' },
    { id: 'pitch',    cable: 'pitch' },
    { id: 'gate',     cable: 'gate' },
    { id: 'model_cv', cable: 'cv' },
    { id: 'note_cv',  cable: 'cv' },
    { id: 'harm_cv',  cable: 'cv' },
    { id: 'timb_cv',  cable: 'cv' },
    { id: 'morph_cv', cable: 'cv' },
    { id: 'level_cv', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', cable: 'audio' },
  ];
</script>

<div class="mod-card callsine-card" data-testid="callsine-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="CALLSINE" />
  <div class="model-readout" data-testid="callsine-model-name">{modelLabel}</div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={model}     min={0}   max={CALLSINE_MAX_MODEL} defaultValue={0}   label="Model"     curve="discrete" formatValue={(v) => CALLSINE_MODEL_NAMES[Math.max(0, Math.min(CALLSINE_MODEL_NAMES.length - 1, Math.round(v)))] ?? ''} onchange={set('model')}     moduleId={id} paramId="model"     readLive={live('model')} />
      <Fader value={note}      min={-60} max={60} defaultValue={0}   label="Note"      units="st" curve="linear" onchange={set('note')}      moduleId={id} paramId="note"      readLive={live('note')} />
      <Fader value={harmonics} min={0}   max={1}  defaultValue={0.6} label="Harmonics" curve="linear" onchange={set('harmonics')} moduleId={id} paramId="harmonics" readLive={live('harmonics')} />
      <Fader value={timbre}    min={0}   max={1}  defaultValue={0.4} label="Timbre"    curve="linear" onchange={set('timbre')}    moduleId={id} paramId="timbre"    readLive={live('timbre')} />
      <Fader value={morph}     min={0}   max={1}  defaultValue={0.0} label="Morph"     curve="linear" onchange={set('morph')}     moduleId={id} paramId="morph"     readLive={live('morph')} />
      <Fader value={level}     min={0}   max={1}  defaultValue={0.8} label="Level"     curve="linear" onchange={set('level')}     moduleId={id} paramId="level"     readLive={live('level')} />
    </div>
  </PatchPanel>
  <OssAttribution author={callsineDef.ossAttribution?.author} />
</div>

<style>
  .callsine-card { width: 340px; }
  .callsine-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  .callsine-card .model-readout {
    text-align: center;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    color: var(--text-muted, #999);
    margin-top: -3px;
    margin-bottom: 0;
  }
  .callsine-card .fader-row {
    /* Rack-compaction (#759): tighter top margin to fit 1u. */
    margin-top: 3px;
    display: flex;
    justify-content: center;
    gap: 10px;
    padding: 0 16px;
  }
</style>
