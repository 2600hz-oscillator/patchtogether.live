<script lang="ts">
  // MarblesCard — random sampler / clock generator (Mutable Instruments
  // Marbles port). T-section gate models + X-section quantized-CV faders.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import { patch } from '$lib/graph/store';
  import { marblesDef, MARBLES_T_MODEL_NAMES, MARBLES_SCALE_NAMES } from '$lib/audio/modules/marbles';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(marblesDef, () => id, () => node);

  const defaultFor = (k: string): number =>
    marblesDef.params.find((p) => p.id === k)!.defaultValue;
  const paramVal = (k: string): number => node?.params?.[k] ?? defaultFor(k);

  let tModel = $derived(paramVal('t_model'));
  let scale = $derived(paramVal('scale'));

  const MAX_T = MARBLES_T_MODEL_NAMES.length - 1;
  const MAX_SCALE = MARBLES_SCALE_NAMES.length - 1;
  const clampI = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  let tModelLabel = $derived(MARBLES_T_MODEL_NAMES[clampI(tModel, MAX_T)]);
  let scaleLabel = $derived(MARBLES_SCALE_NAMES[clampI(scale, MAX_SCALE)]);

  function cycleTModel(): void {
    const t = patch.nodes[id]; if (t) t.params.t_model = (clampI(tModel, MAX_T) + 1) % (MAX_T + 1);
  }
  function cycleScale(): void {
    const t = patch.nodes[id]; if (t) t.params.scale = (clampI(scale, MAX_SCALE) + 1) % (MAX_SCALE + 1);
  }

  const inputs = portsFromDef(marblesDef.inputs);
  const outputs = portsFromDef(marblesDef.outputs);
</script>

<div class="mod-card marbles-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="MARBLES" />
  <div class="btn-row">
    <button type="button" class="sel-btn" data-testid="marbles-tmodel-btn" onclick={cycleTModel}>
      <span class="sel-label">T</span>
      <span class="sel-value" data-testid="marbles-tmodel-name">{tModelLabel}</span>
    </button>
    <button type="button" class="sel-btn" data-testid="marbles-scale-btn" onclick={cycleScale}>
      <span class="sel-label">Scale</span>
      <span class="sel-value" data-testid="marbles-scale-name">{scaleLabel}</span>
    </button>
  </div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={paramVal('rate')}     min={-60} max={60} defaultValue={0}   label="Rate"    units="st" curve="linear" onchange={set('rate')}     moduleId={id} paramId="rate"     readLive={live('rate')} />
      <Fader value={paramVal('t_bias')}   min={0}   max={1}  defaultValue={0.5} label="T Bias"   curve="linear" onchange={set('t_bias')}   moduleId={id} paramId="t_bias"   readLive={live('t_bias')} />
      <Fader value={paramVal('t_jitter')} min={0}   max={1}  defaultValue={0}   label="Jitter"   curve="linear" onchange={set('t_jitter')} moduleId={id} paramId="t_jitter" readLive={live('t_jitter')} />
      <Fader value={paramVal('deja_vu')}  min={0}   max={1}  defaultValue={0}   label="Déjà Vu"  curve="linear" onchange={set('deja_vu')}  moduleId={id} paramId="deja_vu"  readLive={live('deja_vu')} />
      <Fader value={paramVal('length')}   min={1}   max={16} defaultValue={8}   label="Length"   curve="linear" onchange={set('length')}   moduleId={id} paramId="length"   readLive={live('length')} />
      <Fader value={paramVal('spread')}   min={0}   max={1}  defaultValue={0.5} label="Spread"   curve="linear" onchange={set('spread')}   moduleId={id} paramId="spread"   readLive={live('spread')} />
      <Fader value={paramVal('x_bias')}   min={0}   max={1}  defaultValue={0.5} label="X Bias"   curve="linear" onchange={set('x_bias')}   moduleId={id} paramId="x_bias"   readLive={live('x_bias')} />
      <Fader value={paramVal('steps')}    min={0}   max={1}  defaultValue={0.5} label="Steps"    curve="linear" onchange={set('steps')}    moduleId={id} paramId="steps"    readLive={live('steps')} />
      <Fader value={paramVal('x_length')} min={1}   max={16} defaultValue={8}   label="X Len"    curve="linear" onchange={set('x_length')} moduleId={id} paramId="x_length" readLive={live('x_length')} />
    </div>
  </PatchPanel>
  <OssAttribution author={marblesDef.ossAttribution?.author} />
</div>

<style>
  .marbles-card { width: 420px; }  /* Rack-compaction (#759): tighter btn-row margin to fit 1u. */
  .marbles-card .btn-row { display: flex; gap: 8px; margin: 1px 12px 2px; }
  .marbles-card .sel-btn {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    flex: 1;
    border: 1px solid var(--border, #555);
    background: var(--bg-elevated, #1a1a1a);
    color: var(--text, #eee);
    padding: 3px 10px;
    font-family: var(--font-display, monospace);
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .marbles-card .sel-btn:hover { background: var(--bg-hover, #2a2a2a); }
  .marbles-card .sel-label { color: var(--text-muted, #999); }
  .marbles-card .sel-value { color: var(--text, #eee); font-weight: 600; }
  .marbles-card .fader-row {
    /* Rack-compaction (#759): tighter top margin to fit 1u. */
    margin-top: 3px;
    display: flex;
    justify-content: center;
    gap: 6px;
    padding: 0 12px;
    flex-wrap: wrap;
  }
</style>
