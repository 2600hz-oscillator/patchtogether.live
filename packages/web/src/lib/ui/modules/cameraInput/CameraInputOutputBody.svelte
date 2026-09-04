<script lang="ts">
  // packages/web/src/lib/ui/modules/cameraInput/CameraInputOutputBody.svelte
  //
  // The CAMERA dock full-view body: the live picture and the SCREEN switch.
  //
  // The DEVICE PICKER, the capture LAMP and the ACQUIRE gesture moved to
  // `CameraSourceControls`, which this mounts and so does the LANE TILE. They
  // used to live here and ONLY here, so a player had to expand the module to
  // choose a camera or to start one at all — see that file's header.
  //
  // ⚠ THE PICTURE IS BLITTED FROM THE ENGINE AND THE `<video>` IS NEVER ADOPTED,
  // and that is the single most important line in this file. CAMERA's `<video>`
  // element is owned by the NODE and *adopted* into `CameraInputCard.svelte` at
  // runtime. A DOM node has exactly one parent — so a body that adopted it here
  // would STEAL it from the card, and the card is what owns `getUserMedia`, the
  // stream and the permission machine. "Port the card's preview" is the obvious
  // move and it would silently kill the capture the moment the dock opened.
  // `blitOutputForPreview` reads the module's own output texture instead, which
  // is what every other video face does anyway.
  //
  // ⚠ THE CARD IS STILL ALIVE, AND IS STILL THE ONLY OWNER — IT IS JUST NOT ON
  // SCREEN. Under the default shell the lane paints this module's faceplate and
  // the real card runs inside `<HeadlessSourceHost>`, parked at `left:-9999px`
  // with `pointer-events: none`. The STREAM is unaffected; every BUTTON the card
  // draws is unreachable. So this body is NOT a thin add-on to a visible card —
  // it is the only surface a player can touch, and it has to carry:
  //   * the DEVICE PICKER (below),
  //   * the ACQUIRE gesture — "Request access" / "Retry", the only route to
  //     getUserMedia for a visitor this origin has not granted before,
  //   * the capture LAMP, showing the card's REAL state rather than a guess,
  //   * and the card's RECOVERY TEXT, which is where the instructions live
  //     ("Grant in browser site settings", "Close other capture apps").
  //
  // ⚠ AND IT CARRIES THEM WITHOUT BECOMING A SECOND OWNER. `getUserMedia`, the
  // MediaStream and the permission state machine stay entirely on the card. This
  // body READS a published status and INVOKES a registered command through
  // `$lib/ui/media/camera-status-registry` — a remote control, not a second
  // machine. Two callers would be two owners, and whichever tore down last would
  // strand the survivor.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { cameraStatus, type CameraStatus } from '$lib/ui/media/camera-status-registry';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { drawPreviewDownscaled } from '../preview-downscale';
  import CameraSourceControls from './CameraSourceControls.svelte';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets. */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ── SCREEN, on the shared key ─────────────────────────────────────────────
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

  // ⚠ THE BODY STILL SUBSCRIBES, for its own LOCAL-ONLY hint below. The picker
  // component subscribes independently — `camera-status-registry` is pub/sub and
  // a second reader costs nothing, where threading one subscription through a
  // prop would couple two surfaces that are otherwise unrelated.
  let live = $state<CameraStatus | null>(null);

  $effect(() => {
    const id = nodeId;
    const sync = (): void => { live = cameraStatus.read(id); };
    sync();
    return cameraStatus.subscribe(id, sync);
  });

  // ── SCREEN OFF stops the COPY and keeps the WATCH MARK (#2015) ────────────
  //
  // ⚠ ON A CAPTURE SOURCE THIS IS THE WIDEST VERSION OF THE ARGUMENT. CAMERA has
  // no video input — it is the ORIGIN of whatever it feeds. A lapsed watch mark
  // drops the node from the pull set, so the switch would stop being a preview
  // control and become a MUTE for every consumer downstream. There is no
  // accumulator to lose (the picture is whatever the sensor last gave), so this
  // is the OUTPUT argument, not `vdelay`'s or `peakstate`'s.
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

  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div class="camera-output" data-testid="cameraInput-output-body">
  <!-- ⚠ THE SOURCE CONTROLS COME FIRST, ABOVE THE PICTURE, AND THE ORDER IS THE
       WHOLE FIX (owner P0, 2026-09-03: the CAMERA dock faceplate has "no device
       dropdown and no capture lamp").

       They used to sit at the END of this body, after a FIXED 480×360 canvas
       and the local-only hint. `.dock-faceplate` is correctly bounded
       (`max-height: min(60vh, 680px)`) and `.faceplate-scroll` is a real
       scroller — so nothing was clipped and nothing threw. What happened
       instead is that at 1280×720 (Playwright's `Desktop Chrome`, and roughly
       any laptop) the scroller shows 352 px of 648 px of content, and the
       picker row landed at document y≈789: 138 px below the scroller's visible
       bottom AND 69 px below the browser window. The player sees a band headed
       SOURCES and a picture, and the only route to `getUserMedia` this shell
       has is somewhere off the bottom of a scroll region inside a dock drawer.

       ⚠ AND THIS IS THE THIRD TIME THE SAME CLASS HAS SHIPPED. #2148 promoted
       the face and left the picker reachable only in the dock full view; #2242
       gave the lane tile its own copy; this one is the dock full view's copy
       being pushed off the bottom of its own surface. The invariant is not
       "the controls exist on this surface" — it is "the controls are ABOVE the
       picture", because the picture is the one element here whose height is
       fixed and large. Anything appended after it inherits this bug.

       ⚠ WHY NOT SHRINK THE CANVAS INSTEAD: a viewport-relative cap would make
       a VRT-baselined face's appearance a function of the capture viewport,
       and it would still leave the ordering that produced the defect. The
       param bands below stay scroll-reachable — that is the ordinary faceplate
       contract for tall content — but the ACQUIRE gesture may not be, because
       a source with no reachable way to start it is a dead module.

       The error / rebind prose travels with them: it is the text that tells a
       player what to DO about the state the lamp is reporting. -->
  <CameraSourceControls {nodeId} testidPrefix="cameraInput-face" />

  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        data-testid="cameraInput-face-canvas"
        data-node-id={nodeId}
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="cameraInput-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the camera preview is collapsed and its space reclaimed. CAPTURE KEEPS RUNNING and keeps feeding OUT: switching it back on shows the LIVE picture, not a stale frame.'
        : 'SCREEN — turn the camera preview off to collapse it and reclaim the vertical space. Capture goes on feeding OUT either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>

  {#if live?.state === 'streaming'}
    <!-- ⚠ THE LOCAL-ONLY HINT IS NOT DECORATION — it is the one place the app
         tells a player that a rack-mate cannot see these pixels. It lived on the
         card, which is off-screen under the shell, so it moved here with the
         rest. Shown only while streaming, exactly as the card shows it. -->
    <p class="local-only" data-testid="cameraInput-face-local-only">
      Local only — others won't see your camera stream
    </p>
  {/if}
</div>

<style>
  .camera-output {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — it OVERLAYS the picture's corner,
     so the body is exactly the height the picture is. See the OVERLAY paragraph
     in module-faceplates.md. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: without a floor the wrap collapses to
       zero and takes the absolutely-positioned button with it. */
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
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
  }
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }


  .local-only {
    margin: 0;
    font-size: 0.6rem;
    color: var(--text-dim);
    opacity: 0.6;
    text-align: center;
    line-height: 1.2;
    max-width: 480px;
  }
</style>
