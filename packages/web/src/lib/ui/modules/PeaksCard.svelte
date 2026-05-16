<script lang="ts">
  // PeaksCard — dual-channel utility (Mutable Instruments Peaks archetype).
  // Two channel strips, each: mode dropdown + 2 knobs + gate-in + cv-in + out.
  // Knob semantics depend on the active mode; the label updates dynamically.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { peaksDef, peaksMath, PEAKS_MODE_NAMES, PEAKS_MAX_MODE, type PeaksMode } from '$lib/audio/modules/peaks';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (pid: string): number =>
    peaksDef.params.find((p) => p.id === pid)!.defaultValue;

  let mode0 = $derived(node?.params.mode0 ?? defaultFor('mode0'));
  let mode1 = $derived(node?.params.mode1 ?? defaultFor('mode1'));
  let k1_0  = $derived(node?.params.k1_0  ?? defaultFor('k1_0'));
  let k2_0  = $derived(node?.params.k2_0  ?? defaultFor('k2_0'));
  let k1_1  = $derived(node?.params.k1_1  ?? defaultFor('k1_1'));
  let k2_1  = $derived(node?.params.k2_1  ?? defaultFor('k2_1'));

  function clampMode(v: number): PeaksMode {
    return Math.max(0, Math.min(PEAKS_MAX_MODE, Math.round(v))) as PeaksMode;
  }

  let mode0Label = $derived(PEAKS_MODE_NAMES[clampMode(mode0)]);
  let mode1Label = $derived(PEAKS_MODE_NAMES[clampMode(mode1)]);
  let knob0Labels = $derived(peaksMath.knobLabels(clampMode(mode0)));
  let knob1Labels = $derived(peaksMath.knobLabels(clampMode(mode1)));

  const set = (pid: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[pid] = v; };
  const live = (pid: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, pid);
  };

  function cycleMode(channel: 0 | 1): void {
    const pid = channel === 0 ? 'mode0' : 'mode1';
    const cur = clampMode(channel === 0 ? mode0 : mode1);
    const next = ((cur + 1) % (PEAKS_MAX_MODE + 1)) as PeaksMode;
    const t = patch.nodes[id];
    if (t) t.params[pid] = next;
  }

  const inputs: PortDescriptor[] = [
    { id: 'gate0',    cable: 'gate' },
    { id: 'gate1',    cable: 'gate' },
    { id: 'mode0_cv', cable: 'cv' },
    { id: 'mode1_cv', cable: 'cv' },
    { id: 'k1_0_cv',  cable: 'cv' },
    { id: 'k2_0_cv',  cable: 'cv' },
    { id: 'k1_1_cv',  cable: 'cv' },
    { id: 'k2_1_cv',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out0', cable: 'audio' },
    { id: 'out1', cable: 'audio' },
  ];
</script>

<div class="mod-card peaks-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">PEAKS</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="channel-row">
      <div class="channel">
        <button
          type="button"
          class="mode-btn"
          data-testid="peaks-mode0"
          onclick={() => cycleMode(0)}
        >{mode0Label}</button>
        <div class="fader-pair">
          <Fader value={k1_0} min={peaksDef.params.find((p) => p.id === 'k1_0')!.min!}
                 max={peaksDef.params.find((p) => p.id === 'k1_0')!.max!}
                 defaultValue={defaultFor('k1_0')}
                 label={knob0Labels.k1} curve="linear"
                 onchange={set('k1_0')} readLive={live('k1_0')} />
          <Fader value={k2_0} min={peaksDef.params.find((p) => p.id === 'k2_0')!.min!}
                 max={peaksDef.params.find((p) => p.id === 'k2_0')!.max!}
                 defaultValue={defaultFor('k2_0')}
                 label={knob0Labels.k2} curve="linear"
                 onchange={set('k2_0')} readLive={live('k2_0')} />
        </div>
      </div>

      <div class="channel">
        <button
          type="button"
          class="mode-btn"
          data-testid="peaks-mode1"
          onclick={() => cycleMode(1)}
        >{mode1Label}</button>
        <div class="fader-pair">
          <Fader value={k1_1} min={peaksDef.params.find((p) => p.id === 'k1_1')!.min!}
                 max={peaksDef.params.find((p) => p.id === 'k1_1')!.max!}
                 defaultValue={defaultFor('k1_1')}
                 label={knob1Labels.k1} curve="linear"
                 onchange={set('k1_1')} readLive={live('k1_1')} />
          <Fader value={k2_1} min={peaksDef.params.find((p) => p.id === 'k2_1')!.min!}
                 max={peaksDef.params.find((p) => p.id === 'k2_1')!.max!}
                 defaultValue={defaultFor('k2_1')}
                 label={knob1Labels.k2} curve="linear"
                 onchange={set('k2_1')} readLive={live('k2_1')} />
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .peaks-card { width: 320px; min-height: 240px; }
  .peaks-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  .peaks-card .channel-row {
    display: flex;
    justify-content: space-between;
    padding: 0 16px;
    margin-top: 10px;
    gap: 12px;
  }
  .peaks-card .channel {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .peaks-card .mode-btn {
    width: 100%;
    border: 1px solid var(--border, #555);
    background: var(--bg-elevated, #1a1a1a);
    color: var(--text, #eee);
    padding: 4px 8px;
    font-family: var(--font-display, monospace);
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .peaks-card .mode-btn:hover {
    background: var(--bg-hover, #2a2a2a);
  }
  .peaks-card .fader-pair {
    display: flex;
    gap: 8px;
  }
</style>
