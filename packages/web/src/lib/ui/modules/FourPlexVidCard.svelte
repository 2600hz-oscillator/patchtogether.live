<script lang="ts">
  // FourPlexVidCard — UI for 4PLEXVID, the 4-in / 4-out video router.
  //
  // Layout:
  //   Left side, upper:  4 video inputs (IN1..IN4).
  //   Left side, lower:  4 gate CV inputs (G1..G4) — one per output.
  //   Right side:        4 video outputs (OUT1..OUT4).
  //   Body:              4 discrete selector knobs (one per output) that
  //                      pick which input (1..4) that output carries, plus
  //                      a small live preview of OUT 1.
  //
  // Each gate input advances its matching selector on a rising edge (the
  // edge-detect lives in the module factory's setParam). The selector
  // knobs are directly settable here too; both write node.params.sel{N},
  // which persists + syncs.
  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { fourPlexVidDef } from '$lib/video/modules/4plexvid';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = fourPlexVidDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }

  // Selector value-tag: show 1-based input number (IN1..IN4) instead of
  // the raw 0..3 index.
  function selFmt(v: number): string {
    return `IN${Math.round(v) + 1}`;
  }

  // Video inputs (upper-left) + gate CV inputs (lower-left).
  const VIDEO_IN = [
    { id: 'in1', y: 56, label: 'IN1' },
    { id: 'in2', y: 88, label: 'IN2' },
    { id: 'in3', y: 120, label: 'IN3' },
    { id: 'in4', y: 152, label: 'IN4' },
  ];
  const GATE_IN = [
    { id: 'gate1', y: 200, label: 'G1' },
    { id: 'gate2', y: 232, label: 'G2' },
    { id: 'gate3', y: 264, label: 'G3' },
    { id: 'gate4', y: 296, label: 'G4' },
  ];
  const VIDEO_OUT = [
    { id: 'out1', y: 56, label: 'OUT1' },
    { id: 'out2', y: 88, label: 'OUT2' },
    { id: 'out3', y: 120, label: 'OUT3' },
    { id: 'out4', y: 152, label: 'OUT4' },
  ];

  // --- Live preview of OUT 1 (the canonical surface.texture). Mirrors the
  // VideoOutCard blit: ask the engine to render this node's surface FBO
  // into its drawing buffer, then drawImage it into our small canvas. ---
  const ENGINE_W = 640;
  const ENGINE_H = 360;
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
      // Aspect-fit the 16:9 engine surface into the small preview.
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

<div class="card video" data-testid="fourplexvid-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="4PLEXVID" />

  {#each VIDEO_IN as h}
    <Handle type="target" position={Position.Left} id={h.id} style={`top: ${h.y}px; --handle-color: var(--cable-video);`} />
    <span class="port-label left" style={`top: ${h.y - 6}px;`}>{h.label}</span>
  {/each}
  {#each GATE_IN as h}
    <Handle type="target" position={Position.Left} id={h.id} style={`top: ${h.y}px; --handle-color: var(--cable-cv);`} />
    <span class="port-label left" style={`top: ${h.y - 6}px;`}>{h.label}</span>
  {/each}
  {#each VIDEO_OUT as h}
    <Handle type="source" position={Position.Right} id={h.id} style={`top: ${h.y}px; --handle-color: var(--cable-video);`} />
    <span class="port-label right" style={`top: ${h.y - 6}px;`}>{h.label}</span>
  {/each}

  <!-- OUT 1 live preview -->
  <div class="preview-wrap">
    <canvas
      bind:this={canvasEl}
      width={160}
      height={90}
      data-testid="fourplexvid-preview"
      data-node-id={id}
    ></canvas>
    <span class="preview-label">OUT 1</span>
  </div>

  <div class="fader-grid">
    <Fader value={p('sel1')} min={0} max={3} defaultValue={fourPlexVidDef.params.find((x) => x.id === 'sel1')!.defaultValue} label="OUT1" curve="discrete" formatValue={selFmt} onchange={setParam('sel1')} moduleId={id} paramId="sel1" />
    <Fader value={p('sel2')} min={0} max={3} defaultValue={fourPlexVidDef.params.find((x) => x.id === 'sel2')!.defaultValue} label="OUT2" curve="discrete" formatValue={selFmt} onchange={setParam('sel2')} moduleId={id} paramId="sel2" />
    <Fader value={p('sel3')} min={0} max={3} defaultValue={fourPlexVidDef.params.find((x) => x.id === 'sel3')!.defaultValue} label="OUT3" curve="discrete" formatValue={selFmt} onchange={setParam('sel3')} moduleId={id} paramId="sel3" />
    <Fader value={p('sel4')} min={0} max={3} defaultValue={fourPlexVidDef.params.find((x) => x.id === 'sel4')!.defaultValue} label="OUT4" curve="discrete" formatValue={selFmt} onchange={setParam('sel4')} moduleId={id} paramId="sel4" />
  </div>
</div>

<style>
  .card {
    width: 280px;
    min-height: 460px;
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
    margin: 200px auto 0;
    width: 160px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .preview-wrap canvas {
    width: 160px;
    height: 90px;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    image-rendering: pixelated;
    display: block;
  }
  .preview-label { font-size: 0.55rem; color: var(--text-dim); letter-spacing: 0.1em; font-family: ui-monospace, monospace; }
  .fader-grid {
    margin-top: 16px;
    padding: 0 10px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px 4px;
    justify-items: center;
  }
</style>
