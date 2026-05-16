<script lang="ts">
  // MacrooscillatorCard — Plaits-style macro oscillator card.
  //
  // Six faders + one mode label (the model knob is discrete 0..1 — when more
  // models land in follow-up PRs, swap in the cycler-strip pattern that
  // Dx7Card uses for the 32-algorithm select).
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { macrooscillatorDef } from '$lib/audio/modules/macrooscillator';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (id: string): number =>
    macrooscillatorDef.params.find((p) => p.id === id)!.defaultValue;

  let model     = $derived(node?.params.model     ?? defaultFor('model'));
  let note      = $derived(node?.params.note      ?? defaultFor('note'));
  let harmonics = $derived(node?.params.harmonics ?? defaultFor('harmonics'));
  let timbre    = $derived(node?.params.timbre    ?? defaultFor('timbre'));
  let morph     = $derived(node?.params.morph     ?? defaultFor('morph'));
  let level     = $derived(node?.params.level     ?? defaultFor('level'));

  const MODEL_NAMES = ['VA', 'WAVESHAPE', 'FM 2OP', 'FM 6OP', 'CHORD', 'ADDITIVE'];
  const MAX_MODEL = MODEL_NAMES.length - 1;
  let modelLabel = $derived(MODEL_NAMES[Math.max(0, Math.min(MODEL_NAMES.length - 1, Math.round(model)))]);

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  const inputs: PortDescriptor[] = [
    { id: 'pitch',    cable: 'pitch' },
    { id: 'trig',     cable: 'gate' },
    { id: 'model_cv', cable: 'cv' },
    { id: 'note_cv',  cable: 'cv' },
    { id: 'harm_cv',  cable: 'cv' },
    { id: 'timb_cv',  cable: 'cv' },
    { id: 'morph_cv', cable: 'cv' },
    { id: 'level_cv', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', cable: 'audio' },
    { id: 'aux', cable: 'audio' },
  ];
</script>

<div class="mod-card macro-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">MACROOSCILLATOR</header>
  <div class="model-readout" data-testid="macro-model-name">{modelLabel}</div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={model}     min={0}   max={MAX_MODEL}  defaultValue={0}   label="Model"     curve="discrete" onchange={set('model')}     readLive={live('model')} />
      <Fader value={note}      min={-60} max={60} defaultValue={0}   label="Note"      units="st" curve="linear" onchange={set('note')}      readLive={live('note')} />
      <Fader value={harmonics} min={0}   max={1}  defaultValue={0.3} label="Harmonics" curve="linear" onchange={set('harmonics')} readLive={live('harmonics')} />
      <Fader value={timbre}    min={0}   max={1}  defaultValue={0.3} label="Timbre"    curve="linear" onchange={set('timbre')}    readLive={live('timbre')} />
      <Fader value={morph}     min={0}   max={1}  defaultValue={0.5} label="Morph"     curve="linear" onchange={set('morph')}     readLive={live('morph')} />
      <Fader value={level}     min={0}   max={1}  defaultValue={0.8} label="Level"     curve="linear" onchange={set('level')}     readLive={live('level')} />
    </div>
  </PatchPanel>
</div>

<style>
  .macro-card { width: 320px; min-height: 240px; }
  .macro-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  /* Tiny readout strip under the title — gives the player visual confirmation
     of which model is selected when MODEL is at an integer; otherwise the
     discrete fader's snap-to-step is the only feedback. */
  .macro-card .model-readout {
    text-align: center;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    color: var(--text-muted, #999);
    margin-top: -2px;
    margin-bottom: 2px;
  }
  .macro-card .fader-row {
    margin-top: 10px;
    display: flex;
    justify-content: center;
    gap: 10px;
    padding: 0 16px;
  }
</style>
