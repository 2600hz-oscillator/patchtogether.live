<script lang="ts">
  // VideoTileThumb — the LIVE ANIMATED VIDEO THUMBNAIL a video-domain module's
  // RACKLINE lane tile shows in its glyph slot under the `?shell=1` preview
  // (ModuleShellPlaceholder + ModuleShell), replacing the generic static wave
  // glyph that left no video visible anywhere (the owner regression).
  //
  // It REUSES the exact legacy on-card preview seam (VideoOutCard /
  // BackdraftCard / RecorderboxCard / 30+ cards): each tick it asks the engine
  // to render THIS node's surface FBO into the shared drawing buffer
  // (`videoEngine.blitOutputToDrawingBuffer(nodeId)` — which also marks the
  // node WATCHED for sink-driven pull evaluation) and `drawImage()`s the engine
  // canvas into a SMALL fixed-res 2D canvas, aspect-fit. No WebGL in the
  // component — the shell stays OUT of the WebGL attest basis.
  //
  // PERF (the synesthesia lazy-render lesson):
  //   - THUMBNAIL-RES + THROTTLED: a 160×120 buffer at VIDEO_THUMB_FPS (15) —
  //     the legacy cards run full-rAF card-sized previews; a ~170px tile well
  //     reads identically at quarter-ish res and keeps 30+ tiles cheap.
  //   - VISIBILITY-GATED: an IntersectionObserver on the canvas releases the
  //     tap entirely while the tile is off-screen/hidden — no rAF scheduled at
  //     all. Engine-side, the blit's markWatched TTL (~1.5s) + the central
  //     card-visibility feed (video-card-visibility.ts) then decay the chain
  //     out of the pull active set on their own.

  import { onMount } from 'svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { drawPreviewDownscaled } from './preview-downscale';
  import {
    VIDEO_THUMB_W,
    VIDEO_THUMB_H,
    VIDEO_THUMB_FPS,
    thumbFitRect,
  } from '$lib/ui/workflow/module-shell-model';

  interface Props {
    /** The module node whose surface FBO this thumbnail previews. */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  let canvasEl: HTMLCanvasElement | null = $state(null);

  onMount(() => {
    let rafId: number | null = null;
    let visible = false;
    let lastDraw = 0;
    const minFrameMs = 1000 / VIDEO_THUMB_FPS;

    const draw = (now: number) => {
      rafId = null;
      if (!visible) return; // released — the observer restarts us
      // Throttle to the thumbnail fps (rAF-aligned, skip early ticks).
      if (now - lastDraw < minFrameMs) {
        rafId = requestAnimationFrame(draw);
        return;
      }
      lastDraw = now;
      const e = engineCtx.get();
      const el = canvasEl;
      if (e && el) {
        let videoEngine: VideoEngine | undefined;
        try {
          videoEngine = e.getDomain<VideoEngine>('video');
        } catch {
          videoEngine = undefined;
        }
        if (videoEngine) {
          try {
            // ⚠ A NODE WITH NO OUTPUT TEXTURE MUST NOT SNAPSHOT THE SHARED
            // BUFFER — it would paint the LAST node that blitted into it.
            //
            // The two calls below are a blit into ONE drawing buffer the whole
            // engine shares, followed by a `drawImage` OF that buffer. When the
            // blit does nothing the `drawImage` still runs, so the tile shows
            // whichever node most recently succeeded. `blitOutputToDrawingBuffer`
            // does nothing exactly when `handle.surface.texture` is null, and it
            // returns `void`, so the snapshot cannot tell.
            //
            // MEASURED (2026-08-25, before this guard): a rack holding `shapes →
            // videoOut` plus an UNPATCHED `outToLaunch` painted the two tiles
            // byte-identically — mean 710.891875, max 765 on both — i.e. the
            // monitor tile showed the videoOut picture. `outToLaunch` is the one
            // video def in the fleet whose surface is `{ fbo: null, texture:
            // null }` (it is a SINK; its screen is 81 physical LEDs), so it is
            // the only module this has ever been reachable on — and for a video
            // module the picture IS its identity in a rack (owner, #1785), which
            // makes "somebody else's frame" the worst available answer.
            //
            // `outputTexture(nodeId)` is the public query for the same field the
            // blit tests, so the guard cannot drift from the condition it
            // guards. On a texture-less node the dark well below is the honest
            // picture, and it is DETERMINISTIC — which is also what lets
            // `face-outToLaunch-compact` be a real baseline instead of a mask.
            const hasPicture = videoEngine.outputTexture(nodeId) !== null;
            // The legacy preview seam: blit THIS node's FBO into the engine's
            // drawing buffer (marks it watched), then snapshot it. Never let an
            // engine hiccup kill the loop.
            videoEngine.blitOutputToDrawingBuffer(nodeId);
            const ctx2d = el.getContext('2d', { alpha: false });
            if (ctx2d) {
              ctx2d.fillStyle = '#050608';
              ctx2d.fillRect(0, 0, el.width, el.height);
              if (hasPicture) {
                const src = videoEngine.canvas as CanvasImageSource;
                const r = thumbFitRect(
                  videoEngine.canvas.width,
                  videoEngine.canvas.height,
                  el.width,
                  el.height,
                );
                drawPreviewDownscaled(ctx2d, src, r.x, r.y, r.w, r.h);
              }
            }
          } catch {
            /* engine mid-teardown — keep looping, next tick recovers */
          }
        }
      }
      rafId = requestAnimationFrame(draw);
    };

    const start = () => {
      if (rafId === null) rafId = requestAnimationFrame(draw);
    };
    const stop = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    // Visibility gate: tap active only while the tile canvas is on-screen.
    // Fail-open (always-on) where IntersectionObserver is unavailable (jsdom).
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined' && canvasEl) {
      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            visible = entry.isIntersecting;
            if (visible) start();
            else stop();
          }
        },
        // A small pre-wake margin so panning a tile into view never shows a
        // stale first frame (the central engine feed uses 300; the tap itself
        // stays tighter — it is per-tile work).
        { root: null, rootMargin: '100px' },
      );
      io.observe(canvasEl);
    } else {
      visible = true;
      start();
    }

    return () => {
      stop();
      io?.disconnect();
    };
  });
</script>

<canvas
  bind:this={canvasEl}
  class="video-tile-thumb"
  width={VIDEO_THUMB_W}
  height={VIDEO_THUMB_H}
  data-testid="video-tile-thumb"
  data-thumb-node={nodeId}
></canvas>

<style>
  .video-tile-thumb {
    display: block;
    width: 100%;
    height: 100%;
    /* Idle (engine not booted yet): the dark screen well, same family as the
     * legacy cards' canvas background — deterministic for VRT captures. */
    background: #050608;
    image-rendering: pixelated;
    object-fit: contain;
  }
</style>
