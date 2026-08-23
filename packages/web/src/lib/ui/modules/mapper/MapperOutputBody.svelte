<script lang="ts">
  // packages/web/src/lib/ui/modules/mapper/MapperOutputBody.svelte
  //
  // The MAPPER dock full-view body: its live keyed picture plus the SCREEN
  // ON/OFF switch the 2026-08-18 owner ruling requires of every video module.
  //
  // ⚠ WHY THIS FILE EXISTS (#1928 class). `MapperCard.svelte` has NEVER drawn a
  // preview — it is a title, a PatchPanel and one fader — so unlike its batch
  // siblings this body is not a PORT of a card affordance, it is an ADDITION.
  // The SCREEN switch is required of every video face regardless, and the
  // picture is the reason the promotion is worth doing on a one-param module at
  // all: MAPPER's whole output is a MATTE DECISION, and "did the key cut where
  // I wanted?" is not answerable from a dial reading 0.5. Recorded here so
  // nobody later "restores parity" by deleting either.
  //
  // The shape below is `LumakeyOutputBody`'s deliberately: same key, same
  // overlay geometry, same watch-mark handling. Copying it is the point — a
  // second spelling of this control is how `previewCollapsed` would fork.
  //
  // The LANE tile is untouched: `dockFullViewHeadPlan` renders this slot at the
  // dock only, and the lane keeps the generic `VideoTileThumb`.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { drawPreviewDownscaled } from '../preview-downscale';

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

  // ⚠ STATE ON THE NODE, NOT IN THE COMPONENT. This component unmounts on dock
  // collapse / LRU eviction — the card-unmount-kills-node-lifetime-state class
  // (#1531 / #1574 / #1583) — and `node.data` is what survives a tab switch (the
  // owner's stated floor), a remount, a reload, and collab sync.
  //
  // ⚠ IT IS THE SAME `previewCollapsed` KEY EVERY OTHER VIDEO BODY USES,
  // deliberately: one key across the fleet is what keeps a rack's collapsed
  // previews collapsed when a module is promoted underneath it. Absent ⇒ false
  // ⇒ ON.
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

  // ⚠ SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK (#2015).
  // `blitOutputForPreview` IS the engine's "someone is watching" signal — it
  // calls `markWatched` itself — and a node is a pull root only while that mark
  // is younger than `WATCH_TTL_MS`. So a collapsed state that merely stops
  // blitting stops marking the node watched, and the module drops out of the
  // pull set: the toggle becomes a PRODUCER KILL SWITCH wherever nothing
  // downstream is watching, and switching back ON shows a stale frame while it
  // spins up. That is the #1720/#1721 class the ruling names when it says the
  // module KEEPS RENDERING.
  //
  // ⚠ THE REASON HERE IS THE MATTE, NOT AN ACCUMULATOR. `mapper.ts`'s
  // `FRAG_SRC` declares no time uniform, no ping-pong and no history — the
  // module's own header says it is "STATELESS per frame" — so the key would
  // resume instantly and correctly. Do not copy `vdelay`'s or `milkdrop`'s
  // comment, which argue from state that empties.
  //
  // What the mark protects is the OUTPUT, and on MAPPER that is the pointed
  // case: this module produces a MATTE for something else to composite. Its
  // `out` is consumed by a downstream keyer / mixer, so a rack where this face
  // is the only observer still gets frames. A SCREEN switch that quietly
  // stopped the key would change what the DOWNSTREAM sees, which is not what
  // the control says it does.
  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { videoEngine = undefined; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed) {
      try { videoEngine.markWatched(nodeId); } catch { /* never nuke the rAF loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (!canvasEl) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
      let blitted = false;
      try { blitted = videoEngine.blitOutputForPreview(nodeId); } catch { /* never nuke the rAF loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
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
      drawPreviewDownscaled(ctx2d, src, x, y, w, h);
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

<div class="mapper-output" data-testid="mapper-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        data-testid="mapper-face-canvas"
        data-node-id={nodeId}
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="mapper-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the keyed preview is collapsed and its space reclaimed. MAPPER keeps rendering: switching it back on shows the LIVE matte, not a stale frame.'
        : 'SCREEN — turn the keyed preview off to collapse it and reclaim the vertical space. The matte goes on rendering downstream either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>
</div>

<style>
  .mapper-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — a fix, not a style choice. See the
     OVERLAY paragraph in module-faceplates.md: a stacked row cost ~18.8 px on a
     card with ~11 px of slack and reddened the card sweep. It OVERLAYS the
     picture's bottom-right corner, so the body is exactly the height the
     picture is. */
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
