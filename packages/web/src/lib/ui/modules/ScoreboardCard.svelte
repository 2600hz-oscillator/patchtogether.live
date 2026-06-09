<script lang="ts">
  // ScoreboardCard — 4-digit neon 7-segment counter widget.
  //
  // I/O:
  //   - 2 cv-typed gate inputs (SCORE, RESET) on the left.
  //   - 1 video output (OUT) on the right.
  //   - 1 colour-wheel knob (the `color` param) — 0..1 maps 0..360° hue.
  //
  // Layout:
  //   - Small preview canvas (200×80) showing the live counter, drawn via
  //     the same drawScoreboard helper the engine uploads to GL.
  //   - The preview polls the engine at rAF cadence via engine.read('score')
  //     so the displayed number tracks the live counter, regardless of
  //     which peer drove the gate.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { scoreboardDef } from '$lib/video/modules/scoreboard';
  import { drawScoreboard } from '$lib/video/modules/scoreboard-draw';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return scoreboardDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    setNodeParam(id, k, v);
  };

  // -------- Live preview canvas (200×80) --------
  const PREVIEW_W = 200;
  const PREVIEW_H = 80;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;
  let liveScore = $state(0);

  onMount(() => {
    function tick() {
      raf = null;
      const e = engineCtx.get();
      if (e && node) {
        const v = e.read(node, 'score');
        if (typeof v === 'number') liveScore = v;
      }
      if (canvasEl) {
        const ctx2d = canvasEl.getContext('2d');
        if (ctx2d) {
          drawScoreboard(ctx2d, PREVIEW_W, PREVIEW_H, liveScore, paramVal('color'));
        }
      }
      raf = requestAnimationFrame(tick);
    }
    if (canvasEl) {
      canvasEl.width = PREVIEW_W;
      canvasEl.height = PREVIEW_H;
    }
    raf = requestAnimationFrame(tick);
  });
  onDestroy(() => { if (raf !== null) cancelAnimationFrame(raf); });
</script>

<div class="mod-card scoreboard-card" data-testid="scoreboard-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="SCOREBOARD" />

  <!-- Gate inputs (left) -->
  <Handle type="target" position={Position.Left} id="score"
          style="top: 56px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 50px;">SCORE</span>

  <Handle type="target" position={Position.Left} id="reset"
          style="top: 96px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 90px;">RESET</span>

  <!-- Video output (right) -->
  <Handle type="source" position={Position.Right} id="out"
          style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="screen-wrap">
    <canvas
      bind:this={canvasEl}
      class="screen"
      data-testid="scoreboard-screen"
      data-node-id={id}
    ></canvas>
  </div>

  <div class="knob-row">
    <Knob
      value={paramVal('color')}
      min={0} max={1} defaultValue={defaultFor('color')}
      label="COLOR" curve="linear"
      onchange={set('color')} moduleId={id} paramId="color"
    />
  </div>
</div>

<style>
  .mod-card {
    width: 260px;
    min-height: 240px;
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
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-video);
  }
  .port-label {
    position: absolute;
    font-size: 0.6rem;
    color: var(--text-dim);
    pointer-events: none;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.04em;
  }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }
  .screen-wrap {
    margin: 16px auto 12px;
    width: 200px;
    height: 80px;
    border: 1px solid #000;
    background: #0a0a0a;
    box-shadow:
      inset 0 0 12px rgba(0, 0, 0, 0.7),
      0 0 4px rgba(0, 0, 0, 0.3);
    border-radius: 2px;
    overflow: hidden;
  }
  .screen {
    width: 200px;
    height: 80px;
    image-rendering: pixelated;
    display: block;
  }
  .knob-row {
    display: flex;
    justify-content: center;
    margin-top: 4px;
  }
</style>
