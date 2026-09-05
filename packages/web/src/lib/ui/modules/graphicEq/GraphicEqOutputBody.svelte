<script lang="ts">
  // packages/web/src/lib/ui/modules/graphicEq/GraphicEqOutputBody.svelte
  //
  // The GRAPHIC EQ dock full-view body: the live meters and the
  // affordances that live only on `GraphicEqCard.svelte`, which promotion
  // would otherwise delete (`migrated('graphicEq')` stops BOTH surfaces
  // rendering the card):
  //
  //   1. MONITOR — `hideControls`, the seam #2009 filed and ruttetra proved;
  //   2. the corner RESIZE handle, over `resizedWidth` / `resizedHeight`;
  //   3. SCREEN ON/OFF — the 2026-08-18 owner ruling, over `previewCollapsed`.
  //
  // ⚠ 3 IS AN ADDITION, NOT A PORT, AND THAT ASYMMETRY IS DELIBERATE. The
  // graphicEq CARD has no SCREEN switch — unlike ruttetra's, which had one to
  // carry across. The ruling is that EVERY video face ships with it, and
  // `video-face-screen-source.test.ts` denies a faced video module without one,
  // so this face gains a control its card never had. Nothing is lost by that
  // (the card is untouched); it is recorded here so the next reader does not
  // "restore parity" by deleting it.
  //
  // ⚠ 1 AND 3 ARE OPPOSITE SWITCHES, NOT A DUPLICATED ONE, and #1865 proposed
  // that the second subsumes the first. It does not: SCREEN OFF hides the
  // PICTURE and keeps the controls; MONITOR hides the CONTROLS and keeps the
  // picture. They are the two directions of one question — which half am I
  // looking at?
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
  // card the `–` button sits INSIDE the region it hides, so the only way back is
  // an undiscoverable double-click on the body — which is why
  // `GraphicEqCard.svelte` carries an `a11y_no_static_element_interactions`
  // suppression calling it "a real pointer-only trap, not a false positive;
  // tracked as #1572". Here the body always paints, so `onBodyDblClick` has no
  // reason to exist and is deliberately NOT ported. That is parity by a strictly
  // better route, not a dropped affordance.
  //
  // Template: `reshaper/ReshaperOutputBody.svelte`, itself taken from
  // `ruttetra/RuttetraOutputBody.svelte`, the module that proved this seam.
  // Copying it is the point — a second spelling of `previewCollapsed` or of the
  // drag is how these fork. ⚠ ONE PASSAGE IS DELIBERATELY NOT COPIED: the
  // SCREEN-OFF watch-mark note below, because reshaper argues from having NO
  // accumulator and this module has two. See it for the derivation.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { GRAPHIC_EQ_MONITOR_BOX } from './monitor-box';
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

  /** The resting preview, matching the video-face fleet (ruttetra,
   *  grainsOfVision, mirrorpool). MONITOR mode replaces it with the box below. */
  const RESTING_W = 480;
  const RESTING_H = 360;

  // ── the two switches, both NODE-keyed ─────────────────────────────────────
  //
  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT. A `$state` here dies with
  // the component, and this component unmounts on dock collapse / LRU eviction
  // — the card-unmount-kills-node-lifetime-state class (#1531 / #1574 / #1583).
  // `node.data` survives a tab switch (the owner's stated floor), a remount, a
  // reload, and syncs to collaborators.
  //
  // ⚠ THE SAME KEYS THE CARD USES, deliberately. A rack saved before this
  // promotion already carries `hideControls` / `resizedWidth` / `resizedHeight`,
  // and reading a different key would silently forget every monitor a player
  // already had open — the promotion is invisible to a rack that was saved
  // before it.
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
  // does (`GraphicEqCard.svelte`'s `toggleHideControls` and `onBodyDblClick`
  // both `delete` the two keys). Not a preference: the card DEFINES
  // `resizedWidth`/`resizedHeight` as "the size while the controls are hidden",
  // so leaving them behind would make the two surfaces disagree about whether a
  // size is stored the moment either one restores.
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
  // Floors and default come from `GRAPHIC_EQ_MONITOR_BOX` in `./monitor-box.ts` —
  // ONE source shared with the card — rather than re-typed here. On this
  // surface they size the PICTURE (there is no card chrome and no xyflow node to
  // resize), which is the meaning shift that file's own comment records.
  let boxW = $derived<number>(
    Math.max(
      GRAPHIC_EQ_MONITOR_BOX.minW,
      (patch.nodes[nodeId]?.data?.resizedWidth as number | undefined) ?? GRAPHIC_EQ_MONITOR_BOX.defW,
    ),
  );
  let boxH = $derived<number>(
    Math.max(
      GRAPHIC_EQ_MONITOR_BOX.minH,
      (patch.nodes[nodeId]?.data?.resizedHeight as number | undefined) ?? GRAPHIC_EQ_MONITOR_BOX.defH,
    ),
  );

  /** The canvas backing store, in CSS px. MONITOR mode is the only state that
   *  is user-sized; at rest the fleet preview size applies. */
  let viewW = $derived(monitor ? boxW : RESTING_W);
  let viewH = $derived(monitor ? boxH : RESTING_H);

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

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
      const w = Math.max(GRAPHIC_EQ_MONITOR_BOX.minW, Math.round(w0 + (e.clientX - startX)));
      const h = Math.max(GRAPHIC_EQ_MONITOR_BOX.minH, Math.round(h0 + (e.clientY - startY)));
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
  // ⚠ THE REASON HERE IS AN ACCUMULATOR **AND** THE OUTPUT — and this file is
  // where the fleet's two arguments meet, so do NOT copy reshaper's wording into
  // it. Reshaper and ruttetra argue that they have NO accumulator (no `uTime`,
  // no ping-pong; `draw` re-renders from the input texture every frame and would
  // resume instantly), and that only the OUTPUT is at stake. That claim is FALSE
  // on this module, checked in `graphicEq.ts` rather than assumed:
  //
  //   * `peakL[]` / `peakR[]` are PER-BAND PEAK-HOLD STATE, advanced exactly
  //     once per draw by `decayPeak(prev, current, params.peak)`. The caps are a
  //     function of every frame since the last transient, not of this one.
  //   * the two `AnalyserNode`s carry `smoothingTimeConstant = 0.7`, which is
  //     itself a temporal average over the frames that were actually read.
  //
  // So a lapsed watch mark does not merely pause a picture that would resume
  // identically — it corrupts what the meters MEAN. The caps stop falling and
  // freeze wherever they were, the smoothing history goes stale, and the frame
  // that reappears asserts peaks that belong to whenever the mark expired. That
  // is `grainsOfVision`/`bentbox`'s case, arrived at independently.
  //
  // The OUTPUT argument holds on top of it and is the more pointed one for a
  // CHAINABLE `output`-category module whose whole point is that `out` feeds
  // something downstream: a rack where this face is the only observer and `out`
  // runs into a recorder, a second dock pane or a not-yet-opened downstream
  // still gets frames.
  //
  // ⚠ AND THAT IS WHY THIS FACE TAKES NO VRT SCENE ARGUMENT FROM ITS SIBLINGS.
  // "It settles because it has no clock" is what posterbox/tiler/sourcery/
  // onetonine could say; this one cannot. Its determinism, if any, has to be
  // argued from the AudioContext being suspended with nothing patched — which is
  // a different claim and is measured in the scene roster, not asserted here.
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

