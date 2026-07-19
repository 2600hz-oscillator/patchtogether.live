<script lang="ts">
  // GrainsOfVisionCard — UI for GRAINS OF VISION (granular video synthesizer).
  //
  // Two video inputs (A primary, B modulator) → two video outputs (OUT full
  // chain, GRAINS raw scatter tap). The controls follow the fixed linear chain
  //   grains → feedback → reverb → out
  // grouped GRAIN / FEEDBACK / REVERB / COMP, each control with a matching CV
  // input. A live preview of OUT is shown (the CellshadeCard/MirrorpoolCard blit).
  // freeze is a hidden VRT-determinism param (no card control).
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import { grainsOfVisionDef, GOV_COMPOSITE_MODES } from '$lib/video/modules/grainsOfVision';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = grainsOfVisionDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function pdef(name: string): number { return grainsOfVisionDef.params.find((d) => d.id === name)!.defaultValue; }
  function pmin(name: string): number { return grainsOfVisionDef.params.find((d) => d.id === name)!.min; }
  function pmax(name: string): number { return grainsOfVisionDef.params.find((d) => d.id === name)!.max; }
  function pcurve(name: string): 'linear' | 'discrete' {
    return (grainsOfVisionDef.params.find((d) => d.id === name)!.curve as 'linear' | 'discrete') ?? 'linear';
  }
  function setParam(paramId: string) { return (v: number) => setNodeParam(id, paramId, v); }

  // COMP discrete readout (off/density/displace/size/rate).
  function formatComp(v: number): string {
    return (GOV_COMPOSITE_MODES[Math.max(0, Math.min(GOV_COMPOSITE_MODES.length - 1, Math.round(v)))] ?? 'off').toUpperCase();
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

  const inputs = portsFromDef(grainsOfVisionDef.inputs, {
    in_a: 'A',
    in_b: 'B',
    density: 'DENS',
    grain_size: 'SIZE',
    spray: 'SPRAY',
    time_spray: 'T-SPR',
    rate: 'RATE',
    orient: 'ORIENT',
    window: 'WINDOW',
    feedback: 'FB',
    fb_decay: 'FB DEC',
    fb_zoom: 'FB ZOOM',
    fb_rotate: 'FB ROT',
    rev_mix: 'REV MIX',
    rev_size: 'REV SZ',
    rev_decay: 'REV DEC',
    rev_diffuse: 'REV DIF',
    composite: 'COMP',
    comp_amount: 'CMP AMT',
  });
  const outputs = portsFromDef(grainsOfVisionDef.outputs, { out: 'OUT', grains: 'GRAINS' });

  // Fader sections (freeze omitted — hidden determinism param). fb_dry / rev_dry
  // render as 2-step DRY toggles.
  const SECTIONS: { title: string; knobs: { id: string; label: string }[] }[] = [
    { title: 'GRAIN', knobs: [
      { id: 'density', label: 'Density' }, { id: 'grain_size', label: 'Size' },
      { id: 'spray', label: 'Spray' }, { id: 'time_spray', label: 'T-Spray' },
      { id: 'rate', label: 'Rate' }, { id: 'orient', label: 'Orient' },
      { id: 'window', label: 'Window' },
    ] },
    { title: 'FEEDBACK', knobs: [
      { id: 'feedback', label: 'FB' }, { id: 'fb_decay', label: 'Decay' },
      { id: 'fb_zoom', label: 'Zoom' }, { id: 'fb_rotate', label: 'Rot' },
      { id: 'fb_dry', label: 'Dry' },
    ] },
    { title: 'REVERB', knobs: [
      { id: 'rev_mix', label: 'Mix' }, { id: 'rev_size', label: 'Size' },
      { id: 'rev_decay', label: 'Decay' }, { id: 'rev_diffuse', label: 'Diffuse' },
      { id: 'rev_dry', label: 'Dry' },
    ] },
    { title: 'COMPOSITE', knobs: [
      { id: 'composite', label: 'Comp' }, { id: 'comp_amount', label: 'Amount' },
    ] },
  ];
</script>

<div class="vcard card video" data-testid="grainsOfVision-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="GRAINS OF VISION" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Wide 2-column body: OUT preview on the LEFT, the GRAIN / FEEDBACK /
         REVERB / COMPOSITE fader sections on the RIGHT (each a single row that
         spans the section's fader count). This fits all ~19 controls inside the
         720×540 (4hp × 3u) card with room to breathe — the old 2hp card packed
         them into a 4-column stack that overflowed the tier's fixed height. -->
    <div class="gov-body">
      <div class="preview-wrap">
        <canvas
          bind:this={canvasEl}
          width={176}
          height={132}
          data-testid="grainsOfVision-preview"
          data-node-id={id}
        ></canvas>
      </div>

      <div class="gov-sections">
        {#each SECTIONS as sec (sec.title)}
          <div class="gov-section">
            <div class="section-label">{sec.title}</div>
            <div class="fader-row" style={`--gov-cols:${sec.knobs.length}`}>
              {#each sec.knobs as k (k.id)}
                <Fader
                  value={p(k.id)}
                  min={pmin(k.id)}
                  max={pmax(k.id)}
                  defaultValue={pdef(k.id)}
                  label={k.label}
                  curve={pcurve(k.id)}
                  formatValue={k.id === 'composite' ? formatComp : undefined}
                  onchange={setParam(k.id)}
                  moduleId={id}
                  paramId={k.id}
                />
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    /* Effective size comes from the rack tier (4hp × 3u = 720×540, set in
       rack-sizes.ts); this width is the un-racked fallback. */
    width: 720px;
    min-height: 200px;
    padding-bottom: 9px;
  }
  /* Two-column body: preview (auto) on the left, the fader sections (1fr) on
     the right. align-items:start tops both columns; min-width:0 lets the
     sections column shrink so its grids never force horizontal overflow. */
  .gov-body {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 16px;
    align-items: start;
    padding: 6px 16px 0;
    box-sizing: border-box;
  }
  .preview-wrap {
    display: flex;
    justify-content: center;
  }
  .preview-wrap canvas {
    width: 176px;
    height: 132px;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    display: block;
  }
  .gov-sections {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .gov-section {
    min-width: 0;
  }
  .section-label {
    margin: 0 0 4px;
    font-size: 0.5rem;
    letter-spacing: 0.14em;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    border-bottom: 1px solid var(--panel-line, rgba(255, 255, 255, 0.08));
    padding-bottom: 2px;
  }
  /* One row per section: `--gov-cols` (set inline = the section's fader count)
     spreads the faders evenly across the section's width. minmax(0, 1fr) lets
     each column shrink so the row never overflows the card horizontally. */
  .fader-row {
    display: grid;
    grid-template-columns: repeat(var(--gov-cols, 5), minmax(0, 1fr));
    gap: 4px;
    justify-items: center;
    min-width: 0;
  }
</style>
