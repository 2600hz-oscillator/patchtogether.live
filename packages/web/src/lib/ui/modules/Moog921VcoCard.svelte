<script lang="ts">
  // MOOG 921 VCO card — the first Moog System 55/35 clone module's faceplate.
  // Laid out to echo the original 921: a top row of frequency controls
  // (RANGE octave + FREQ fine), the rectangular WIDTH control + SYNC switch,
  // the linear-FM depth + LEVEL, and the four simultaneous waveform output
  // jacks (sine / triangle / sawtooth / rectangular) in the patch panel.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock Knob / PatchPanel controls inherit the Moog-era look — later
  // Moog slices reuse MoogPanel the same way.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { moog921VcoDef } from '$lib/audio/modules/moog921-vco';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog921VcoDef.params.find((p) => p.id === pid)!;
  }

  let octave      = $derived(node?.params.octave      ?? def('octave').defaultValue);
  let tune        = $derived(node?.params.tune        ?? def('tune').defaultValue);
  let width       = $derived(node?.params.width       ?? def('width').defaultValue);
  let linFmAmount = $derived(node?.params.linFmAmount ?? def('linFmAmount').defaultValue);
  let sync        = $derived(node?.params.sync        ?? def('sync').defaultValue);
  let level       = $derived(node?.params.level       ?? def('level').defaultValue);

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

  // SYNC is a 3-position switch (soft / off / hard) → -1 / 0 / +1.
  const SYNC_POS: Array<{ v: number; label: string }> = [
    { v: -1, label: 'SOFT' },
    { v: 0, label: 'OFF' },
    { v: 1, label: 'HARD' },
  ];
  function setSync(v: number) {
    const target = patch.nodes[id];
    if (target) target.params.sync = v;
  }

  const inputs: PortDescriptor[] = [
    { id: 'pitch',       cable: 'pitch' },
    { id: 'lin_fm',      label: 'LIN FM', cable: 'audio' },
    { id: 'sync',        cable: 'audio' },
    { id: 'width_cv',    label: 'WIDTH',  cable: 'cv' },
    { id: 'octave',      label: 'RANGE',  cable: 'cv' },
    { id: 'tune',        label: 'FREQ',   cable: 'cv' },
    { id: 'linFmAmount', label: 'FM AMT', cable: 'cv' },
    { id: 'level',       cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'sine',        cable: 'audio' },
    { id: 'triangle',    cable: 'audio' },
    { id: 'sawtooth',    cable: 'audio' },
    { id: 'rectangular', cable: 'audio' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="921 VCO" width={252}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Frequency section: RANGE (octave) + FREQ (fine). -->
    <div class="knob-row" data-testid="moog921-freq-row">
      <Knob value={octave} min={-5} max={5} defaultValue={0} label="Range" units="oct" curve="linear" onchange={setParam('octave')} moduleId={id} paramId="octave" readLive={readLive('octave')} />
      <Knob value={tune} min={-12} max={12} defaultValue={0} label="Freq" units="st" curve="linear" onchange={setParam('tune')} moduleId={id} paramId="tune" readLive={readLive('tune')} />
      <Knob value={level} min={0} max={2} defaultValue={1} label="Level" curve="linear" onchange={setParam('level')} moduleId={id} paramId="level" readLive={readLive('level')} />
    </div>

    <!-- Rectangular width + linear-FM depth. -->
    <div class="knob-row">
      <Knob value={width} min={0.02} max={0.98} defaultValue={0.5} label="Width" curve="linear" onchange={setParam('width')} moduleId={id} paramId="width" readLive={readLive('width')} />
      <Knob value={linFmAmount} min={-1} max={1} defaultValue={0} label="Lin FM" curve="linear" onchange={setParam('linFmAmount')} moduleId={id} paramId="linFmAmount" readLive={readLive('linFmAmount')} />
    </div>

    <!-- SYNC switch (soft / off / hard). -->
    <div class="sync-row" data-testid="moog921-sync-switch">
      <span class="sync-label">SYNC</span>
      <div class="sync-seg" role="radiogroup" aria-label="Sync mode">
        {#each SYNC_POS as pos (pos.v)}
          <button
            type="button"
            class="sync-btn"
            class:active={sync === pos.v}
            role="radio"
            aria-checked={sync === pos.v}
            data-sync-value={pos.v}
            onclick={() => setSync(pos.v)}
          >{pos.label}</button>
        {/each}
      </div>
    </div>
  </PatchPanel>
</MoogPanel>

<style>
  .knob-row {
    display: flex;
    gap: 14px;
    padding: 8px 18px 4px;
    justify-content: center;
  }
  .sync-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 18px 2px;
    justify-content: center;
  }
  .sync-label {
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }
  .sync-seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
  }
  .sync-btn {
    appearance: none;
    border: none;
    background: var(--module-bg-deep);
    color: var(--text-dim);
    font: inherit;
    font-size: 0.55rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    padding: 3px 7px;
    cursor: pointer;
    border-right: 1px solid var(--border);
    transition: background 80ms ease-out, color 80ms ease-out;
  }
  .sync-btn:last-child {
    border-right: none;
  }
  .sync-btn:hover {
    color: var(--text);
  }
  .sync-btn.active {
    background: var(--accent);
    color: var(--text-on-accent);
  }
  .sync-btn:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
</style>
