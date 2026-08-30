<script lang="ts">
  // packages/web/src/lib/ui/modules/rasterize/RasterizeOutputBody.svelte
  //
  // The RASTERIZE dock full-view body: its live raster picture plus the SCREEN
  // ON/OFF switch.
  //
  // ⚠ WHY THIS FILE EXISTS. Unlike the other `fullViewBody` adopters, this is
  // not about recovering a switch — it is about recovering the PICTURE.
  // `hasVideoSurface(def)` is `def.domain === 'video'`; rasterize is
  // `domain: 'audio'` with a `mono-video` OUT, which that predicate's own
  // doc-comment names as the case it deliberately excludes (there is no
  // VideoEngine surface FBO to blit — the frame is painted in JS by
  // `RasterPainter`). So the shell has no generic route to this module's
  // output, and promotion without this slot would replace the card's live
  // raster with four knobs on the one module whose entire job is to make a
  // picture.
  //
  // ⚠ AND THE PRODUCER IS PULL-DRIVEN HERE, WHICH INVERTS THE COLLAPSE RULE.
  // In `spirographs` / `backdraft` the VIDEO ENGINE owns the producer and this
  // kind of component only READS it, so collapsing stops a copy and nothing
  // else. RASTERIZE's painter is advanced INSIDE `read('imageData')`
  // (`advanceOncePerFrame`), so when nothing downstream is patched THIS LOOP IS
  // THE ONLY THING ADVANCING THE RASTER. Stopping the loop on collapse would
  // therefore freeze the module itself — precisely the #1720/#1721 class the
  // owner's "it KEEPS RENDERING while OFF" floor exists to prevent. So the
  // collapse skips the BLIT and never the advance. That is also the cheap half
  // to keep: the advance writes ~800 pixels, while the blit is a 1024×768 →
  // 480×360 scale-draw.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { rasterizeDef } from '$lib/audio/modules/rasterize';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT. A `$state` here dies with
  // the component, and this component unmounts on dock collapse / LRU eviction
  // — the card-unmount-kills-node-lifetime-state class (#1531 / #1574 / #1583).
  // `node.data` survives a tab switch (the owner's stated floor), a remount, a
  // reload, and syncs to collaborators. Absent ⇒ false ⇒ ON, so an existing
  // rack opens unchanged. One boolean per CLICK, never per frame.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  // PUSH then READ, exactly as the legacy card does. `eng.readParam` returns the
  // knob PLUS the engine's own per-port CV tap (the combined value), and the
  // painter runs inside `read('imageData')`, so the push has to land first
  // (#1664). With nothing patched there is no tap, so this equals the knob.
  function draw() {
    rafId = null;
    const eng = engineCtx.get();
    const node = patch.nodes[nodeId] as ModuleNode | undefined;
    if (eng && node) {
      const combined: Record<string, number> = {};
      for (const p of rasterizeDef.params) {
        const v = eng.readParam(node, p.id);
        if (typeof v === 'number' && Number.isFinite(v)) combined[p.id] = v;
      }
      eng.write(node, 'cvCombined', combined);
      // ⚠ READ UNCONDITIONALLY — this is what advances the painter. See the
      // pull-driven note at the top: skipping it while collapsed would freeze
      // the raster whenever no video consumer is patched.
      const img = eng.read(node, 'imageData') as ImageData | undefined;
      if (img && !previewCollapsed && canvasEl) blit(canvasEl, img);
    }
    rafId = requestAnimationFrame(draw);
  }

  // Stage the native engine-res ImageData, then drawImage-scale into the dock
  // canvas with NEAREST-NEIGHBOUR — anti-aliasing would soften the bands, and
  // the raster's hard pixels are the module's look ("untamed is the point").
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

  // ONE place owns the loop, so it cannot be started twice. It runs for the
  // lifetime of the component regardless of SCREEN state — see the pull-driven
  // note; `draw` itself decides whether to paint.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div class="raster-output" data-testid="rasterize-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        data-testid="rasterize-face-canvas"
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="rasterize-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the preview off to reclaim its space. The raster keeps painting."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  </div>
</div>

<style>
  .raster-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — see the OVERLAY paragraph in
     module-faceplates.md. Stacking it under the canvas cost ~18.8px on a card
     with ~11px of slack and reddened io-spec-consistency's card sweep. It
     OVERLAYS the picture's bottom-right corner, so the body is exactly the
     height the picture is. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       button with it. Inert behind the canvas whenever the picture shows. */
    min-height: 18px;
  }
  .preview-wrap canvas {
    display: block;
    border-radius: 3px;
    background: #000;
    max-width: 100%;
    height: auto;
    /* The raster's pixels are the look — never smooth them. */
    image-rendering: pixelated;
  }
  .screen-btn {
    position: absolute;
    right: 4px;
    bottom: 4px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    /* Legible over a live picture — a transparent button was not. */
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
  }
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
