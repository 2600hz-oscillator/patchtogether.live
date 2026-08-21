<script lang="ts">
  // packages/web/src/lib/ui/modules/ruttetra/RuttetraOutputBody.svelte
  //
  // The RUTTETRA dock full-view body: the live raster picture and the THREE
  // affordances that live only on `RuttetraCard.svelte` and that promotion
  // would otherwise delete (`migrated('ruttetra')` stops BOTH surfaces
  // rendering the card):
  //
  //   1. SCREEN ON/OFF — the 2026-08-18 owner ruling, over `previewCollapsed`;
  //   2. MONITOR — `hideControls`, the seam #2009 filed and this face proves;
  //   3. the corner RESIZE handle, over `resizedWidth` / `resizedHeight`.
  //
  // ⚠ 1 AND 2 ARE OPPOSITE SWITCHES, NOT A DUPLICATED ONE, and #1865 proposed
  // that the first subsumes the second. It does not: SCREEN OFF hides the
  // PICTURE and keeps the controls; MONITOR hides the CONTROLS and keeps the
  // picture. They are the two directions of one question — which half am I
  // looking at? — and a raster scope wants both, because sculpting the relief
  // and reading it are different halves of the same session.
  //
  // ⚠ THE BANDS ARE THE SHELL'S TO HIDE, NOT THIS FILE'S. `fullViewBody` paints
  // ABOVE the faceplate and by contract cannot suppress it (the
  // `warrensspectrum` failure — a body that ate the plate would delete every
  // control). So this component owns the TOGGLE and `node.data.hideControls`;
  // `faceMonitorPlan` in `module-shell-model.ts` owns the suppression, and
  // requires this body to be painting before it will hide anything. That
  // ordering is the safety argument: the button that turns monitor mode ON is
  // always still on screen to turn it off.
  //
  // ⚠ AND THAT FIXES THE CARD'S POINTER TRAP RATHER THAN PORTING IT. On the
  // card the `–` button sits INSIDE the region it hides, so the only way back
  // is an undiscoverable double-click on the body — which is why
  // `RuttetraCard.svelte:209-211` carries an `a11y_no_static_element_interactions`
  // suppression calling it "a real pointer-only trap". Here the body always
  // paints, so `onBodyDblClick` has no reason to exist and is deliberately NOT
  // ported. That is parity by a strictly better route, not a dropped affordance.
  //
  // The LANE tile is untouched: `dockFullViewHeadPlan` renders this slot at the
  // dock only, because a 192 px lane tile cannot carry a module surface. The
  // lane keeps the generic `VideoTileThumb`.
  //
  // Template: `grainsOfVision/GrainsOfVisionOutputBody.svelte` (the sibling from
  // the same spec document) for the picture + SCREEN half, and
  // `bentbox/BentboxOutputBody.svelte` for the resize half. Copying them is the
  // point — a second spelling of `previewCollapsed` or of the drag is how these
  // fork.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { RUTTETRA_MONITOR_BOX } from '$lib/video/modules/ruttetra';
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

  /** The resting preview, matching the video-face fleet (grainsOfVision,
   *  mirrorpool). MONITOR mode replaces it with the box below. */
  const RESTING_W = 480;
  const RESTING_H = 360;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ── the two switches, both NODE-keyed ─────────────────────────────────────
  //
  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT. A `$state` here dies with
  // the component, and this component unmounts on dock collapse / LRU eviction
  // — the card-unmount-kills-node-lifetime-state class (#1531 / #1574 / #1583).
  // `node.data` survives a tab switch (the owner's stated floor), a remount, a
  // reload, and syncs to collaborators.
  //
  // ⚠ THE SAME KEYS THE CARD USES, all three of them, deliberately. A rack
  // saved before this promotion already carries them, and reading a different
  // key would silently re-open every collapsed preview and forget every sized
  // monitor. It also means the two surfaces agree while both exist: a monitor
  // opened on `?shell=legacy` is still open on the faceplate.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  let monitor = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.hideControls as boolean | undefined) ?? false,
  );

  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  // ⚠ TURNING MONITOR OFF CLEARS THE SIZE, exactly as the card's own restore
  // does (`RuttetraCard.svelte:170-173`, `:203-205`). Not a preference: the
  // card DEFINES `resizedWidth`/`resizedHeight` as "the size while the controls
  // are hidden", so leaving them behind would make the two surfaces disagree
  // about whether a size is stored the moment either one restores.
  function toggleMonitor(): void {
    const next = !monitor;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.hideControls = next;
      if (!next) {
        delete live.data.resizedWidth;
        delete live.data.resizedHeight;
      }
    });
  }

  // ── the MONITOR box + its corner drag ────────────────────────────────────
  //
  // Floors and default come from `RUTTETRA_MONITOR_BOX` on the def — ONE source
  // shared with the card — rather than re-typed here. On this surface they size
  // the PICTURE (there is no card chrome and no xyflow node to resize), which
  // is the meaning shift the def's own comment records.
  let boxW = $derived<number>(
    Math.max(
      RUTTETRA_MONITOR_BOX.minW,
      (patch.nodes[nodeId]?.data?.resizedWidth as number | undefined) ?? RUTTETRA_MONITOR_BOX.defW,
    ),
  );
  let boxH = $derived<number>(
    Math.max(
      RUTTETRA_MONITOR_BOX.minH,
      (patch.nodes[nodeId]?.data?.resizedHeight as number | undefined) ?? RUTTETRA_MONITOR_BOX.defH,
    ),
  );

  /** The canvas backing store, in CSS px. MONITOR mode is the only state that
   *  is user-sized; at rest the fleet preview size applies. */
  let viewW = $derived(monitor ? boxW : RESTING_W);
  let viewH = $derived(monitor ? boxH : RESTING_H);

  let resizing = $state(false);
  function onResizeStart(ev: PointerEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const w0 = boxW;
    const h0 = boxH;
    resizing = true;
    const ac = new AbortController();
    const move = (e: PointerEvent): void => {
      const w = Math.max(RUTTETRA_MONITOR_BOX.minW, Math.round(w0 + (e.clientX - startX)));
      const h = Math.max(RUTTETRA_MONITOR_BOX.minH, Math.round(h0 + (e.clientY - startY)));
      // guard:allow-raw-write — fires per pointermove during a drag; a tracked
      // write per frame would storm the doc and flood the undo stack.
      const target = patch.nodes[nodeId];
      if (target) {
        if (!target.data) target.data = {};
        target.data.resizedWidth = w;
        target.data.resizedHeight = h;
      }
    };
    const end = (): void => { resizing = false; ac.abort(); };
    window.addEventListener('pointermove', move, { signal: ac.signal });
    window.addEventListener('pointerup', end, { signal: ac.signal });
    window.addEventListener('pointercancel', end, { signal: ac.signal });
  }

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

  // ⚠ SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK (#1937 / #2015).
  // `blitOutputForPreview` IS the engine's "someone is watching" signal — it
  // calls `markWatched` itself, after the gate, because "a refused frame is not
  // an observation" — and a node is a pull root only while that mark is younger
  // than `WATCH_TTL_MS = 1500`. A collapsed state that merely stopped blitting
  // would stop renewing the mark, and the switch would become a PRODUCER KILL
  // SWITCH wherever nothing downstream is watching. That is the live defect
  // #2015 reports against `spirographs`, and the ruling says the module KEEPS
  // RENDERING.
  //
  // ⚠ THE REASON IS DIFFERENT HERE THAN ON THE SIBLINGS, and saying so matters
  // because the siblings' reason does NOT apply. `grainsOfVision` and `bentbox`
  // argue from ACCUMULATED STATE — a history ring, a feedback ping-pong — which
  // empties if the node stops being pulled. RUTTETRA HAS NONE: no `uTime`
  // uniform anywhere in `VERT_SRC`/`FRAG_SRC`, no ping-pong, no accumulator; it
  // clears to black and redraws from the input texture and params every frame,
  // so it would resume instantly. What the mark protects here is the OUTPUT: a
  // rack where this face is the only observer and `out` feeds a recorder, a
  // second dock pane or a not-yet-opened downstream still gets frames. Same
  // code, honestly different argument.
  function draw(): void {
    rafId = null;
    const ve = videoEngine();
    if (!ve) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed) {
      try { ve.markWatched(nodeId); } catch { /* never nuke the rAF loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (!canvasEl) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
      let blitted = false;
      try { blitted = ve.blitOutputForPreview(nodeId); } catch { /* never nuke the rAF loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
      const src = ve.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      // Letterbox to the engine aspect — the picture is a VIEWPORT and never
      // changes the output resolution, which is what the def's docs promise.
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
  // BOTH screen states (see above), so nothing has to restart it on toggle —
  // which also removes the "switched back on and the picture never came back"
  // failure mode by construction.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div class="rt-output" class:monitor data-testid="ruttetra-output-body">
  <div
    class="preview-wrap"
    class:resizing
    data-preview-collapsed={previewCollapsed ? 'true' : 'false'}
    style={monitor ? `width:${viewW}px;` : ''}
  >
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={viewW}
        height={viewH}
        data-testid="ruttetra-face-canvas"
      ></canvas>
    {/if}

    <!-- ⚠ BOTH SWITCHES OVERLAY THE PICTURE'S BOTTOM CORNERS AND COST ZERO
         LAYOUT HEIGHT — a fix, not a style choice. See the OVERLAY paragraph in
         module-faceplates.md: stacking a switch UNDER the canvas cost ~18.8 px
         on a card with ~11 px of slack and reddened io-spec-consistency's card
         sweep. The body is exactly the height the picture is. -->
    <button
      type="button"
      class="face-btn screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="ruttetra-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the preview off to reclaim its space. The module keeps rendering."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>

    <button
      type="button"
      class="face-btn monitor-btn nodrag"
      class:on={monitor}
      onclick={toggleMonitor}
      data-testid="ruttetra-face-monitor-toggle"
      aria-pressed={monitor}
      title="MONITOR: hide the control bands and give the raster the whole plate. Drag the corner to size it."
    >MONITOR {monitor ? 'ON' : 'OFF'}</button>

    <!-- The corner drag, present ONLY in MONITOR mode — the same condition the
         card applies (`RuttetraCard.svelte:245-251` is inside its
         `{#if hideControls}` branch), so `video-hide-controls.spec.ts`'s
         "resize handle absent by default" assertion means the same thing on
         both surfaces. -->
    {#if monitor && !previewCollapsed}
      <div
        class="resize-handle nodrag"
        role="separator"
        aria-label="Resize the RUTTETRA monitor"
        data-testid="ruttetra-face-resize-handle"
        onpointerdown={onResizeStart}
      ></div>
    {/if}
  </div>
</div>

<style>
  .rt-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       buttons with it. Inert behind the canvas whenever the picture shows. */
    min-height: 18px;
  }
  .preview-wrap.resizing {
    /* A drag must not animate — the pointer is the clock. */
    transition: none;
  }
  .preview-wrap canvas {
    display: block;
    border-radius: 3px;
    background: #050608;
    max-width: 100%;
    height: auto;
  }
  .face-btn {
    position: absolute;
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
  .face-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .face-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .screen-btn { right: 4px; }
  /* ⚠ CLEARS THE RESIZE HANDLE, which is the same bottom-right corner and only
     exists in MONITOR mode. 16 px of handle + a 6 px gap; without this the
     switch sits ON the drag target and the last few px of the corner stop
     resizing. */
  .rt-output.monitor .screen-btn { right: 22px; }
  /* Left corner, so the two switches never overlap at the narrowest monitor
     width (`RUTTETRA_MONITOR_BOX.minW` = 360 px). */
  .monitor-btn { left: 4px; }
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--cable-video) 50%,
      var(--cable-video) 60%,
      transparent 60%,
      transparent 70%,
      var(--cable-video) 70%,
      var(--cable-video) 80%,
      transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
