<script lang="ts">
  // packages/web/src/lib/ui/modules/vfpgaRunner/VfpgaRunnerOutputBody.svelte
  //
  // The VFPGA-RUNNER dock full-view body: the live output picture of whatever
  // bitstream is loaded, the SCREEN ON/OFF switch the 2026-08-18 owner ruling
  // requires of every video module, and the FABRIC floorplan view.
  //
  // ⚠ WHY THE SWITCHES ARE HERE AND NOT ON THE CARD (#1928). Promotion sets
  // `migrated('vfpgaRunner')` true, and neither surface renders
  // `VfpgaRunnerCard.svelte` after that — so an affordance authored only on the
  // card is deleted by the promotion meant to keep it. That is what
  // `spirographs` shipped and #1930 repaired. `previewCollapsed` appears in
  // zero shell files, so it arrives through the `fullViewBody` extension slot,
  // the route `backdraft`, `videoOut`, `spirographs` and `mirrorpool` take.
  //
  // ⚠ THE FABRIC VIEW IS THE SECOND AFFORDANCE PROMOTION WOULD HAVE DELETED.
  // The card's `fabric` button is the ONLY route to the floorplan — a read-only
  // tile-grid + lit-nets diagram of the loaded bitstream's placed fabric, which
  // is the one surface on which a `.vfpga` is legible AS a circuit rather than
  // as a name in a picker. It belongs beside the picture (it IS an alternate
  // view of the same output area), which is exactly where the card put it.
  //
  // The LANE tile is deliberately untouched: `dockFullViewHeadPlan` renders
  // this slot at the dock only, because a 192 px lane tile cannot carry a
  // module surface. The lane keeps the generic `VideoTileThumb`.

  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { getVfpgaSpec, DEFAULT_VFPGA_ID } from '$lib/video/vfpga/registry';
  import type { VfpgaSpec } from '$lib/video/vfpga/types';
  import { drawPreviewDownscaled } from '../preview-downscale';
  import VfpgaFloorplan from '../VfpgaFloorplan.svelte';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ⚠ SCREEN STATE LIVES ON THE NODE, NOT IN THIS COMPONENT. A `$state` here
  // dies with the component, and this component unmounts on dock collapse /
  // LRU eviction — the card-unmount-kills-node-lifetime-state class (#1531 /
  // #1574 / #1583). `node.data` survives a tab switch (the owner's stated
  // floor), a remount, a reload, and syncs to collaborators.
  //
  // ⚠ IT IS THE SAME `previewCollapsed` KEY THE CARD USES, deliberately: a rack
  // saved before this promotion already carries it, and reading a different key
  // would silently re-open every collapsed preview. Absent ⇒ false ⇒ ON.
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

  // ⚠ FABRIC IS COMPONENT STATE, AND THE ASYMMETRY WITH SCREEN IS DELIBERATE.
  // `node.data` rides the Y.Doc: it is shared with every collaborator and saved
  // with the patch. SCREEN belongs there (the owner's floor is that it persists
  // through tab switches). The floorplan is a momentary INSPECTION view of a
  // read-only diagram — one player opening it must not swap everyone else's
  // picture for a schematic or dirty the patch — so it stays local, which is
  // also exactly what the legacy card did.
  let showFabric = $state(false);
  function toggleFabric(): void { showFabric = !showFabric; }

  let spec = $derived.by<VfpgaSpec | undefined>(() => {
    void nodeVersion(nodeId);
    const id = (patch.nodes[nodeId]?.data as { vfpga?: string } | undefined)?.vfpga
      ?? DEFAULT_VFPGA_ID;
    return getVfpgaSpec(id) ?? getVfpgaSpec(DEFAULT_VFPGA_ID);
  });

  /** Resolve the live video engine, or undefined mid-teardown. Never throws —
   *  an engine hiccup must not kill the rAF loop. */
  function videoEngine(): VideoEngine | undefined {
    const e = engineCtx.get();
    if (!e) return undefined;
    try {
      return e.getDomain<VideoEngine>('video');
    } catch {
      return undefined;
    }
  }

  // ⚠ SCREEN OFF STOPS THE COPY, AND KEEPS THE WATCH MARK.
  // `blitOutputForPreview` IS the "someone is watching" signal — it calls
  // `markWatched` itself — and a node is a pull root only while its mark is
  // younger than `WATCH_TTL_MS`. So a SCREEN-OFF state that simply stopped
  // calling the blit would stop marking the node watched, and 1.5 s later it
  // would drop out of the pull set: the toggle would be a PRODUCER KILL SWITCH
  // on any rack where nothing downstream is watching, and switching back ON
  // would show a stale frame while it spun up — the #1720/#1721 class the owner
  // ruling names when it says the module KEEPS RENDERING. Marking directly is
  // the supported route (`markWatched` is public precisely so bespoke
  // presentation paths can mark), and it is one `Map.set` per frame against a
  // blit plus a downscale, so SCREEN OFF still reclaims essentially all of the
  // cost.
  //
  // The FABRIC view marks too, for the same reason: looking at the schematic
  // must not stop the program running.
  function draw() {
    rafId = null;
    const ve = videoEngine();
    if (!ve) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed || showFabric) {
      try { ve.markWatched(nodeId); } catch { /* never nuke the rAF loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (!canvasEl) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
      let blitted = false;
      try { blitted = ve.blitOutputForPreview(nodeId); } catch { /* never nuke the loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
      const src = ve.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const srcAspect = ENGINE_W / ENGINE_H;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      drawPreviewDownscaled(ctx2d, src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  // ONE place owns the loop, so it cannot be started twice. The loop runs in
  // EVERY view state (see above), so nothing has to restart it on toggle —
  // which also removes the "switched back on and the picture never came back"
  // failure mode by construction.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div class="vf-output" data-testid="vfpga-runner-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      {#if showFabric}
        <div class="fabric-wrap" data-testid="vfpga-face-fabric">
          <VfpgaFloorplan {spec} />
        </div>
      {:else}
        <canvas
          bind:this={canvasEl}
          width={480}
          height={360}
          data-testid="vfpga-face-canvas"
        ></canvas>
      {/if}
    {/if}
    <div class="switches">
      <button
        type="button"
        class="screen-btn nodrag"
        class:on={showFabric}
        disabled={previewCollapsed}
        onclick={toggleFabric}
        data-testid="vfpga-face-fabric-toggle"
        aria-pressed={showFabric}
        title="FABRIC: swap the picture for a read-only floorplan of the loaded bitstream (tile grid + lit routing nets)."
      >FABRIC</button>
      <button
        type="button"
        class="screen-btn nodrag"
        class:on={!previewCollapsed}
        onclick={togglePreview}
        data-testid="vfpga-face-screen-toggle"
        aria-pressed={!previewCollapsed}
        title="SCREEN: turn the preview off to reclaim its space. The module keeps rendering."
      >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
    </div>
  </div>
</div>

<style>
  .vf-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCHES COST ZERO LAYOUT HEIGHT — a fix, not a style choice. See the
     OVERLAY paragraph in module-faceplates.md: stacking them under the canvas
     cost ~18.8px on a card with ~11px of slack and reddened io-spec-
     consistency's card sweep. They OVERLAY the picture's bottom-right corner,
     so the body is exactly the height the picture is. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       switches with it. Inert behind the canvas whenever the picture shows. */
    min-height: 18px;
  }
  .preview-wrap canvas {
    display: block;
    border-radius: 3px;
    background: #050608;
    max-width: 100%;
    height: auto;
  }
  .fabric-wrap {
    display: flex;
    justify-content: center;
    align-items: center;
    background: #050608;
    border-radius: 3px;
    padding: 4px;
  }
  .switches {
    position: absolute;
    right: 4px;
    bottom: 4px;
    display: flex;
    gap: 4px;
  }
  .screen-btn {
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
  .screen-btn:disabled { opacity: 0.4; cursor: default; }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
