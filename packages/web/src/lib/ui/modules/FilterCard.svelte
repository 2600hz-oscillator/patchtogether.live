<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { patch } from '$lib/graph/store';
  import { filterDef } from '$lib/audio/modules/filter';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(filterDef, () => id, () => node);

  let cutoff    = $derived(node?.params.cutoff    ?? filterDef.params[0]!.defaultValue);
  let resonance = $derived(node?.params.resonance ?? filterDef.params[1]!.defaultValue);
  let mode      = $derived(node?.params.mode      ?? 0);


  const MODES = ['LP', 'HP', 'BP'] as const;
  function selectMode(m: number) {
    const t = patch.nodes[id]; if (t) t.params.mode = m;
  }

  const inputs = portsFromDef(filterDef.inputs);
  const outputs = portsFromDef(filterDef.outputs, { audio: 'OUT' });
</script>

<div class="mod-card filter-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="Filter" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={cutoff}    min={20}  max={20000} defaultValue={1000} label="Cutoff" units="Hz" curve="log"    onchange={set('cutoff')} moduleId={id} paramId="cutoff"    readLive={live('cutoff')} />
      <Fader value={resonance} min={0}   max={0.99}  defaultValue={0.1}  label="Res"               curve="linear" onchange={set('resonance')} moduleId={id} paramId="resonance" readLive={live('resonance')} />
    </div>

    <div class="mode-row">
      {#each MODES as label, i (label)}
        <button class:active={mode === i} onclick={() => selectMode(i)}>{label}</button>
      {/each}
    </div>
  </PatchPanel>
</div>

<style>
  .filter-card { width: 200px; }
  .filter-card .fader-row { margin-top: 14px; padding: 0 24px; }
  .mode-row {
    display: flex;
    gap: 4px;
    justify-content: center;
    margin-top: 10px;
  }
  .mode-row button {
    background: #2a2f3a;
    color: var(--text-dim);
    border: 1px solid #404652;
    padding: 3px 10px;
    font-size: 0.7rem;
    border-radius: 3px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .mode-row button.active {
    background: var(--cable-audio);
    color: #1a1d23;
    border-color: var(--cable-audio);
  }
</style>