<div class="geq-output" class:monitor data-testid="graphicEq-output-body">
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
        data-testid="graphicEq-face-canvas"
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
      data-testid="graphicEq-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the preview off to reclaim its space. The module keeps rendering."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>

    <button
      type="button"
      class="face-btn monitor-btn nodrag"
      class:on={monitor}
      onclick={toggleMonitor}
      data-testid="graphicEq-face-monitor-toggle"
      aria-pressed={monitor}
      title="MONITOR: hide the control bands and give the picture the whole plate. Drag the corner to size it."
    >MONITOR {monitor ? 'ON' : 'OFF'}</button>

    <!-- The corner drag, present ONLY in MONITOR mode — the same condition the
         card applies (its resize handle is inside the `{#if hideControls}`
         branch), so `video-hide-controls.spec.ts`'s "resize handle absent by
         default" assertion means the same thing on both surfaces. -->
    {#if monitor && !previewCollapsed}
      <div
        class="resize-handle nodrag"
        role="separator"
        aria-label="Resize the GRAPHIC EQ monitor"
        data-testid="graphicEq-face-resize-handle"
        onpointerdown={onResizeStart}
      ></div>
    {/if}
  </div>
</div>

<style>
  .geq-output {
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
  .geq-output.monitor .screen-btn { right: 22px; }
  /* Left corner, so the two switches never overlap at the narrowest monitor
     width (`GRAPHIC_EQ_MONITOR_BOX.minW` = 360 px). */
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
