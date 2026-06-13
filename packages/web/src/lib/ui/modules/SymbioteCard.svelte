<script lang="ts">
  // SymbioteCard — Marbles core + Grids drums (T) + TB-3PO acid (X).
  // Always-on Symbiote mode: sub-mode + all TB-3PO controls are normal knobs.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { symbioteDef, SYMBIOTE_SUB_MODE_NAMES, SYMBIOTE_SCALE_NAMES } from '$lib/audio/modules/symbiote';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (k: string): number =>
    symbioteDef.params.find((p) => p.id === k)!.defaultValue;
  const paramVal = (k: string): number => node?.params?.[k] ?? defaultFor(k);

  let subMode = $derived(paramVal('sub_mode'));
  let scale = $derived(paramVal('scale'));
  let seedLock = $derived(paramVal('seed_lock'));

  const MAX_SCALE = SYMBIOTE_SCALE_NAMES.length - 1;
  const clampI = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  let euclidean = $derived(subMode >= 0.5);
  let subModeLabel = $derived(SYMBIOTE_SUB_MODE_NAMES[euclidean ? 1 : 0]);
  let scaleLabel = $derived(SYMBIOTE_SCALE_NAMES[clampI(scale, MAX_SCALE)]);
  let seedLockOn = $derived(seedLock >= 0.5);

  const set = (k: string) => (v: number) => setNodeParam(id, k, v);
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };
  function toggleSubMode(): void {
    const t = patch.nodes[id]; if (t) t.params.sub_mode = euclidean ? 0 : 1;
  }
  function cycleScale(): void {
    const t = patch.nodes[id]; if (t) t.params.scale = (clampI(scale, MAX_SCALE) + 1) % (MAX_SCALE + 1);
  }
  function toggleSeed(): void {
    const t = patch.nodes[id]; if (t) t.params.seed_lock = seedLockOn ? 0 : 1;
  }

  const inputs: PortDescriptor[] = [
    { id: 'rate_cv', cable: 'cv' },
    { id: 'submode_cv', cable: 'cv' },
    { id: 'bd_cv', cable: 'cv' },
    { id: 'sd_cv', cable: 'cv' },
    { id: 'hh_cv', cable: 'cv' },
    { id: 'chaos_cv', cable: 'cv' },
    { id: 'aciddensity_cv', cable: 'cv' },
    { id: 'transpose_cv', cable: 'cv' },
    { id: 'acidlength_cv', cable: 'cv' },
    { id: 'scale_cv', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 't1', cable: 'gate' },
    { id: 't2', cable: 'gate' },
    { id: 't3', cable: 'gate' },
    { id: 'x1', cable: 'gate' },
    { id: 'x2', cable: 'cv' },
    { id: 'x3', cable: 'gate' },
    { id: 'y', cable: 'gate' },
  ];
</script>

<div class="mod-card symbiote-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="SYMBIOTE" />
  <div class="btn-row">
    <button type="button" class="sel-btn" data-testid="symbiote-submode-btn" onclick={toggleSubMode}>
      <span class="sel-label">T</span>
      <span class="sel-value" data-testid="symbiote-submode-name">{subModeLabel}</span>
    </button>
    <button type="button" class="sel-btn" data-testid="symbiote-scale-btn" onclick={cycleScale}>
      <span class="sel-label">Scale</span>
      <span class="sel-value" data-testid="symbiote-scale-name">{scaleLabel}</span>
    </button>
    <button type="button" class="sel-btn" class:on={seedLockOn} data-testid="symbiote-seed-btn" onclick={toggleSeed}>
      <span class="sel-label">Seed</span>
      <span class="sel-value">{seedLockOn ? 'LOCK' : 'FREE'}</span>
    </button>
  </div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={paramVal('rate')}        min={-60} max={60} defaultValue={0}   label="Rate"   units="st" curve="linear" onchange={set('rate')}        moduleId={id} paramId="rate"        readLive={live('rate')} />
      <Fader value={paramVal('bd_density')}  min={0}   max={1}  defaultValue={0.5} label="BD"     curve="linear" onchange={set('bd_density')}  moduleId={id} paramId="bd_density"  readLive={live('bd_density')} />
      <Fader value={paramVal('sd_density')}  min={0}   max={1}  defaultValue={0.5} label="SD"     curve="linear" onchange={set('sd_density')}  moduleId={id} paramId="sd_density"  readLive={live('sd_density')} />
      <Fader value={paramVal('hh_density')}  min={0}   max={1}  defaultValue={0.5} label="HH"     curve="linear" onchange={set('hh_density')}  moduleId={id} paramId="hh_density"  readLive={live('hh_density')} />
      {#if euclidean}
        <Fader value={paramVal('euclid_length')} min={1} max={16} defaultValue={16} label="E.Len" curve="linear" onchange={set('euclid_length')} moduleId={id} paramId="euclid_length" readLive={live('euclid_length')} />
      {:else}
        <Fader value={paramVal('map_x')}     min={0} max={1} defaultValue={0.5} label="Map X" curve="linear" onchange={set('map_x')} moduleId={id} paramId="map_x" readLive={live('map_x')} />
        <Fader value={paramVal('map_y')}     min={0} max={1} defaultValue={0.5} label="Map Y" curve="linear" onchange={set('map_y')} moduleId={id} paramId="map_y" readLive={live('map_y')} />
      {/if}
      <Fader value={paramVal('chaos')}       min={-1}  max={1}  defaultValue={0}   label="Chaos"  curve="linear" onchange={set('chaos')}       moduleId={id} paramId="chaos"       readLive={live('chaos')} />
      <Fader value={paramVal('acid_density')} min={0}  max={1}  defaultValue={0.5} label="Acid"   curve="linear" onchange={set('acid_density')} moduleId={id} paramId="acid_density" readLive={live('acid_density')} />
      <Fader value={paramVal('transpose')}   min={-18} max={18} defaultValue={0}   label="Transp" units="st" curve="linear" onchange={set('transpose')}   moduleId={id} paramId="transpose"   readLive={live('transpose')} />
      <Fader value={paramVal('acid_length')} min={1}   max={32} defaultValue={16}  label="A.Len"  curve="linear" onchange={set('acid_length')} moduleId={id} paramId="acid_length" readLive={live('acid_length')} />
    </div>
  </PatchPanel>
  <OssAttribution author={symbioteDef.ossAttribution?.author} />
</div>

<style>
  .symbiote-card { width: 440px; }
  .symbiote-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  /* Rack-compaction (#759): tighter btn-row margin to fit 1u. */
  .symbiote-card .btn-row { display: flex; gap: 8px; margin: 1px 12px 2px; }
  .symbiote-card .sel-btn {
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
  .symbiote-card .sel-btn:hover { background: var(--bg-hover, #2a2a2a); }
  .symbiote-card .sel-btn.on { border-color: var(--cable-gate, #d0a020); }
  .symbiote-card .sel-label { color: var(--text-muted, #999); }
  .symbiote-card .sel-value { color: var(--text, #eee); font-weight: 600; }
  .symbiote-card .fader-row {
    /* Rack-compaction (#759): tighter top margin to fit 1u. */
    margin-top: 3px;
    display: flex;
    justify-content: center;
    gap: 6px;
    padding: 0 12px;
    flex-wrap: wrap;
  }
</style>
