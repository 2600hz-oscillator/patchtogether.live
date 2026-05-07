<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { scopeDef, type ScopeSnapshot } from '$lib/audio/modules/scope';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // All scope params are display-only; read from the patch directly. The
  // factory's setParam ignores writes — there's nothing to apply on the audio
  // path. (timeMs / ch{1,2}Scale / ch{1,2}Offset / mode all live on the card.)
  let timeMs    = $derived(node?.params.timeMs    ?? scopeDef.params[0]!.defaultValue);
  let ch1Scale  = $derived(node?.params.ch1Scale  ?? scopeDef.params[1]!.defaultValue);
  let ch1Offset = $derived(node?.params.ch1Offset ?? scopeDef.params[2]!.defaultValue);
  let ch1Range  = $derived(node?.params.ch1Range  ?? scopeDef.params[3]!.defaultValue);
  let ch2Scale  = $derived(node?.params.ch2Scale  ?? scopeDef.params[4]!.defaultValue);
  let ch2Offset = $derived(node?.params.ch2Offset ?? scopeDef.params[5]!.defaultValue);
  let ch2Range  = $derived(node?.params.ch2Range  ?? scopeDef.params[6]!.defaultValue);
  let xyMode    = $derived((node?.params.mode ?? 0) >= 0.5);

  // Range mode → vertical fullscale. Audio = ±1, CV = ±5.
  const RANGE_MAX_AUDIO = 1;
  const RANGE_MAX_CV = 5;
  let ch1RangeMax = $derived(ch1Range >= 0.5 ? RANGE_MAX_CV : RANGE_MAX_AUDIO);
  let ch2RangeMax = $derived(ch2Range >= 0.5 ? RANGE_MAX_CV : RANGE_MAX_AUDIO);

  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  function toggleXY() {
    const target = patch.nodes[id];
    if (target) target.params.mode = xyMode ? 0 : 1;
  }
  function toggleRange(channel: 1 | 2) {
    const target = patch.nodes[id];
    if (!target) return;
    const key = channel === 1 ? 'ch1Range' : 'ch2Range';
    target.params[key] = (target.params[key] ?? 0) >= 0.5 ? 0 : 1;
  }

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;

  // Resolve cable colors once at mount.
  let ch1Color = '#fbbf24';
  let ch2Color = '#60a5fa';
  onMount(() => {
    const cs = getComputedStyle(document.documentElement);
    ch1Color = cs.getPropertyValue('--cable-audio').trim() || ch1Color;
    ch2Color = cs.getPropertyValue('--cable-pitch').trim() || ch2Color;
  });

  $effect(() => {
    if (!canvasEl) return;
    function tick() {
      const eng = engineCtx.get();
      if (eng && node && canvasEl) {
        const snap = eng.read(node, 'snapshot') as ScopeSnapshot | undefined;
        if (snap) draw(canvasEl, snap);
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

  function draw(c: HTMLCanvasElement, snap: ScopeSnapshot) {
    const ctx2d = c.getContext('2d');
    if (!ctx2d) return;
    const w = c.width;
    const h = c.height;
    ctx2d.clearRect(0, 0, w, h);

    ctx2d.fillStyle = '#0a0c10';
    ctx2d.fillRect(0, 0, w, h);

    if (xyMode) {
      drawXY(ctx2d, snap, w, h);
    } else {
      drawSplit(ctx2d, snap, w, h);
    }
  }

  /** Two traces stacked, sharing the same horizontal time axis. */
  function drawSplit(ctx2d: CanvasRenderingContext2D, snap: ScopeSnapshot, w: number, h: number) {
    // Center line
    ctx2d.strokeStyle = '#1f242c';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, h / 2);
    ctx2d.lineTo(w, h / 2);
    ctx2d.stroke();

    const samplesInWindow = Math.min(
      snap.ch1.length,
      Math.max(2, Math.round((timeMs / 1000) * snap.sampleRate))
    );
    const step = Math.max(1, Math.floor(samplesInWindow / w));

    drawChannel(ctx2d, snap.ch1, samplesInWindow, step, w, h, ch1Color, 1,   ch1Scale, ch1Offset, ch1RangeMax);
    drawChannel(ctx2d, snap.ch2, samplesInWindow, step, w, h, ch2Color, 0.6, ch2Scale, ch2Offset, ch2RangeMax);
  }

  /** XY plot — ch1 horizontal, ch2 vertical. Phase relationships visible. */
  function drawXY(ctx2d: CanvasRenderingContext2D, snap: ScopeSnapshot, w: number, h: number) {
    // Crosshair grid through the (offset-aware) origin.
    const cx = w / 2 + (ch1Offset * w) / 2;
    const cy = h / 2 - (ch2Offset * h) / 2;
    ctx2d.strokeStyle = '#1f242c';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, cy);
    ctx2d.lineTo(w, cy);
    ctx2d.moveTo(cx, 0);
    ctx2d.lineTo(cx, h);
    ctx2d.stroke();

    const samplesInWindow = Math.min(
      snap.ch1.length,
      Math.max(2, Math.round((timeMs / 1000) * snap.sampleRate))
    );
    const start1 = snap.ch1.length - samplesInWindow;
    const start2 = snap.ch2.length - samplesInWindow;
    const step = Math.max(1, Math.floor(samplesInWindow / w));

    // Blend ch1+ch2 colors for the XY trace — the underlying signal carries
    // both channels' identity, so neither cable color is strictly correct.
    ctx2d.strokeStyle = ch1Color;
    ctx2d.globalAlpha = 0.85;
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    for (let i = 0; i < samplesInWindow; i += step) {
      // Per-channel range divides the sample so ±rangeMax fills the axis.
      const xv = ((snap.ch1[start1 + i] ?? 0) / ch1RangeMax) * ch1Scale + ch1Offset;
      const yv = ((snap.ch2[start2 + i] ?? 0) / ch2RangeMax) * ch2Scale + ch2Offset;
      const xPx = w / 2 + (xv * w) / 2;
      const yPx = h / 2 - (yv * h) / 2;
      if (i === 0) ctx2d.moveTo(xPx, yPx);
      else ctx2d.lineTo(xPx, yPx);
    }
    ctx2d.stroke();
    ctx2d.globalAlpha = 1;
  }

  function drawChannel(
    ctx2d: CanvasRenderingContext2D,
    samples: Float32Array,
    samplesInWindow: number,
    step: number,
    w: number,
    h: number,
    color: string,
    alpha: number,
    scale: number,
    offset: number,
    rangeMax: number
  ) {
    ctx2d.strokeStyle = color;
    ctx2d.globalAlpha = alpha;
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    const start = samples.length - samplesInWindow;
    for (let i = 0; i < samplesInWindow; i += step) {
      const v = ((samples[start + i] ?? 0) / rangeMax) * scale + offset;
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
  <header class="title">
    Scope
    <button
      class="rng-btn"
      class:cv={ch1Range >= 0.5}
      style="color: {ch1Color};"
      onclick={() => toggleRange(1)}
      title={ch1Range >= 0.5 ? 'Ch1: CV range (±5)' : 'Ch1: audio range (±1)'}
    >
      1{ch1Range >= 0.5 ? 'cv' : 'a'}
    </button>
    <button
      class="rng-btn"
      class:cv={ch2Range >= 0.5}
      style="color: {ch2Color};"
      onclick={() => toggleRange(2)}
      title={ch2Range >= 0.5 ? 'Ch2: CV range (±5)' : 'Ch2: audio range (±1)'}
    >
      2{ch2Range >= 0.5 ? 'cv' : 'a'}
    </button>
    <button class="xy-btn" class:active={xyMode} onclick={toggleXY} title={xyMode ? 'Split mode' : 'XY mode'}>
      {xyMode ? 'XY' : '⇆'}
    </button>
  </header>

  <Handle type="target" position={Position.Left} id="ch1" style="top: 56px; --handle-color: var(--cable-audio);" />
  <Handle type="target" position={Position.Left} id="ch2" style="top: 92px; --handle-color: var(--cable-audio);" />
  <span class="port-label left" style="top: 50px;">ch1</span>
  <span class="port-label left" style="top: 86px;">ch2</span>

  <Handle type="source" position={Position.Right} id="ch1_out" style="top: 56px; --handle-color: var(--cable-audio);" />
  <Handle type="source" position={Position.Right} id="ch2_out" style="top: 92px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 50px;">out1</span>
  <span class="port-label right" style="top: 86px;">out2</span>

  <div class="screen-wrap">
    <canvas bind:this={canvasEl} width="280" height="120"></canvas>
  </div>

  <div class="fader-row">
    <Fader value={timeMs}    min={1}    max={200} defaultValue={20} label="Time" units="ms" curve="log"    onchange={setParam('timeMs')} />
    <Fader value={ch1Scale}  min={0.1}  max={10}  defaultValue={1}  label="1 Sc"            curve="log"    onchange={setParam('ch1Scale')} />
    <Fader value={ch1Offset} min={-1}   max={1}   defaultValue={0}  label="1 Y"             curve="linear" onchange={setParam('ch1Offset')} />
    <Fader value={ch2Scale}  min={0.1}  max={10}  defaultValue={1}  label="2 Sc"            curve="log"    onchange={setParam('ch2Scale')} />
    <Fader value={ch2Offset} min={-1}   max={1}   defaultValue={0}  label="2 Y"             curve="linear" onchange={setParam('ch2Offset')} />
  </div>
</div>

<style>
  .card {
    width: 320px;
    min-height: 270px;
    background: var(--module-bg);
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  :global(.svelte-flow__node:hover) .card {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: var(--cable-cv);
    border-radius: 2px 2px 0 0;
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .xy-btn {
    width: 28px;
    height: 18px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text-dim);
    border-radius: 3px;
    font-size: 0.65rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    font-family: inherit;
  }
  .xy-btn.active {
    background: var(--accent);
    color: #1a1d23;
    border-color: var(--accent);
  }
  .rng-btn {
    height: 18px;
    min-width: 26px;
    padding: 0 4px;
    background: #14171c;
    border: 1px solid #2a2f3a;
    border-radius: 3px;
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    line-height: 1;
  }
  .rng-btn.cv {
    background: #1c2028;
    border-color: currentColor;
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
    height: 120px;
  }
  .fader-row {
    display: flex;
    justify-content: center;
    gap: 6px;
    margin-top: 4px;
    padding: 0 12px;
  }
</style>
