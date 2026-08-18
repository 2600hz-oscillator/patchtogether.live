<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { filterDef } from '$lib/audio/modules/filter';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(filterDef, () => id, () => node);

  // ⚠ EVERY NUMBER, CURVE, UNIT, LABEL AND VOCABULARY BELOW COMES FROM THE DEF.
  // Until 2026-08-09 this card re-typed nine of them: cutoff's bounds, default,
  // unit string and log taper were hand-written beside the fader, resonance's
  // four the same way, and a private mode array restated the three state names
  // the def already declares in its `options` roster. All of them AGREED, which
  // is exactly how this class hides — no def-reading gate (contract-lock,
  // module-docs-lint, every range assertion) can see a card, so a divergence
  // only becomes visible the first time somebody edits one side. Positional
  // indexing into `params` was the same hazard one step worse: a reorder would
  // have silently rebound both defaults.
  //
  // (This comment names no literal prop syntax on purpose — `card-range-source`
  // greps the whole file, so quoting the old code here would red the gate that
  // certifies the fix.)
  const pCutoff = paramSpec(filterDef, 'cutoff');
  const pRes = paramSpec(filterDef, 'resonance');
  const pMode = paramSpec(filterDef, 'mode');

  let cutoff    = $derived(node?.params.cutoff    ?? pCutoff.defaultValue);
  let resonance = $derived(node?.params.resonance ?? pRes.defaultValue);
  let mode      = $derived(node?.params.mode      ?? pMode.defaultValue);

  /** The mode vocabulary, from the def's `options` roster — the SAME strings
   *  the dock's Segmented paints, so the two surfaces cannot name three states
   *  differently. */
  const MODES = (pMode.options ?? []).map((o) => o.label);
  // ⚠ Routed through the SAME `setNodeParam` seam as cutoff/resonance. Until
  // 2026-08-02 this was a bare `t.params.mode = m`, so MODE — the control that
  // decides whether CUTOFF sounds dark, thin or narrow — was the one param on
  // this card that was NOT undoable and did NOT ride the LOCAL_ORIGIN tag.
  // `mutate.guard`'s RAW_PARAM_WRITE was bracket-only and could not see it.
  const selectMode = (m: number) => set('mode')(m);

  const inputs = portsFromDef(filterDef.inputs);
  const outputs = portsFromDef(filterDef.outputs, { audio: 'OUT' });
</script>

<div class="mod-card filter-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="Filter" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <NeonFader value={cutoff}    min={pCutoff.min} max={pCutoff.max} defaultValue={pCutoff.defaultValue} label={pCutoff.label} units={pCutoff.units} curve={pCutoff.curve} formatValue={pCutoff.format} onchange={set('cutoff')}    moduleId={id} paramId="cutoff"    readLive={live('cutoff')} />
      <NeonFader value={resonance} min={pRes.min}    max={pRes.max}    defaultValue={pRes.defaultValue}    label={pRes.label}    units={pRes.units}    curve={pRes.curve}    formatValue={pRes.format}    onchange={set('resonance')} moduleId={id} paramId="resonance" readLive={live('resonance')} />
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
