<script lang="ts">
  // Channel detail sheet — all 10 real params of one mixmstrs channel
  // (spec §3 MIX): VOLUME (+inline VU) → EQ LOW/MID/HIGH (±12 dB,
  // center-detent, tap-label-to-zero) → COMP (the one-knob comp{N} macro,
  // with "advanced" exposing thresh/ratio/enable) → SENDS S1/S2.
  // Values read from the snapshot node on open + on doc updates; no
  // per-control live-CV rAF readback in the prototype.
  import HSlider from '$lib/mobile/HSlider.svelte';
  import { readParamValue } from '$lib/mobile/mobile-host';
  import { setNodeParam } from '$lib/graph/mutate';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    node: ModuleNode;
    ch: number;
    vu: number;
    onclose: () => void;
    onstep: (delta: number) => void;
  }
  let { node, ch, vu, onclose, onstep }: Props = $props();

  let advanced = $state(false);

  function pid(suffix: string): string {
    return `ch${ch}_${suffix}`;
  }
  function write(paramId: string): (v: number) => void {
    return (v) => setNodeParam(node.id, paramId, v);
  }
  let vuPct = $derived(Math.round(Math.min(1, Math.sqrt(Math.max(0, vu))) * 100));
  let compEnabled = $derived(readParamValue(node, pid('compEnable')) >= 0.5);

  const dB = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
</script>

<div class="detail" data-testid="m-channel-detail">
  <header class="head">
    <button class="nav" onclick={() => onstep(-1)} aria-label="previous channel">◀</button>
    <span class="title">CH{ch}</span>
    <button class="nav" onclick={() => onstep(1)} aria-label="next channel">▶</button>
    <button class="close" onclick={onclose} data-testid="m-detail-close">done</button>
  </header>

  <div class="body">
    <div class="vol-row">
      <HSlider
        label="volume"
        value={readParamValue(node, pid('volume'))}
        min={0}
        max={1}
        defaultValue={0.8}
        onchange={write(pid('volume'))}
        testid={`m-detail-volume`}
      />
      <div class="vu-bar" aria-hidden="true"><div class="vu-fill" style="width:{vuPct}%"></div></div>
    </div>

    <h4>eq</h4>
    <HSlider label="low" value={readParamValue(node, pid('low'))} min={-12} max={12} defaultValue={0} centerDetent format={dB} onchange={write(pid('low'))} testid="m-detail-low" />
    <HSlider label="mid" value={readParamValue(node, pid('mid'))} min={-12} max={12} defaultValue={0} centerDetent format={dB} onchange={write(pid('mid'))} testid="m-detail-mid" />
    <HSlider label="high" value={readParamValue(node, pid('high'))} min={-12} max={12} defaultValue={0} centerDetent format={dB} onchange={write(pid('high'))} testid="m-detail-high" />

    <h4>comp</h4>
    <HSlider
      label="comp"
      value={readParamValue(node, `comp${ch}`)}
      min={0}
      max={1}
      defaultValue={0}
      onchange={write(`comp${ch}`)}
      testid="m-detail-comp"
    />
    <button class="advanced-toggle" onclick={() => (advanced = !advanced)} data-testid="m-detail-advanced">
      advanced {advanced ? '▴' : '▾'}
    </button>
    {#if advanced}
      <HSlider label="thresh" value={readParamValue(node, pid('thresh'))} min={-36} max={0} defaultValue={-12} format={dB} onchange={write(pid('thresh'))} testid="m-detail-thresh" />
      <HSlider label="ratio" value={readParamValue(node, pid('ratio'))} min={1} max={10} defaultValue={2} format={(v) => `${v.toFixed(1)}:1`} onchange={write(pid('ratio'))} testid="m-detail-ratio" />
      <button
        class="enable"
        class:on={compEnabled}
        onclick={() => setNodeParam(node.id, pid('compEnable'), compEnabled ? 0 : 1)}
        data-testid="m-detail-comp-enable"
      >
        comp enable: {compEnabled ? 'ON' : 'OFF'}
      </button>
    {/if}

    <h4>sends</h4>
    <HSlider label="send 1" value={readParamValue(node, pid('send1'))} min={0} max={1} defaultValue={0} onchange={write(pid('send1'))} testid="m-detail-send1" />
    <HSlider label="send 2" value={readParamValue(node, pid('send2'))} min={0} max={1} defaultValue={0} onchange={write(pid('send2'))} testid="m-detail-send2" />
  </div>
</div>

<style>
  .detail {
    position: fixed;
    inset: 0;
    z-index: 75;
    background: #0e1116;
    display: flex;
    flex-direction: column;
    padding-top: env(safe-area-inset-top);
    color: #dbe2ee;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid #1c212b;
  }
  .title {
    flex: 1;
    text-align: center;
    font-size: 16px;
    font-weight: 800;
  }
  .nav {
    min-width: 48px;
    min-height: 44px;
    border-radius: 10px;
    border: 1px solid #2a2f3a;
    background: none;
    color: #dbe2ee;
  }
  .close {
    min-height: 44px;
    padding: 0 16px;
    border-radius: 22px;
    border: 1px solid #2a2f3a;
    background: none;
    color: #8b93a3;
  }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 14px calc(24px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  h4 {
    margin: 12px 2px 2px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #667085;
  }
  .vol-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .vu-bar {
    height: 6px;
    margin-left: 80px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.05);
    overflow: hidden;
  }
  .vu-fill {
    height: 100%;
    background: rgba(64, 200, 120, 0.6);
    transition: width 60ms linear;
  }
  .advanced-toggle {
    align-self: flex-start;
    min-height: 40px;
    padding: 0 12px;
    border-radius: 10px;
    border: 1px dashed #2a2f3a;
    background: none;
    color: #8b93a3;
    font-size: 12px;
  }
  .enable {
    min-height: 48px;
    border-radius: 10px;
    border: 1px solid #2a2f3a;
    background: rgba(255, 255, 255, 0.04);
    color: #8b93a3;
    font-weight: 700;
  }
  .enable.on {
    background: rgba(64, 200, 120, 0.2);
    border-color: rgba(64, 200, 120, 0.5);
    color: #7fe0a8;
  }
</style>
