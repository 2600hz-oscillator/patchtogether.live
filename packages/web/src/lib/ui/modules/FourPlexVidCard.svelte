<script lang="ts">
  // FourPlexVidCard — UI for 4PLEXVID, the 4-in / 4-out video router.
  //
  // Layout:
  //   Body: 4 discrete selector knobs (one per output) that pick which input
  //         (1..4) that output carries, plus a small live preview of OUT 1.
  //
  // All ports live in the shared yellow drill-down <PatchPanel> (the post-#767
  // hard standard — NO raw side <Handle> jacks). Port `id`s are byte-identical
  // to fourPlexVidDef so the CV bridge + persisted edges route unchanged:
  //   inputs  : in1..in4 (video) + gate1..gate4 (cv)
  //   outputs : out1..out4 (video)
  //
  // Each gate input advances its matching selector on a rising edge (the
  // edge-detect lives in the module factory's setParam). The selector
  // knobs are directly settable here too; both write node.params.sel{N},
  // which persists + syncs.
  import { onMount, onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { setNodeParam, mutateNode } from '$lib/graph/mutate';
  import { fourPlexVidDef } from '$lib/video/modules/4plexvid';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';
  import { drawPreviewDownscaled } from './preview-downscale';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = fourPlexVidDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // Selector value-tag: show 1-based input number (IN1..IN4) instead of
  // the raw 0..3 index.
  function selFmt(v: number): string {
    return `IN${Math.round(v) + 1}`;
  }

  // Ports — ids byte-identical to fourPlexVidDef (in1..in4 = video,
  // gate1..gate4 = cv, out1..out4 = video).
  const inputs = portsFromDef(fourPlexVidDef.inputs, {
    gate1: 'G1', gate2: 'G2', gate3: 'G3', gate4: 'G4',
  });
  const outputs = portsFromDef(fourPlexVidDef.outputs);

  // --- Live preview of OUT 1 (the canonical surface.texture). Mirrors the
  // VideoOutCard blit: ask the engine to render this node's surface FBO
  // into its drawing buffer, then drawImage it into our small canvas. ---
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ── SCREEN ON/OFF (owner ruling, 2026-08-18) ─────────────────────────────
  //
  // ⚠ THIS CARD IS NOT DEAD DESPITE THE PROMOTION, which is the only reason
  // this control belongs here as well as on the faceplate. `migrated()` swaps
  // the DOCK unconditionally in workflow mode, but the LANE swap is gated by
  // `shellPreview` — so under `?shell=legacy`, and outside workflow mode
  // entirely, this component still renders and is still the player's 4plexvid.
  // The faceplate half lives in `4plexvid/FourPlexVidOutputBody.svelte`.
  //
  // ⚠ SAME `previewCollapsed` KEY ON `node.data`, AND THAT IS LOAD-BEARING. Two
  // spellings would let a rack collapsed on one surface come back open on the
  // other, and `node.data` (not component state) is what survives the unmount
  // that dock collapse / LRU eviction causes (#1531 / #1574 / #1583).
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[id]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(id, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { rafId = requestAnimationFrame(draw); return; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }

    // ⚠ SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK (#1937).
    // `blitOutputForPreview` IS the engine's "someone is watching" signal, so a
    // collapsed state that merely stopped blitting would drop this node out of
    // the pull set once `WATCH_TTL_MS` expired — turning the switch into a
    // PRODUCER KILL SWITCH and showing a stale frame on the way back. That
    // matters more here than on most video modules: 4PLEXVID renders ALL FOUR
    // outputs every frame, so stalling it would starve three outputs this
    // preview does not even show.
    if (previewCollapsed) {
      try { videoEngine.markWatched(id); } catch { /* never nuke the rAF loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (!canvasEl) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
      let blitted = false;
      try { blitted = videoEngine.blitOutputForPreview(id); } catch { /* never nuke the rAF loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      // Aspect-fit the engine surface (4:3) into the small preview.
      const srcAspect = ENGINE_W / ENGINE_H;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      drawPreviewDownscaled(ctx2d, src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => { rafId = requestAnimationFrame(draw); });
  onDestroy(() => { if (rafId !== null) cancelAnimationFrame(rafId); });
</script>

<div class="vcard card video" data-testid="fourplexvid-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="4PLEXVID" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- OUT 1 live preview + its SCREEN switch -->
      <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
        {#if !previewCollapsed}
          <canvas
            bind:this={canvasEl}
            width={160}
            height={90}
            data-testid="fourplexvid-preview"
            data-node-id={id}
          ></canvas>
          <span class="preview-label">OUT 1</span>
        {/if}
        <button
          type="button"
          class="screen-btn nodrag"
          class:on={!previewCollapsed}
          onclick={togglePreview}
          data-testid="fourplexvid-screen-toggle"
          aria-pressed={!previewCollapsed}
          title={previewCollapsed
            ? 'SCREEN is OFF — the OUT 1 preview is collapsed and its space reclaimed. 4PLEXVID keeps routing and keeps rendering all four outputs: switching it back on shows the LIVE picture, not a stale frame.'
            : 'SCREEN — turn the OUT 1 preview off to collapse it and reclaim the vertical space. All four outputs go on rendering either way.'}
        >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
      </div>

      <div class="fader-grid">
        <NeonFader value={p('sel1')} min={0} max={3} defaultValue={fourPlexVidDef.params.find((x) => x.id === 'sel1')!.defaultValue} label="OUT1" curve="discrete" formatValue={selFmt} onchange={setParam('sel1')} moduleId={id} paramId="sel1" />
        <NeonFader value={p('sel2')} min={0} max={3} defaultValue={fourPlexVidDef.params.find((x) => x.id === 'sel2')!.defaultValue} label="OUT2" curve="discrete" formatValue={selFmt} onchange={setParam('sel2')} moduleId={id} paramId="sel2" />
        <NeonFader value={p('sel3')} min={0} max={3} defaultValue={fourPlexVidDef.params.find((x) => x.id === 'sel3')!.defaultValue} label="OUT3" curve="discrete" formatValue={selFmt} onchange={setParam('sel3')} moduleId={id} paramId="sel3" />
        <NeonFader value={p('sel4')} min={0} max={3} defaultValue={fourPlexVidDef.params.find((x) => x.id === 'sel4')!.defaultValue} label="OUT4" curve="discrete" formatValue={selFmt} onchange={setParam('sel4')} moduleId={id} paramId="sel4" />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 280px;
    min-height: 300px;
  }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances. */
    margin-top: 24px;
  }
  .preview-wrap {
    margin: 0 auto;
    width: 160px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — a fix, not a style choice. See
       the OVERLAY paragraph in module-faceplates.md: a STACKED row cost
       ~18.8 px on a card with ~11 px of slack and reddened the card sweep, so
       the button OVERLAYS the picture's bottom-right corner instead. */
    position: relative;
    /* Only load-bearing with SCREEN OFF: the canvas and its label are gone, and
       without a floor the wrap would collapse to zero and take the
       absolutely-positioned button with it. Inert whenever the picture shows. */
    min-height: 18px;
  }
  .screen-btn {
    position: absolute;
    right: 2px;
    bottom: 2px;
    font-size: 0.5rem;
    letter-spacing: 0.06em;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 2px;
    /* Legible over a live picture — a transparent button was not. */
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
  }
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
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
