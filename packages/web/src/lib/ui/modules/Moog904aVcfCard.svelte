<script lang="ts">
  // MOOG 904A VCF card — slice 2 of the Moog System 55/35 clone. Laid out
  // to echo the original 904A faceplate (Fig 11): a large FIXED CONTROL
  // VOLTAGE (cutoff) knob, a RANGE switch (1/2/3 — 2-octave steps), a
  // REGENERATION knob (variable Q / self-osc), the summing CONTROL INPUT
  // jacks (cutoff_cv + reso_cv) on the left, a SIGNAL INPUT jack, and the
  // OUTPUT jack.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock Knob / PatchPanel controls inherit the Moog-era look — same
  // pattern as Moog921VcoCard.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { moog904aDef } from '$lib/audio/modules/moog904a';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog904aDef.params.find((p) => p.id === pid)!;
  }

  let cutoff       = $derived(node?.params.cutoff       ?? def('cutoff').defaultValue);
  let range        = $derived(node?.params.range        ?? def('range').defaultValue);
  let regeneration = $derived(node?.params.regeneration ?? def('regeneration').defaultValue);

  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  function readLive(paramId: string) {
    return () => {
      const eng = engineCtx.get();
      if (!eng || !node) return undefined;
      return eng.readParam(node, paramId);
    };
  }

  // RANGE is a 3-position switch (1 / 2 / 3) → cutoff shifted in 2-oct steps.
  const RANGE_POS: Array<{ v: number; label: string }> = [
    { v: 1, label: '1' },
    { v: 2, label: '2' },
    { v: 3, label: '3' },
  ];
  function setRange(v: number) {
    const target = patch.nodes[id];
    if (target) target.params.range = v;
  }

  // CONTROL INPUTS (summing, left) + SIGNAL INPUT; single OUTPUT.
  const inputs: PortDescriptor[] = [
    { id: 'audio',     label: 'SIGNAL', cable: 'audio' },
    { id: 'cutoff_cv', label: 'FREQ',   cable: 'cv' },
    { id: 'reso_cv',   label: 'REGEN',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [{ id: 'audio', cable: 'audio' }];
</script>

<MoogPanel {id} {data} defaultLabel="904A VCF" width={236}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- FIXED CONTROL VOLTAGE (cutoff) + REGENERATION. -->
    <div class="knob-row" data-testid="moog904a-knob-row">
      <Knob value={cutoff} min={20} max={20000} defaultValue={1000} label="Cutoff" units="Hz" curve="log" onchange={setParam('cutoff')} moduleId={id} paramId="cutoff" readLive={readLive('cutoff')} />
      <Knob value={regeneration} min={0} max={1} defaultValue={0} label="Regen" curve="linear" onchange={setParam('regeneration')} moduleId={id} paramId="regeneration" readLive={readLive('regeneration')} />
    </div>

    <!-- RANGE switch (1 / 2 / 3 — 2-octave steps). -->
    <div class="range-row" data-testid="moog904a-range-switch">
      <span class="range-label">RANGE</span>
      <div class="range-seg" role="radiogroup" aria-label="Range">
        {#each RANGE_POS as pos (pos.v)}
          <button
            type="button"
            class="range-btn"
            class:active={range === pos.v}
            role="radio"
            aria-checked={range === pos.v}
            data-range-value={pos.v}
            onclick={() => setRange(pos.v)}
          >{pos.label}</button>
        {/each}
      </div>
    </div>
  </PatchPanel>
</MoogPanel>

<style>
  .knob-row {
    display: flex;
    gap: 18px;
    padding: 8px 18px 4px;
    justify-content: center;
  }
  .range-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 18px 2px;
    justify-content: center;
  }
  .range-label {
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }
  .range-seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
  }
  .range-btn {
    appearance: none;
    border: none;
    background: var(--module-bg-deep);
    color: var(--text-dim);
    font: inherit;
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 3px 11px;
    cursor: pointer;
    border-right: 1px solid var(--border);
    transition: background 80ms ease-out, color 80ms ease-out;
  }
  .range-btn:last-child {
    border-right: none;
  }
  .range-btn:hover {
    color: var(--text);
  }
  .range-btn.active {
    background: var(--accent);
    color: var(--text-on-accent);
  }
  .range-btn:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
</style>
