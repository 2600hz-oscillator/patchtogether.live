<script lang="ts">
  // FrametableCard — UI for FRAMETABLE (video wavetable oscillator).
  //
  // ONE video input → ONE video output. MORPH scans a centre through the 60-frame
  // ring; SPREAD sets the bell window; SHIMMER dithers the static threshold; SHAPE
  // morphs triangular↔gaussian. FREEZE (toggle button + gate) holds the ring;
  // SAVE (momentary button + trigger) snapshots the ring to an in-GPU slot. A live
  // preview of video_out is shown (the GrainsOfVision/Cellshade blit). All jacks
  // live in the yellow drill-down PATCH PANEL (no raw side ports).
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import { frametableDef } from '$lib/video/modules/frametable';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = frametableDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function pdef(name: string): number { return frametableDef.params.find((d) => d.id === name)!.defaultValue; }
  function pmin(name: string): number { return frametableDef.params.find((d) => d.id === name)!.min; }
  function pmax(name: string): number { return frametableDef.params.find((d) => d.id === name)!.max; }
  function setParam(paramId: string) { return (v: number) => setNodeParam(id, paramId, v); }

  // FREEZE toggle (button + a rising edge on freeze_gate both drive `freeze`).
  let freezeOn = $derived(p('freeze') >= 0.5);
  function toggleFreeze() {
    setNodeParam(id, 'freeze', freezeOn ? 0 : 1);
  }

  // SAVE momentary: set saveTrig=1 (a rising edge the engine snapshots on) then
  // reset to 0 shortly after so a SECOND press produces a fresh rising edge.
  let savedFlash = $state(false);
  let saveResetTimer: ReturnType<typeof setTimeout> | null = null;
  let saveFlashTimer: ReturnType<typeof setTimeout> | null = null;
  function doSave() {
    setNodeParam(id, 'saveTrig', 1);
    savedFlash = true;
    if (saveResetTimer) clearTimeout(saveResetTimer);
    if (saveFlashTimer) clearTimeout(saveFlashTimer);
    saveResetTimer = setTimeout(() => setNodeParam(id, 'saveTrig', 0), 140);
    saveFlashTimer = setTimeout(() => { savedFlash = false; }, 600);
  }

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
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (saveResetTimer) clearTimeout(saveResetTimer);
    if (saveFlashTimer) clearTimeout(saveFlashTimer);
  });

  const inputs = portsFromDef(frametableDef.inputs, {
    video_in: 'IN',
    morph_cv: 'MORPH',
    spread_cv: 'SPREAD',
    shimmer_cv: 'SHIMMER',
    weightShape_cv: 'SHAPE',
    freeze_gate: 'FREEZE',
    save_trig: 'SAVE',
  });
  const outputs = portsFromDef(frametableDef.outputs, { video_out: 'OUT' });

  const KNOBS: { id: string; label: string }[] = [
    { id: 'morph', label: 'Morph' },
    { id: 'spread', label: 'Spread' },
    { id: 'shimmer', label: 'Shimmer' },
    { id: 'weightShape', label: 'Shape' },
  ];
</script>

<div class="vcard card video" data-testid="frametable-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="FRAMETABLE" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- video_out live preview -->
    <div class="preview-wrap">
      <canvas
        bind:this={canvasEl}
        width={176}
        height={132}
        data-testid="frametable-preview"
        data-node-id={id}
      ></canvas>
    </div>

    <div class="btn-row" data-testid="frametable-transport">
      <button
        type="button"
        class="ft-btn nodrag"
        class:on={freezeOn}
        data-testid="frametable-freeze"
        title="FREEZE — stop the 60-frame ring from advancing so MORPH/SPREAD scrub a held window (also held frozen while the FREEZE gate is high)"
        onclick={toggleFreeze}
      >{freezeOn ? 'FROZEN' : 'FREEZE'}</button>
      <button
        type="button"
        class="ft-btn nodrag"
        class:flash={savedFlash}
        data-testid="frametable-save"
        title="SAVE — snapshot the current 60-frame ring into an in-GPU slot (also fired by a rising edge on the SAVE trigger)"
        onclick={doSave}
      >{savedFlash ? 'SAVED' : 'SAVE'}</button>
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
    width: 258px;
    min-height: 200px;
    padding-bottom: 9px;
  }
  .preview-wrap {
    margin: 6px auto 0;
    width: 176px;
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
  .btn-row {
    display: flex;
    gap: 8px;
    margin: 8px 14px 0;
  }
  .ft-btn {
    flex: 1;
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.6rem;
    letter-spacing: 0.09em;
    padding: 5px 6px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .ft-btn:hover { border-color: var(--accent-dim); }
  .ft-btn.on {
    background: var(--accent-dim, #46506b);
    color: var(--text);
    border-color: var(--accent, #6884d7);
  }
  .ft-btn.flash {
    background: var(--cable-video, #3aa);
    color: #041014;
    border-color: var(--cable-video, #3aa);
  }
  .fader-grid {
    margin-top: 8px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px 6px;
    justify-items: center;
  }
</style>
