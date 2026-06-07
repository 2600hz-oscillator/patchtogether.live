<script lang="ts">
  // FreezeframeCard — UI for FREEZEFRAME, the video sample & hold +
  // per-channel posterize module.
  //
  // Layout:
  //   Left:   video_in (VID) + gate_in (GATE).
  //   Right:  video_out (OUT) + r_out / g_out / b_out / luma_out (R/G/B/L).
  //   Body:   4 QUANT knobs (R/G/B/LUMA) + a live preview of video_out.
  //
  // The S&H + posterize logic lives in the module factory; this card just
  // wires the knobs to node.params and shows a small preview of the
  // combined output (the canonical surface.texture), mirroring
  // FourPlexVidCard's blit.
  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { freezeframeDef } from '$lib/video/modules/freezeframe';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = freezeframeDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  function def(name: string) {
    return freezeframeDef.params.find((x) => x.id === name)!;
  }

  // Inputs (left): video + gate.
  const INPUTS = [
    { id: 'video_in', y: 56, label: 'VID', color: 'var(--cable-video)' },
    { id: 'gate_in',  y: 92, label: 'GATE', color: 'var(--cable-cv)' },
  ];
  // Outputs (right): combined + isolated layers.
  const OUTPUTS = [
    { id: 'video_out', y: 56,  label: 'OUT' },
    { id: 'r_out',     y: 92,  label: 'R' },
    { id: 'g_out',     y: 124, label: 'G' },
    { id: 'b_out',     y: 156, label: 'B' },
    { id: 'luma_out',  y: 188, label: 'L' },
  ];

  // --- Live preview of video_out (the canonical surface.texture). ---
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { rafId = requestAnimationFrame(draw); return; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try { videoEngine.blitOutputToDrawingBuffer(id); } catch { /* never nuke the rAF loop */ }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const srcAspect = ENGINE_W / ENGINE_H;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      ctx2d.drawImage(src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => { rafId = requestAnimationFrame(draw); });
  onDestroy(() => { if (rafId !== null) cancelAnimationFrame(rafId); });
</script>

<div class="card video" data-testid="freezeframe-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="FREEZEFRAME" />

  {#each INPUTS as h}
    <Handle type="target" position={Position.Left} id={h.id} style={`top: ${h.y}px; --handle-color: ${h.color};`} />
    <span class="port-label left" style={`top: ${h.y - 6}px;`}>{h.label}</span>
  {/each}
  {#each OUTPUTS as h}
    <Handle type="source" position={Position.Right} id={h.id} style={`top: ${h.y}px; --handle-color: var(--cable-video);`} />
    <span class="port-label right" style={`top: ${h.y - 6}px;`}>{h.label}</span>
  {/each}

  <!-- video_out live preview -->
  <div class="preview-wrap">
    <canvas
      bind:this={canvasEl}
      width={160}
      height={120}
      data-testid="freezeframe-preview"
      data-node-id={id}
    ></canvas>
    <span class="preview-label">OUT</span>
  </div>

  <div class="fader-grid">
    <Fader value={p('quant_r')}    min={0} max={1} defaultValue={def('quant_r').defaultValue}    label="QUANT R"    curve="linear" onchange={setParam('quant_r')}    moduleId={id} paramId="quant_r" />
    <Fader value={p('quant_g')}    min={0} max={1} defaultValue={def('quant_g').defaultValue}    label="QUANT G"    curve="linear" onchange={setParam('quant_g')}    moduleId={id} paramId="quant_g" />
    <Fader value={p('quant_b')}    min={0} max={1} defaultValue={def('quant_b').defaultValue}    label="QUANT B"    curve="linear" onchange={setParam('quant_b')}    moduleId={id} paramId="quant_b" />
    <Fader value={p('quant_luma')} min={0} max={1} defaultValue={def('quant_luma').defaultValue} label="QUANT LUMA" curve="linear" onchange={setParam('quant_luma')} moduleId={id} paramId="quant_luma" />
  </div>
</div>

<style>
  .card {
    width: 260px;
    min-height: 400px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--cable-video); }
  .title { font-size: 0.85rem; font-weight: 500; text-align: center; margin: 0 0 8px; letter-spacing: 0.05em; }
  .port-label { position: absolute; font-size: 0.6rem; color: var(--text-dim); pointer-events: none; font-family: ui-monospace, monospace; }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }
  .preview-wrap {
    margin: 210px auto 0;
    width: 160px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .preview-wrap canvas {
    width: 160px;
    height: 120px;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    image-rendering: pixelated;
    display: block;
  }
  .preview-label { font-size: 0.55rem; color: var(--text-dim); letter-spacing: 0.1em; font-family: ui-monospace, monospace; }
  .fader-grid {
    margin-top: 16px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px 6px;
    justify-items: center;
  }
</style>
