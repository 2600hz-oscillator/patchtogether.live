<script lang="ts">
  // MOOG 921B OSCILLATOR card — Moog System 55/35 clone (batch 1). The slave
  // VCO: driven by a 921A's freq_bus / width_bus. Laid out to echo the 921B
  // faceplate: a FREQUENCY (2-oct fine) pot, a RANGE footage switch, an FM
  // depth pot + LEVEL, the SYNC switch (off/lo/hi), the bus + DC/AC MODULATE
  // + SYNC input jacks, and the four simultaneous waveform output jacks.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock Knob / PatchPanel controls inherit the Moog-era look — same
  // pattern as Moog921VcoCard / Moog904aVcfCard.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { moog921bDef } from '$lib/audio/modules/moog921b';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog921bDef.params.find((p) => p.id === pid)!;
  }

  let fine      = $derived(node?.params.fine      ?? def('fine').defaultValue);
  let range     = $derived(node?.params.range     ?? def('range').defaultValue);
  let modAmount = $derived(node?.params.modAmount ?? def('modAmount').defaultValue);
  let syncMode  = $derived(node?.params.syncMode  ?? def('syncMode').defaultValue);
  let level     = $derived(node?.params.level     ?? def('level').defaultValue);

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

  // SYNC is a 3-position switch (off / lo=soft / hi=hard) → 0 / -1 / +1.
  const SYNC_POS: Array<{ v: number; label: string }> = [
    { v: 0, label: 'OFF' },
    { v: -1, label: 'LO' },
    { v: 1, label: 'HI' },
  ];
  function setSync(v: number) {
    const target = patch.nodes[id];
    if (target) target.params.syncMode = v;
  }

  const inputs: PortDescriptor[] = [
    { id: 'freq_bus',  label: 'FREQ',  cable: 'cv' },
    { id: 'width_bus', label: 'WIDTH', cable: 'cv' },
    { id: 'dc_mod',    label: 'DC FM', cable: 'audio' },
    { id: 'ac_mod',    label: 'AC FM', cable: 'audio' },
    { id: 'sync',      cable: 'audio' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'sine',     cable: 'audio' },
    { id: 'triangle', cable: 'audio' },
    { id: 'saw',      cable: 'audio' },
    { id: 'rect',     cable: 'audio' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="921B Osc" width={252}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- FREQUENCY (fine) + RANGE footage + LEVEL. -->
    <div class="knob-row" data-testid="moog921b-freq-row">
      <Knob value={fine} min={-12} max={12} defaultValue={0} label="Freq" units="st" curve="linear" onchange={setParam('fine')} moduleId={id} paramId="fine" readLive={readLive('fine')} />
      <Knob value={range} min={-5} max={5} defaultValue={0} label="Range" units="oct" curve="linear" onchange={setParam('range')} moduleId={id} paramId="range" readLive={readLive('range')} />
      <Knob value={level} min={0} max={2} defaultValue={1} label="Level" curve="linear" onchange={setParam('level')} moduleId={id} paramId="level" readLive={readLive('level')} />
    </div>

    <!-- FM depth (DC + AC MODULATE inputs). -->
    <div class="knob-row">
      <Knob value={modAmount} min={-1} max={1} defaultValue={0} label="FM" curve="linear" onchange={setParam('modAmount')} moduleId={id} paramId="modAmount" readLive={readLive('modAmount')} />
    </div>

    <!-- SYNC switch (off / lo=soft / hi=hard). -->
    <div class="sync-row" data-testid="moog921b-sync-switch">
      <span class="sync-label">SYNC</span>
      <div class="sync-seg" role="radiogroup" aria-label="Sync mode">
        {#each SYNC_POS as pos (pos.v)}
          <button
            type="button"
            class="sync-btn"
            class:active={syncMode === pos.v}
            role="radio"
            aria-checked={syncMode === pos.v}
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
