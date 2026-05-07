<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch, ydoc } from '$lib/graph/store';
  import { timelordeDef } from '$lib/audio/modules/timelorde';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  let bpm         = $derived((void cardVersion, node?.params.bpm         ?? 120));
  let swingAmount = $derived((void cardVersion, node?.params.swingAmount ?? 0));
  let swingSource = $derived((void cardVersion, node?.params.swingSource ?? 0));
  let isPlaying   = $derived((void cardVersion, (node?.params.isPlaying  ?? 0) >= 0.5));

  // External clock detected when any edge targets our `clock` input.
  let hasExternalClock = $derived.by(() => {
    void cardVersion;
    for (const edge of Object.values(patch.edges)) {
      if (!edge) continue;
      if (edge.target.nodeId === id && edge.target.portId === 'clock') return true;
    }
    return false;
  });

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  function togglePlay() {
    if (hasExternalClock) return;
    set('isPlaying')(isPlaying ? 0 : 1);
  }

  // Output port labels matching def order.
  const OUT_LABELS = ['1x', '4x', '2x', '1/2', '1/3', '1/4', '1/8', '1/12', '1/16', '1/32', '1/64', 'swing'];

  // Discrete labels for the swingSource knob (display purposes only — the
  // underlying param is 0..10 lin discrete).
  const SRC_LABELS = ['1x', '4x', '2x', '1/2', '1/3', '1/4', '1/8', '1/12', '1/16', '1/32', '1/64'];
</script>

<div class="mod-card timelorde-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">
    TIMELORDE
    {#if !hasExternalClock}
      <button class="play-btn" class:playing={isPlaying} onclick={togglePlay} title={isPlaying ? 'Stop' : 'Play'}>
        {isPlaying ? '■' : '▶'}
      </button>
    {/if}
  </header>

  <Handle type="target" position={Position.Left} id="clock" style="top: 56px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 50px;">clk in</span>

  {#each OUT_LABELS as label, i (label)}
    <Handle type="source" position={Position.Right} id={label} style="top: {56 + i * 28}px; --handle-color: var(--cable-gate);" />
    <span class="port-label right" style="top: {50 + i * 28}px;">{label}</span>
  {/each}

  <div class="knob-row">
    <Knob value={bpm}         min={10} max={300} defaultValue={120} label="BPM"   curve="log"      onchange={set('bpm')}         readLive={live('bpm')} />
    <Knob value={swingAmount} min={0}  max={90}  defaultValue={0}   label="Swing" curve="linear"   onchange={set('swingAmount')} readLive={live('swingAmount')} />
    <Knob value={swingSource} min={0}  max={10}  defaultValue={0}   label="Src"   curve="discrete" onchange={set('swingSource')} />
  </div>

  <div class="footer">
    {bpm.toFixed(0)} BPM ({hasExternalClock ? 'external' : 'internal'}) · src={SRC_LABELS[Math.round(swingSource)] ?? '1x'}
  </div>
</div>

<style>
  .timelorde-card {
    width: 280px;
    min-height: 430px;
    padding-bottom: 40px;
  }
  .timelorde-card > .title {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .play-btn {
    width: 22px;
    height: 22px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text);
    border-radius: 3px;
    font-size: 0.7rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    padding: 0;
  }
  .play-btn.playing {
    background: var(--cable-gate);
    color: #1a1d23;
    border-color: var(--cable-gate);
  }
  .knob-row {
    margin: 28px 0 0 22px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: 70px;
  }
  .footer {
    position: absolute;
    bottom: 12px;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    pointer-events: none;
  }
</style>
