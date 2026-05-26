<script lang="ts">
  // Tides2Card — tidal modulator / poly-slope generator (Mutable Instruments
  // Tides 2018 archetype). Five knobs (FREQ / SHAPE / SLOPE / SMOOTH / SHIFT)
  // + three mode buttons (RAMP MODE, OUTPUT MODE, RANGE). Ports: V/oct + TRIG
  // + CLOCK in; four CV outs whose relationship follows OUTPUT MODE.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import {
    tides2Def,
    TIDES2_RAMP_MODE_NAMES,
    TIDES2_OUTPUT_MODE_NAMES,
    TIDES2_RANGE_NAMES,
  } from '$lib/audio/modules/tides2';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (pid: string): number =>
    tides2Def.params.find((p) => p.id === pid)?.defaultValue ?? 0;
  const paramVal = (pid: string): number => {
    const v = node?.params?.[pid];
    return typeof v === 'number' ? v : defaultFor(pid);
  };
  const set = (pid: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[pid] = v;
  };
  const live = (pid: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, pid);
  };

  function cycle(pid: string, count: number): void {
    const cur = Math.max(0, Math.min(count - 1, Math.round(paramVal(pid))));
    const t = patch.nodes[id]; if (t) t.params[pid] = (cur + 1) % count;
  }

  let rampModeLabel = $derived(
    TIDES2_RAMP_MODE_NAMES[Math.max(0, Math.min(2, Math.round(paramVal('rampMode'))))],
  );
  let outputModeLabel = $derived(
    TIDES2_OUTPUT_MODE_NAMES[Math.max(0, Math.min(3, Math.round(paramVal('outputMode'))))],
  );
  let rangeLabel = $derived(
    TIDES2_RANGE_NAMES[Math.max(0, Math.min(2, Math.round(paramVal('range'))))],
  );

  const knobs = [
    { id: 'frequency', label: 'FREQ' },
    { id: 'shape', label: 'SHAPE' },
    { id: 'slope', label: 'SLOPE' },
    { id: 'smoothness', label: 'SMOOTH' },
    { id: 'shift', label: 'SHIFT' },
  ];

  const inputs: PortDescriptor[] = [
    { id: 'voct', label: 'V/OCT', cable: 'pitch' },
    { id: 'trig', label: 'TRIG', cable: 'gate' },
    { id: 'clock', label: 'CLOCK', cable: 'gate' },
    { id: 'freq_cv', label: 'FREQ', cable: 'cv' },
    { id: 'shape_cv', label: 'SHAPE', cable: 'cv' },
    { id: 'slope_cv', label: 'SLOPE', cable: 'cv' },
    { id: 'smooth_cv', label: 'SMTH', cable: 'cv' },
    { id: 'shift_cv', label: 'SHFT', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out0', label: 'OUT 1', cable: 'cv' },
    { id: 'out1', label: 'OUT 2', cable: 'cv' },
    { id: 'out2', label: 'OUT 3', cable: 'cv' },
    { id: 'out3', label: 'OUT 4', cable: 'cv' },
  ];
</script>

<div class="mod-card tides2-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <header class="title">TIDES2</header>

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={360}>
    <div class="modes">
      <button type="button" class="mode-btn" data-testid="tides2-rampMode"
        onclick={() => cycle('rampMode', 3)} title="RAMP MODE: AD / LOOP / AR">
        <span class="mode-cap">MODE</span>{rampModeLabel}
      </button>
      <button type="button" class="mode-btn" data-testid="tides2-outputMode"
        onclick={() => cycle('outputMode', 4)} title="OUTPUT MODE: GATES / AMP / PHASE / FREQ">
        <span class="mode-cap">OUT</span>{outputModeLabel}
      </button>
      <button type="button" class="mode-btn" data-testid="tides2-range"
        onclick={() => cycle('range', 3)} title="RANGE: LFO / AUDIO / TEMPO (clock-synced)">
        <span class="mode-cap">RNG</span>{rangeLabel}
      </button>
    </div>
    <div class="knobs">
      {#each knobs as k (k.id)}
        <Fader
          value={paramVal(k.id)}
          min={0} max={1}
          defaultValue={defaultFor(k.id)}
          label={k.label}
          curve="linear"
          onchange={set(k.id)} moduleId={id} paramId={k.id}
          readLive={live(k.id)}
        />
      {/each}
    </div>
  </PatchPanel>
  <OssAttribution author={tides2Def.ossAttribution?.author} />
</div>

<style>
  .tides2-card { width: 380px; min-height: 240px; }
  .tides2-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  .tides2-card .modes {
    display: flex;
    gap: 6px;
    padding: 12px 14px 4px;
  }
  .tides2-card .mode-btn {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    border: 1px solid var(--cable-cv, #4af);
    background: var(--bg-elevated, #1a1a1a);
    color: var(--text, #eee);
    padding: 4px 4px;
    font-family: var(--font-display, monospace);
    font-size: 0.68rem;
    letter-spacing: 0.04em;
    cursor: pointer;
  }
  .tides2-card .mode-btn:hover { background: var(--bg-hover, #2a2a2a); }
  .tides2-card .mode-cap {
    font-size: 0.5rem;
    color: var(--text-dim, #888);
    letter-spacing: 0.08em;
  }
  .tides2-card .knobs {
    display: flex;
    gap: 4px;
    padding: 6px 14px 0;
    justify-content: space-between;
  }
</style>
