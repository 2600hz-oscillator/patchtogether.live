<script lang="ts">
  // BladesCard — dual SVF filter + COLOR + mix bus.
  //
  // Layout (left → right):
  //   Filter 1 column: cutoff fader, res fader, mode button
  //   Filter 2 column: cutoff fader, res fader, mode button
  //   Global row:      COLOR fader + MIX-MODE toggle button
  //
  // Mode buttons cycle LP → BP → HP (mode1 / mode2 params, 0..2).
  // MIX-MODE button toggles PARALLEL ↔ SERIAL (mixMode param, 0 or 1).
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import {
    bladesDef,
    BLADES_MODE_NAMES,
    BLADES_MAX_MODE,
    BLADES_MIX_MODE_NAMES,
    type BladesMode,
    type BladesMixMode,
  } from '$lib/audio/modules/blades';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (pid: string): number =>
    bladesDef.params.find((p) => p.id === pid)!.defaultValue;
  const paramSpec = (pid: string) =>
    bladesDef.params.find((p) => p.id === pid)!;

  let cutoff1 = $derived(node?.params.cutoff1 ?? defaultFor('cutoff1'));
  let cutoff2 = $derived(node?.params.cutoff2 ?? defaultFor('cutoff2'));
  let res1    = $derived(node?.params.res1    ?? defaultFor('res1'));
  let res2    = $derived(node?.params.res2    ?? defaultFor('res2'));
  let mode1   = $derived(node?.params.mode1   ?? defaultFor('mode1'));
  let mode2   = $derived(node?.params.mode2   ?? defaultFor('mode2'));
  let color   = $derived(node?.params.color   ?? defaultFor('color'));
  let mixMode = $derived(node?.params.mixMode ?? defaultFor('mixMode'));

  function clampMode(v: number): BladesMode {
    return Math.max(0, Math.min(BLADES_MAX_MODE, Math.round(v))) as BladesMode;
  }
  function clampMixMode(v: number): BladesMixMode {
    return (v >= 0.5 ? 1 : 0) as BladesMixMode;
  }

  let mode1Label = $derived(BLADES_MODE_NAMES[clampMode(mode1)]);
  let mode2Label = $derived(BLADES_MODE_NAMES[clampMode(mode2)]);
  let mixModeLabel = $derived(BLADES_MIX_MODE_NAMES[clampMixMode(mixMode)]);

  const set = (pid: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[pid] = v;
  };
  const live = (pid: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, pid);
  };

  function cycleMode(which: 1 | 2): void {
    const pid = which === 1 ? 'mode1' : 'mode2';
    const cur = clampMode(which === 1 ? mode1 : mode2);
    const next = ((cur + 1) % (BLADES_MAX_MODE + 1)) as BladesMode;
    const t = patch.nodes[id]; if (t) t.params[pid] = next;
  }
  function toggleMixMode(): void {
    const t = patch.nodes[id]; if (!t) return;
    t.params.mixMode = clampMixMode(mixMode) === 1 ? 0 : 1;
  }

  const inputs: PortDescriptor[] = [
    { id: 'in1',         label: 'IN 1',  cable: 'audio' },
    { id: 'in2',         label: 'IN 2',  cable: 'audio' },
    { id: 'voct1',       label: '1V/O 1', cable: 'cv' },
    { id: 'voct2',       label: '1V/O 2', cable: 'cv' },
    { id: 'cutoff1_cv',  label: 'CUT 1', cable: 'cv' },
    { id: 'cutoff2_cv',  label: 'CUT 2', cable: 'cv' },
    { id: 'res1_cv',     label: 'RES 1', cable: 'cv' },
    { id: 'res2_cv',     label: 'RES 2', cable: 'cv' },
    { id: 'color_cv',    label: 'COLOR', cable: 'cv' },
    { id: 'mix_mode_cv', label: 'MIX-M', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out1', label: 'OUT 1', cable: 'audio' },
    { id: 'out2', label: 'OUT 2', cable: 'audio' },
    { id: 'mix',  label: 'MIX',   cable: 'audio' },
  ];
</script>

<div class="mod-card blades-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="BLADES" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={300}>
    <div class="filters">
      <div class="filter-col">
        <Fader value={cutoff1} min={paramSpec('cutoff1').min} max={paramSpec('cutoff1').max}
               defaultValue={defaultFor('cutoff1')} label="Cut 1" curve="log"
               onchange={set('cutoff1')} moduleId={id} paramId="cutoff1" readLive={live('cutoff1')} />
        <Fader value={res1} min={0} max={1}
               defaultValue={defaultFor('res1')} label="Res 1" curve="linear"
               onchange={set('res1')} moduleId={id} paramId="res1" readLive={live('res1')} />
        <button
          type="button"
          class="mode-btn"
          data-testid="blades-mode1"
          onclick={() => cycleMode(1)}
          title="Filter 1 mode (LP / BP / HP)"
        >{mode1Label}</button>
      </div>
      <div class="filter-col">
        <Fader value={cutoff2} min={paramSpec('cutoff2').min} max={paramSpec('cutoff2').max}
               defaultValue={defaultFor('cutoff2')} label="Cut 2" curve="log"
               onchange={set('cutoff2')} moduleId={id} paramId="cutoff2" readLive={live('cutoff2')} />
        <Fader value={res2} min={0} max={1}
               defaultValue={defaultFor('res2')} label="Res 2" curve="linear"
               onchange={set('res2')} moduleId={id} paramId="res2" readLive={live('res2')} />
        <button
          type="button"
          class="mode-btn"
          data-testid="blades-mode2"
          onclick={() => cycleMode(2)}
          title="Filter 2 mode (LP / BP / HP)"
        >{mode2Label}</button>
      </div>
    </div>

    <div class="globals">
      <Fader value={color} min={0} max={1}
             defaultValue={defaultFor('color')} label="COLOR" curve="linear"
             onchange={set('color')} moduleId={id} paramId="color" readLive={live('color')} />
      <button
        type="button"
        class="mix-btn"
        class:serial={clampMixMode(mixMode) === 1}
        data-testid="blades-mix-mode"
        onclick={toggleMixMode}
        title="Mix bus routing: PARALLEL (sum) / SERIAL (filter1 → filter2)"
      >{mixModeLabel}</button>
    </div>
  </PatchPanel>
</div>

<style>
  .blades-card { width: 300px; min-height: 280px; }
  .blades-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  .blades-card .filters {
    display: flex;
    justify-content: space-between;
    padding: 8px 14px 0;
    gap: 12px;
  }
  .blades-card .filter-col {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .blades-card .globals {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 14px 0;
    gap: 12px;
  }
  .blades-card .mode-btn,
  .blades-card .mix-btn {
    font-size: 10px;
    font-family: var(--font-mono, monospace);
    padding: 3px 8px;
    border: 1px solid var(--border-dim, #444);
    border-radius: 3px;
    background: var(--surface-deep, #1a1a1a);
    color: var(--text-dim, #888);
    cursor: pointer;
    letter-spacing: 0.6px;
    line-height: 1;
  }
  .blades-card .mode-btn:hover,
  .blades-card .mix-btn:hover {
    color: var(--text, #ddd);
    border-color: var(--text-dim, #888);
  }
  .blades-card .mix-btn.serial {
    color: var(--cable-audio, #f80);
    border-color: var(--cable-audio, #f80);
  }
</style>
