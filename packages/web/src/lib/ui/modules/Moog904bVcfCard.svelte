<script lang="ts">
  // MOOG 904B VCF card — Moog System 55/35 clone (batch 1). The high-pass
  // companion to the 904A: a large FIXED CONTROL VOLTAGE (cutoff) knob, a
  // two-position RANGE switch (LOW / HIGH = +1.5 oct), the summing 1 V/oct
  // CONTROL INPUT jack + a SIGNAL INPUT jack, and the OUTPUT jack. Unlike the
  // 904A there is NO regeneration / resonance knob (the hardware 904B has no
  // resonance pot).
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock Knob / PatchPanel controls inherit the Moog-era look — same
  // pattern as Moog904aVcfCard.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { moog904bDef } from '$lib/audio/modules/moog904b';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog904bDef.params.find((p) => p.id === pid)!;
  }

  let cutoff = $derived(node?.params.cutoff ?? def('cutoff').defaultValue);
  let range  = $derived(node?.params.range  ?? def('range').defaultValue);

  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }
  function readLive(paramId: string) {
    return () => {
      const eng = engineCtx.get();
      if (!eng || !node) return undefined;
      return eng.readParam(node, paramId);
    };
  }

  // RANGE is a 2-position switch: 1 = LOW (4 Hz–20 kHz) / 2 = HIGH (+1.5 oct).
  const RANGE_POS: Array<{ v: number; label: string }> = [
    { v: 1, label: 'LOW' },
    { v: 2, label: 'HIGH' },
  ];
  function setRange(v: number) {
    const target = patch.nodes[id];
    if (target) target.params.range = v;
  }

  // CONTROL INPUT (summing, left) + SIGNAL INPUT; single OUTPUT.
  const inputs: PortDescriptor[] = [
    { id: 'audio',     label: 'SIGNAL', cable: 'audio' },
    { id: 'cutoff_cv', label: 'FREQ',   cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [{ id: 'audio', cable: 'audio' }];
</script>

<MoogPanel {id} {data} defaultLabel="904B VCF" width={236}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- FIXED CONTROL VOLTAGE (cutoff). No regeneration knob on the 904B. -->
    <div class="knob-row" data-testid="moog904b-knob-row">
      <Knob value={cutoff} min={4} max={20000} defaultValue={1000} label="Cutoff" units="Hz" curve="log" onchange={setParam('cutoff')} moduleId={id} paramId="cutoff" readLive={readLive('cutoff')} />
    </div>

    <!-- RANGE switch (LOW / HIGH = +1.5 oct). -->
    <div class="range-row" data-testid="moog904b-range-switch">
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
