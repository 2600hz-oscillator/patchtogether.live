<script lang="ts">
  // packages/web/src/lib/ui/modules/outlines/OutlinesOutputBody.svelte
  //
  // The OUTLINES dock full-view body: its live picture plus the SCREEN ON/OFF
  // switch the 2026-08-18 owner ruling requires of every video module.
  //
  // ⚠ WHY IT IS HERE AND NOT ON THE CARD (#1928). Promotion makes
  // `migrated('outlines')` true and neither surface renders
  // `OutlinesCard.svelte` again, so a toggle authored there is deleted by the
  // promotion meant to keep it — what `spirographs` shipped and #1930 repaired.
  //
  // ⚠ THIS MODULE'S PREVIEW SEAM IS NOT A GL BLIT, and that is the one way it
  // differs from every other adopter. backdraft / videoOut / spirographs /
  // mirrorpool all call `blitOutputForPreview`; outlines draws from
  // `engine.read(node, 'sceneCanvas')` — a 2D canvas the module keeps itself.
  // So the SCREEN cell is built against the DECLARED video surface, never
  // against one module's blit.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { drawPreviewDownscaled } from '../preview-downscale';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ⚠ STATE ON THE NODE, NOT IN THE COMPONENT — this unmounts on dock collapse
  // / LRU eviction (#1531 / #1574 / #1583), and `node.data` is what survives a
  // tab switch (the owner's stated floor), a remount, a reload and collab sync.
  // Same `previewCollapsed` key the card uses, so a rack saved before this
  // promotion does not silently re-open its collapsed preview.
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

  // ⚠ SCREEN OFF STOPS THE COPY AND KEEPS THE NODE WATCHED. `engine.read(...)`
  // marks the node watched exactly as a preview blit does, and a node is a pull
  // root only while that mark is younger than `WATCH_TTL_MS = 1500`. Simply not
  // reading would therefore stop the PRODUCER 1.5 s later and make this switch
  // a kill switch — the #1720/#1721 class the ruling forbids when it says the
  // module KEEPS RENDERING. `markWatched` is public for exactly this.
  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { videoEngine = undefined; }

    if (previewCollapsed) {
      try { videoEngine?.markWatched(nodeId); } catch { /* never nuke the rAF loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    const node = patch.nodes[nodeId];
    if (canvasEl && node) {
      try {
        const scene = e.read(node, 'sceneCanvas') as
          | OffscreenCanvas | HTMLCanvasElement | undefined;
        const c2d = canvasEl.getContext('2d');
        if (scene && c2d) {
          drawPreviewDownscaled(
            c2d, scene as CanvasImageSource, 0, 0, canvasEl.width, canvasEl.height,
          );
        }
      } catch { /* engine mid-teardown — next tick recovers */ }
    }
    rafId = requestAnimationFrame(draw);
  }

  // ONE place owns the loop, and it runs in BOTH screen states (see above), so
  // nothing has to restart it on toggle — which removes the "switched back on
  // and the picture never came back" failure mode by construction.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div class="ol-output" data-testid="outlines-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={336}
        height={336}
        data-testid="outlines-face-canvas"
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="outlines-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the preview off to reclaim its space. The module keeps rendering."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  </div>
</div>

<style>
  .ol-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* The switch OVERLAYS the picture's bottom-right corner and costs ZERO layout
     height — see the overlay paragraph in module-faceplates.md. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF, where the canvas is gone and an
       absolutely-positioned button would otherwise leave the box. */
    min-height: 18px;
  }
  .preview-wrap canvas {
    display: block;
    border-radius: 3px;
    background: #050608;
    max-width: 100%;
    height: auto;
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
