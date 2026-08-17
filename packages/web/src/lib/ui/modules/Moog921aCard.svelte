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
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { moog921aDef, MOOG921A_RANGE_OPTIONS } from '$lib/audio/modules/moog921a';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';
  import { paramSpec, portsFromDef } from './card-kit';

  // Every control prop comes off the DEF — the backdraft class (a card that
  // re-types its def's numbers can disagree with it, and every gate we own
  // reads the def). Bound WITH the faceplate promotion, because from the moment
  // this module enters STRICT_FACES the dock renders straight off the ParamDef
  // while this card renders off whatever it typed, so a divergence would give
  // one knob two travels depending on which surface you reached it through.
  const P = {
    frequency: paramSpec(moog921aDef, 'frequency'),
    freqRange: paramSpec(moog921aDef, 'freqRange'),
    width: paramSpec(moog921aDef, 'width'),
  };

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
  // The names come off the DEF's own `options` roster (PF-1) rather than a
  // private array here — this card used to be the ONLY place in the tree that
  // knew the two states were called SEMI and OCT, so a def-driven surface
  // painted a rotary printing `1.00` over them.
  const RANGE_POS = MOOG921A_RANGE_OPTIONS;
  function setRange(v: number) {
    const target = patch.nodes[id];
    if (target) target.params.freqRange = v;
  }

  // Summing CONTROL INPUTS (left); CV bus OUTPUTS — NO audio ports.
  const inputs = portsFromDef(moog921aDef.inputs, { freq_cv: 'FREQ', width_cv: 'WIDTH' });
  const outputs = portsFromDef(moog921aDef.outputs, { freq_bus: 'FREQ', width_bus: 'WIDTH' });
</script>

<MoogPanel {id} {data} defaultLabel="921A Driver" width={236}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- FREQUENCY + WIDTH pots. -->
    <div class="knob-row" data-testid="moog921a-knob-row">
      <Knob value={frequency} min={P.frequency.min} max={P.frequency.max} defaultValue={P.frequency.defaultValue} label={P.frequency.label} units={P.frequency.units} curve={P.frequency.curve} onchange={setParam('frequency')} moduleId={id} paramId="frequency" readLive={readLive('frequency')} />
      <Knob value={width} min={P.width.min} max={P.width.max} defaultValue={P.width.defaultValue} label={P.width.label} units={P.width.units} curve={P.width.curve} onchange={setParam('width')} moduleId={id} paramId="width" readLive={readLive('width')} />
    </div>

    <!-- RANGE switch (SEMITONE 2-oct / OCTAVE 12-oct). -->
    <div class="range-row" data-testid="moog921a-range-switch">
      <span class="range-label">RANGE</span>
      <div class="range-seg" role="radiogroup" aria-label="Frequency range">
        {#each RANGE_POS as pos (pos.value)}
          <button
            type="button"
            class="range-btn"
            class:active={freqRange === pos.value}
            role="radio"
            aria-checked={freqRange === pos.value}
            data-range-value={pos.value}
            onclick={() => setRange(pos.value)}
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
