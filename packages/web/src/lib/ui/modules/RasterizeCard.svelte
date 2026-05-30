<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { rasterizeDef } from '$lib/audio/modules/rasterize';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  // Inputs: audio in + 1 CV per param. Port ids match RASTERIZE's def
  // 1:1 (io-spec consistency e2e enforces this); the CV bridge routes
  // via setParam(portId).
  const inputs: PortDescriptor[] = [
    { id: 'in',              label: 'AUDIO IN',         cable: 'audio' },
    { id: 'cursor',          label: 'SCAN (CV)',        cable: 'cv' },
    { id: 'samplesPerFrame', label: 'SAMP/FRAME (CV)',  cable: 'cv' },
    { id: 'gain',            label: 'GAIN (CV)',        cable: 'cv' },
    { id: 'wrap',            label: 'WRAP (CV)',        cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'thru', label: 'AUDIO THRU', cable: 'audio' },
    { id: 'out',  label: 'VIDEO OUT',  cable: 'mono-video' },
  ];

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Params: read from the patch (single source of truth). The engine's
  // RASTERIZE handle keeps a parallel cache that drives the video bridge
  // + the on-card render; that cache is updated by the reconciler (fader
  // → patch.nodes[].params) and by setParam (cross-domain CV bridge).
  let cursor          = $derived(node?.params.cursor          ?? rasterizeDef.params[0]!.defaultValue);
  let samplesPerFrame = $derived(node?.params.samplesPerFrame ?? rasterizeDef.params[1]!.defaultValue);
  let gain            = $derived(node?.params.gain            ?? rasterizeDef.params[2]!.defaultValue);
  let wrap            = $derived((node?.params.wrap ?? 0) >= 0.5);

  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  function toggleWrap() {
    const target = patch.nodes[id];
    if (target) target.params.wrap = wrap ? 0 : 1;
  }

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;

  $effect(() => {
    if (!canvasEl) return;
    function tick() {
      const eng = engineCtx.get();
      if (eng && node && canvasEl) {
        const img = eng.read(node, 'imageData') as ImageData | undefined;
        if (img) blit(canvasEl, img);
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

  // Stage the native 640×480 ImageData, then drawImage-scale into the
  // smaller on-card canvas (nearest-neighbour so the raster pixels stay
  // crisp — anti-alias would soften the bands, and "untamed" is the look).
  let stage: HTMLCanvasElement | null = null;
  function blit(c: HTMLCanvasElement, img: ImageData) {
    const ctx2d = c.getContext('2d');
    if (!ctx2d) return;
    if (!stage) stage = document.createElement('canvas');
    if (stage.width !== img.width || stage.height !== img.height) {
      stage.width = img.width;
      stage.height = img.height;
    }
    const sctx = stage.getContext('2d');
    if (!sctx) return;
    sctx.putImageData(img, 0, 0);
    ctx2d.imageSmoothingEnabled = false;
    ctx2d.clearRect(0, 0, c.width, c.height);
    ctx2d.drawImage(stage, 0, 0, c.width, c.height);
  }
</script>

<div class="card">
  <div class="stripe"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="Rasterize" inline />
    <button
      class="wrap-btn"
      class:clamp={wrap}
      onclick={toggleWrap}
      title={wrap ? 'Clamp (top-to-bottom repaint)' : 'Wrap (toroidal drift)'}
    >
      {wrap ? 'CLAMP' : 'WRAP'}
    </button>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="screen-wrap">
      <canvas
        bind:this={canvasEl}
        width="280"
        height="210"
        data-testid="rasterize-canvas"
      ></canvas>
    </div>

    <div class="fader-row">
      <Fader value={cursor}          min={0}  max={307200} defaultValue={0}   label="Scan"   curve="linear" onchange={setParam('cursor')}          moduleId={id} paramId="cursor" />
      <Fader value={samplesPerFrame} min={16} max={8000}   defaultValue={800} label="Samp/F" curve="log"    onchange={setParam('samplesPerFrame')} moduleId={id} paramId="samplesPerFrame" />
      <Fader value={gain}            min={0}  max={8}       defaultValue={1}   label="Gain"   curve="log"    onchange={setParam('gain')}            moduleId={id} paramId="gain" />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 320px;
    min-height: 260px;
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
    /* mono-video cable color — RASTERIZE is an audio→video bridge module. */
    background: var(--cable-mono-video, var(--cable-cv));
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
  .wrap-btn {
    height: 18px;
    min-width: 48px;
    padding: 0 6px;
    background: #14171c;
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 3px;
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    line-height: 1;
  }
  .wrap-btn.clamp {
    background: var(--accent);
    color: #1a1d23;
    border-color: var(--accent);
  }
  .screen-wrap {
    margin: 16px 30px 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
    line-height: 0;
    background: #000;
  }
  canvas {
    display: block;
    width: 100%;
    height: 158px;
    image-rendering: pixelated;
  }
  .fader-row {
    display: flex;
    justify-content: center;
    gap: 6px;
    margin-top: 4px;
    padding: 0 12px;
  }
</style>
