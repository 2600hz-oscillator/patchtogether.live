<script lang="ts">
  // MOOG 921A OSCILLATOR DRIVER card — Moog System 55/35 clone (batch 1).
  // The 921A is a CV PROCESSOR (not a sound source): a FREQUENCY pot, a
  // two-position frequency-RANGE switch (SEMITONE 2-oct / OCTAVE 12-oct), a
  // WIDTH pot, the summing FREQ + WIDTH CONTROL INPUT jacks, and the two CV
  // bus OUTPUTS (freq_bus / width_bus) that drive N 921B oscillators.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock Knob / PatchPanel controls inherit the Moog-era look — same
  // pattern as Moog921VcoCard / Moog904aVcfCard.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { moog921aDef } from '$lib/audio/modules/moog921a';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog921aDef.params.find((p) => p.id === pid)!;
  }

  let frequency = $derived(node?.params.frequency ?? def('frequency').defaultValue);
  let freqRange = $derived(node?.params.freqRange ?? def('freqRange').defaultValue);
  let width     = $derived(node?.params.width     ?? def('width').defaultValue);

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

  // RANGE is a 2-position switch: 1 = SEMITONE (2-oct) / 2 = OCTAVE (12-oct).
  const RANGE_POS: Array<{ v: number; label: string }> = [
    { v: 1, label: 'SEMI' },
    { v: 2, label: 'OCT' },
  ];
  function setRange(v: number) {
    const target = patch.nodes[id];
    if (target) target.params.freqRange = v;
  }

  // Summing CONTROL INPUTS (left); CV bus OUTPUTS — NO audio ports.
  const inputs: PortDescriptor[] = [
    { id: 'freq_cv',  label: 'FREQ',  cable: 'pitch' },
    { id: 'width_cv', label: 'WIDTH', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'freq_bus',  label: 'FREQ',  cable: 'cv' },
    { id: 'width_bus', label: 'WIDTH', cable: 'cv' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="921A Driver" width={236}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- FREQUENCY + WIDTH pots. -->
    <div class="knob-row" data-testid="moog921a-knob-row">
      <Knob value={frequency} min={-1} max={1} defaultValue={0} label="Freq" curve="linear" onchange={setParam('frequency')} moduleId={id} paramId="frequency" readLive={readLive('frequency')} />
      <Knob value={width} min={0} max={1} defaultValue={0.5} label="Width" curve="linear" onchange={setParam('width')} moduleId={id} paramId="width" readLive={readLive('width')} />
    </div>

    <!-- RANGE switch (SEMITONE 2-oct / OCTAVE 12-oct). -->
    <div class="range-row" data-testid="moog921a-range-switch">
      <span class="range-label">RANGE</span>
      <div class="range-seg" role="radiogroup" aria-label="Frequency range">
        {#each RANGE_POS as pos (pos.v)}
          <button
            type="button"
            class="range-btn"
            class:active={freqRange === pos.v}
            role="radio"
            aria-checked={freqRange === pos.v}
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
