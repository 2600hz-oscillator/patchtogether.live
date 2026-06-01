<script lang="ts">
  // RingsCard — modal / sympathetic-string resonator card.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { ringsDef, RINGS_MODEL_NAMES } from '$lib/audio/modules/rings';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (id: string): number =>
    ringsDef.params.find((p) => p.id === id)!.defaultValue;

  let model      = $derived(node?.params.model      ?? defaultFor('model'));
  let note       = $derived(node?.params.note       ?? defaultFor('note'));
  let structure  = $derived(node?.params.structure  ?? defaultFor('structure'));
  let brightness = $derived(node?.params.brightness ?? defaultFor('brightness'));
  let damping    = $derived(node?.params.damping    ?? defaultFor('damping'));
  let position   = $derived(node?.params.position   ?? defaultFor('position'));
  let level      = $derived(node?.params.level      ?? defaultFor('level'));

  const MAX_MODEL = RINGS_MODEL_NAMES.length - 1;
  function clampModel(v: number): number {
    return Math.max(0, Math.min(MAX_MODEL, Math.round(v)));
  }
  let modelLabel = $derived(RINGS_MODEL_NAMES[clampModel(model)]);

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  function cycleModel(): void {
    const cur = clampModel(model);
    const next = (cur + 1) % (MAX_MODEL + 1);
    const t = patch.nodes[id];
    if (t) t.params.model = next;
  }

  const inputs: PortDescriptor[] = [
    { id: 'in',        cable: 'audio' },
    { id: 'pitch',     cable: 'pitch' },
    { id: 'strum',     cable: 'gate' },
    { id: 'model_cv',  cable: 'cv' },
    { id: 'note_cv',   cable: 'cv' },
    { id: 'str_cv',    cable: 'cv' },
    { id: 'bright_cv', cable: 'cv' },
    { id: 'damp_cv',   cable: 'cv' },
    { id: 'pos_cv',    cable: 'cv' },
    { id: 'level_cv',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'odd',  cable: 'audio' },
    { id: 'even', cable: 'audio' },
  ];
</script>

<div class="mod-card rings-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="RINGS" />
  <button
    type="button"
    class="model-btn"
    data-testid="rings-model-btn"
    onclick={cycleModel}
  >
    <span class="model-btn-label">Model</span>
    <span class="model-btn-value" data-testid="rings-model-name">{modelLabel}</span>
  </button>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={note}       min={-60} max={60}        defaultValue={0}    label="Note"       units="st" curve="linear" onchange={set('note')} moduleId={id} paramId="note"       readLive={live('note')} />
      <Fader value={structure}  min={0}   max={1}         defaultValue={0.25} label="Structure"  curve="linear" onchange={set('structure')} moduleId={id} paramId="structure"  readLive={live('structure')} />
      <Fader value={brightness} min={0}   max={1}         defaultValue={0.5}  label="Brightness" curve="linear" onchange={set('brightness')} moduleId={id} paramId="brightness" readLive={live('brightness')} />
      <Fader value={damping}    min={0}   max={1}         defaultValue={0.5}  label="Damping"    curve="linear" onchange={set('damping')} moduleId={id} paramId="damping"    readLive={live('damping')} />
      <Fader value={position}   min={0}   max={1}         defaultValue={0.5}  label="Position"   curve="linear" onchange={set('position')} moduleId={id} paramId="position"   readLive={live('position')} />
      <Fader value={level}      min={0}   max={1}         defaultValue={0.8}  label="Level"      curve="linear" onchange={set('level')} moduleId={id} paramId="level"      readLive={live('level')} />
    </div>
  </PatchPanel>
  <OssAttribution author={ringsDef.ossAttribution?.author} />
</div>

<style>
  .rings-card { width: 360px; }
  .rings-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  .rings-card .model-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: calc(100% - 24px);
    margin: 2px 12px 4px;
    border: 1px solid var(--border, #555);
    background: var(--bg-elevated, #1a1a1a);
    color: var(--text, #eee);
    padding: 4px 10px;
    font-family: var(--font-display, monospace);
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .rings-card .model-btn:hover {
    background: var(--bg-hover, #2a2a2a);
  }
  .rings-card .model-btn-label {
    color: var(--text-muted, #999);
  }
  .rings-card .model-btn-value {
    color: var(--text, #eee);
    font-weight: 600;
  }
  .rings-card .fader-row {
    margin-top: 10px;
    display: flex;
    justify-content: center;
    gap: 8px;
    padding: 0 12px;
  }
</style>
