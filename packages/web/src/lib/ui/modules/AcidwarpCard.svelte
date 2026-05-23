<script lang="ts">
  // AcidwarpCard — 320×240 plasma display + FREEZE / SCENE buttons + SPEED knob.
  //
  // On-card display: we render the same pattern × palette that the GL
  // pipeline outputs, into a <canvas> via `read('snapshot')`. This stays
  // in sync at ~30 Hz via setInterval; cheap because the engine caches
  // the ImageData until scene/palette changes.

  import type { NodeProps } from '@xyflow/svelte';
  import { Handle, Position } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch } from '$lib/graph/store';
  import { acidwarpDef, speedKnobToMultiplier } from '$lib/video/modules/acidwarp';
  import { SCENE_COUNT, PALETTE_COUNT } from '$lib/video/modules/acidwarp-patterns';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { onMount, onDestroy } from 'svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return acidwarpDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };

  // ----- Display canvas: pull the engine's per-frame snapshot -----
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let ctx2d: CanvasRenderingContext2D | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    if (canvasEl) {
      canvasEl.width = 320;
      canvasEl.height = 240;
      ctx2d = canvasEl.getContext('2d');
    }
    pollTimer = setInterval(() => {
      const e = engineCtx.get(); if (!e || !node || !ctx2d) return;
      const snap = e.read(node, 'snapshot') as ImageData | undefined;
      if (snap) ctx2d.putImageData(snap, 0, 0);
    }, 33); // ~30 Hz
  });
  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); });

  function nextScene() {
    const t = patch.nodes[id]; if (!t) return;
    const cur = Math.round((t.params.scene ?? 0));
    t.params.scene = (cur + 1) % SCENE_COUNT;
  }
  function toggleFreeze() {
    const t = patch.nodes[id]; if (!t) return;
    t.params.freeze = (t.params.freeze ?? 0) >= 0.5 ? 0 : 1;
  }
  function cyclePalette() {
    const t = patch.nodes[id]; if (!t) return;
    const cur = Math.round((t.params.paletteType ?? 0));
    t.params.paletteType = (cur + 1) % PALETTE_COUNT;
  }

  let frozen = $derived(paramVal('freeze') >= 0.5);
  let speed = $derived(speedKnobToMultiplier(paramVal('speed')));
  let speedLabel = $derived(
    speed === 0 ? 'STOPPED'
    : `${speed.toFixed(1)}×`,
  );
  const PALETTE_NAMES = ['RGBW', 'GREY', 'HALF', 'PASTEL', 'RGBW✨', 'GREY✨', 'HALF✨', 'PSTL✨'] as const;
  let paletteLabel = $derived(PALETTE_NAMES[Math.round(paramVal('paletteType')) % PALETTE_COUNT]);
</script>

<div class="mod-card acidwarp-card">
  <div class="stripe" style="background: var(--cable-video);"></div>
  <header class="title">ACIDWARP</header>

  <Handle type="target" position={Position.Left}  id="speed_cv" style="top: 56px; --handle-color: var(--cable-cv);" />
  <span class="port-label left"  style="top: 50px;">SPD</span>
  <Handle type="target" position={Position.Left}  id="scene_cv" style="top: 88px; --handle-color: var(--cable-cv);" />
  <span class="port-label left"  style="top: 82px;">SCN</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="screen-wrap">
    <canvas bind:this={canvasEl} class="screen" data-testid="acidwarp-screen"></canvas>
  </div>

  <div class="row">
    <div class="knob-box">
      <Knob
        value={paramVal('speed')}
        min={0} max={1} defaultValue={defaultFor('speed')}
        label="SPEED" curve="linear"
        onchange={set('speed')}
      />
      <div class="speed-readout">{speedLabel}</div>
    </div>
    <div class="buttons">
      <button
        class="btn"
        onclick={nextScene}
        data-testid="acidwarp-scene"
        title="Advance to next scene (works frozen or not)"
      >SCENE</button>
      <button
        class="btn"
        class:on={frozen}
        onclick={toggleFreeze}
        data-testid="acidwarp-freeze"
        title="Pause auto scene cycle (palette keeps rotating)"
      >{frozen ? 'FROZEN' : 'FREEZE'}</button>
      <button
        class="btn small"
        onclick={cyclePalette}
        data-testid="acidwarp-palette"
        title="Cycle palette"
      >PAL: {paletteLabel}</button>
      <div class="scene-readout">SCENE {Math.round(paramVal('scene')) + 1}/{SCENE_COUNT}</div>
    </div>
  </div>
</div>

<style>
  .mod-card {
    width: 380px;
    min-height: 380px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .title { font-size: 0.85rem; font-weight: 500; text-align: center; margin: 0 0 8px; letter-spacing: 0.05em; }
  .port-label { position: absolute; font-size: 0.6rem; color: var(--text-dim); pointer-events: none; font-family: ui-monospace, monospace; }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }
  .screen-wrap {
    margin: 8px auto 12px;
    width: 320px;
    height: 240px;
    border: 1px solid #000;
    box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3);
    background: #000;
    /* CRT-ish vibe */
    border-radius: 4px;
    overflow: hidden;
  }
  .screen {
    width: 320px;
    height: 240px;
    image-rendering: pixelated;
    display: block;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 0 16px;
  }
  .knob-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .speed-readout {
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
    min-width: 60px;
    text-align: center;
  }
  .buttons {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: stretch;
  }
  .btn {
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    padding: 6px 12px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .btn:hover { border-color: var(--accent-dim); }
  .btn.on {
    background: rgba(135, 200, 255, 0.2);
    color: #87c8ff;
    border-color: #87c8ff;
  }
  .btn.small { font-size: 0.6rem; padding: 4px 8px; }
  .scene-readout {
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
    text-align: center;
    margin-top: 2px;
  }
</style>
