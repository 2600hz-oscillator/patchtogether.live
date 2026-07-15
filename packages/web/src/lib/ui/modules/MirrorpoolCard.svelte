<script lang="ts">
  // MirrorpoolCard — UI for MIRRORPOOL (hemisphere-pool liquid renderer).
  //
  // Two video inputs (POOL = underwater view, SCENE = reflected surroundings)
  // → one video output. Eleven knobs, each with a matching CV input:
  //   WIND / DIR (swell), RAIN (storm), BRIGHT (virtual sun), MODE
  //   (Refract↔Mirror), and the full PTZ camera (CAM X/Y/Z + PAN/TILT/ZOOM).
  // A live preview of the rendered OUT is shown (the CellshadeCard blit).
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import { mirrorpoolDef } from '$lib/video/modules/mirrorpool';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = mirrorpoolDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function pdef(name: string): number {
    return mirrorpoolDef.params.find((d) => d.id === name)!.defaultValue;
  }
  function pmin(name: string): number {
    return mirrorpoolDef.params.find((d) => d.id === name)!.min;
  }
  function pmax(name: string): number {
    return mirrorpoolDef.params.find((d) => d.id === name)!.max;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // --- Live preview of OUT (the canonical surface.texture). ---
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

  const inputs = portsFromDef(mirrorpoolDef.inputs, {
    pool: 'POOL',
    scene: 'SCENE',
    wind_speed: 'WIND',
    wind_dir: 'DIR',
    rain: 'RAIN',
    brightness: 'BRIGHT',
    surface_mode: 'MODE',
    cam_x: 'CAM X',
    cam_y: 'CAM Y',
    cam_z: 'CAM Z',
    pan: 'PAN',
    tilt: 'TILT',
    zoom: 'ZOOM',
  });
  const outputs = portsFromDef(mirrorpoolDef.outputs);

  const KNOBS: { id: string; label: string; units?: string }[] = [
    { id: 'wind_speed', label: 'Wind' },
    { id: 'wind_dir', label: 'Dir' },
    { id: 'rain', label: 'Rain' },
    { id: 'brightness', label: 'Bright' },
    { id: 'surface_mode', label: 'Mode' },
    { id: 'cam_x', label: 'Cam X' },
    { id: 'cam_y', label: 'Cam Y' },
    { id: 'cam_z', label: 'Cam Z' },
    { id: 'pan', label: 'Pan' },
    { id: 'tilt', label: 'Tilt' },
    { id: 'zoom', label: 'Zoom' },
  ];
</script>

<div class="vcard card video" data-testid="mirrorpool-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="MIRRORPOOL" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- OUT live preview -->
    <div class="preview-wrap">
      <canvas
        bind:this={canvasEl}
        width={160}
        height={120}
        data-testid="mirrorpool-preview"
        data-node-id={id}
      ></canvas>
    </div>

    <div class="fader-grid">
      {#each KNOBS as k (k.id)}
        <Fader
          value={p(k.id)}
          min={pmin(k.id)}
          max={pmax(k.id)}
          defaultValue={pdef(k.id)}
          label={k.label}
          curve="linear"
          onchange={setParam(k.id)}
          moduleId={id}
          paramId={k.id}
        />
      {/each}
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 250px;
    min-height: 200px;
    padding-bottom: 9px;
  }
  .preview-wrap {
    margin: 6px auto 0;
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
    display: block;
  }
  .fader-grid {
    margin-top: 8px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px 6px;
    justify-items: center;
  }
</style>
