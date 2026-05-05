<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { scopeDef, type ScopeSnapshot } from '$lib/audio/modules/scope';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let timeMs = $derived(node?.params.timeMs ?? scopeDef.params[0]!.defaultValue);

  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;

  $effect(() => {
    if (!canvasEl) return;
    function tick() {
      const eng = engineCtx.get();
      if (eng && node && canvasEl) {
        const snap = eng.read(node, 'snapshot') as ScopeSnapshot | undefined;
        if (snap) draw(canvasEl, snap, timeMs);
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  });

  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
  });

  function draw(c: HTMLCanvasElement, snap: ScopeSnapshot, windowMs: number) {
    const ctx2d = c.getContext('2d');
    if (!ctx2d) return;
    const w = c.width;
    const h = c.height;
    ctx2d.clearRect(0, 0, w, h);

    // Background
    ctx2d.fillStyle = '#0a0c10';
    ctx2d.fillRect(0, 0, w, h);

    // Center line
    ctx2d.strokeStyle = '#1f242c';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, h / 2);
    ctx2d.lineTo(w, h / 2);
    ctx2d.stroke();

    const samplesInWindow = Math.min(
      snap.ch1.length,
      Math.max(2, Math.round((windowMs / 1000) * snap.sampleRate))
    );
    const step = Math.max(1, Math.floor(snap.ch1.length / samplesInWindow));

    drawChannel(ctx2d, snap.ch1, samplesInWindow, step, w, h, 'var(--cable-audio)', 1);
    drawChannel(ctx2d, snap.ch2, samplesInWindow, step, w, h, 'var(--cable-pitch)', 0.6);
  }

  function drawChannel(
    ctx2d: CanvasRenderingContext2D,
    data: Float32Array,
    samplesInWindow: number,
    step: number,
    w: number,
    h: number,
    color: string,
    alpha: number
  ) {
    // Resolve the CSS variable to a real color (canvas can't read CSS vars directly)
    const resolved = getComputedStyle(document.documentElement)
      .getPropertyValue(color.replace('var(', '').replace(')', '').trim())
      .trim() || color;
    ctx2d.strokeStyle = resolved;
    ctx2d.globalAlpha = alpha;
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    const start = data.length - samplesInWindow;
    for (let i = 0; i < samplesInWindow; i += step) {
      const sampleIdx = start + i;
      const v = data[sampleIdx] ?? 0;
      const x = (i / samplesInWindow) * w;
      const y = h / 2 - v * (h / 2);
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
    ctx2d.globalAlpha = 1;
  }
</script>

<div class="card">
  <div class="stripe"></div>
  <header class="title">Scope</header>

  <Handle type="target" position={Position.Left} id="ch1" style="top: 56px; --handle-color: var(--cable-audio);" />
  <Handle type="target" position={Position.Left} id="ch2" style="top: 92px; --handle-color: var(--cable-audio);" />
  <span class="port-label left" style="top: 50px;">ch1</span>
  <span class="port-label left" style="top: 86px;">ch2</span>

  <Handle type="source" position={Position.Right} id="ch1_out" style="top: 56px; --handle-color: var(--cable-audio);" />
  <Handle type="source" position={Position.Right} id="ch2_out" style="top: 92px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 50px;">out1</span>
  <span class="port-label right" style="top: 86px;">out2</span>

  <div class="screen-wrap">
    <canvas bind:this={canvasEl} width="240" height="100"></canvas>
  </div>

  <div class="fader-row">
    <Fader
      value={timeMs}
      min={1}
      max={200}
      defaultValue={20}
      label="Time"
      units="ms"
      curve="log"
      onchange={setParam('timeMs')}
    />
  </div>
</div>

<style>
  .card {
    width: 280px;
    min-height: 230px;
    background: var(--module-bg);
    border: 1px solid #2a2f3a;
    border-radius: 6px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: var(--cable-cv);
    border-radius: 6px 6px 0 0;
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
  }
  .port-label {
    position: absolute;
    font-size: 0.6rem;
    color: var(--text-dim);
    pointer-events: none;
    font-family: ui-monospace, monospace;
  }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }
  .screen-wrap {
    margin: 30px 30px 8px;
    border: 1px solid #2a2f3a;
    border-radius: 3px;
    overflow: hidden;
    line-height: 0;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100px;
  }
  .fader-row {
    display: flex;
    justify-content: center;
    margin-top: 4px;
  }
</style>
