<script lang="ts">
  // packages/web/src/lib/ui/modules/mandelbulb/MandelbulbOutputBody.svelte
  //
  // The MANDELBULB dock full-view body: the ray-marched preview, the SCREEN
  // ON/OFF switch the 2026-08-18 owner ruling requires of every video module,
  // and the SLICE WAVEFORM readout — the module's audio half made visible.
  //
  // ⚠ WHY THIS FILE EXISTS (#1928 class). `MandelbulbCard.svelte` owns BOTH
  // pictures, and promotion is exactly what stops that card rendering. The
  // second picture is the load-bearing one: with SLICE on, `audio_out` plays
  // the bulb's cross-section as a 256-sample wavetable, and this trace is the
  // only way to SEE the waveform you are hearing.
  //
  // ⚠ TWO SCREEN CONTROLS, AND THEY ARE NOT DUPLICATES — see the face block on
  // the def for the full argument. In short: `screen_on` is a PARAM and is
  // product behaviour (at 0 the factory skips the raymarch, but only while
  // `video_out` is unpatched, so it can never starve a consumer); the switch
  // below is `node.data.previewCollapsed`, pure view layer, and is the
  // fleet-standard affordance. This body honours BOTH — it collapses on
  // `previewCollapsed`, and it paints the module's own SCREEN OFF panel when
  // the PARAM is off, exactly as the card does.
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
  let sliceCanvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ⚠ STATE ON THE NODE, NOT IN THE COMPONENT — this unmounts on dock collapse
  // / LRU eviction (#1531 / #1574 / #1583), and `node.data` is what survives a
  // tab switch, a remount, a reload and collab sync. Same `previewCollapsed`
  // key every other video body uses: a different key would silently re-open
  // every preview collapsed before this promotion. Absent ⇒ false ⇒ ON.
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

  /** Paint the module's own SCREEN-OFF panel — the `screen_on` PARAM being 0,
   *  which is a different thing from the preview being collapsed. Mirrors the
   *  card's flat panel so the two surfaces agree. */
  function paintScreenOff(ctx2d: CanvasRenderingContext2D, w: number, h: number): void {
    ctx2d.fillStyle = '#0a0c12';
    ctx2d.fillRect(0, 0, w, h);
    ctx2d.fillStyle = 'rgba(255,255,255,0.35)';
    ctx2d.font = '11px monospace';
    ctx2d.fillText('SCREEN OFF', 10, 20);
  }

  /**
   * The SLICE waveform — READ, never re-derived.
   *
   * ⚠ THE COST IS THE WHOLE REASON THIS READS A SEAM. `mbSampleSlice` is
   * MB_SLICE_SIZE(256) rays x MB_RAY_STEPS(64) = 16 384 `jsDistanceEstimate`
   * calls per recompute, ON THE MAIN THREAD. The engine already runs it to feed
   * the oscillator, and `MandelbulbCard.svelte` runs it a SECOND time to draw
   * its own readout — so a slice move costs 2x today. Deriving it a third time
   * here would make it 3x. `read('sliceWave')` returns the copy the engine
   * retained before transferring the buffer to the worklet, so this trace is
   * free.
   *
   * ⚠ AND `read('slice')` IS NOT THIS. That key returns the slice TOGGLE STATE
   * (a boolean). The queue spec for this module said to use it to avoid
   * re-deriving the waveform, which would have drawn a boolean.
   */
  function drawSliceReadout(videoEngine: VideoEngine): void {
    if (!sliceCanvasEl) return;
    const ctx2d = sliceCanvasEl.getContext('2d');
    if (!ctx2d) return;
    const W = sliceCanvasEl.width;
    const H = sliceCanvasEl.height;
    let wave: Float32Array | null = null;
    try { wave = (videoEngine.read(nodeId, 'sliceWave') as Float32Array | null) ?? null; }
    catch { wave = null; }

    ctx2d.fillStyle = '#0a0c12';
    ctx2d.fillRect(0, 0, W, H);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx2d.beginPath();
    ctx2d.moveTo(0, H / 2);
    ctx2d.lineTo(W, H / 2);
    ctx2d.stroke();
    // Null until SLICE has been on at least once — the centre line alone is the
    // honest picture of "no cross-section has been read yet".
    if (wave && wave.length > 1) {
      ctx2d.strokeStyle = '#ffd83a';
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      const n = wave.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * W;
        const yv = H / 2 - (wave[i] ?? 0) * (H / 2) * 0.92;
        if (i === 0) ctx2d.moveTo(x, yv); else ctx2d.lineTo(x, yv);
      }
      ctx2d.stroke();
    }
  }

  // ⚠ SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK (#1937 / #2015).
  // `blitOutputForPreview` IS the engine's "someone is watching" signal — it
  // calls `markWatched` itself (`video/engine.ts:1679`) — and a node is a pull
  // root only while that mark is younger than `WATCH_TTL_MS = 1500`. A
  // collapsed state that merely stopped blitting would drop the node out of the
  // pull set: the toggle would become a PRODUCER KILL SWITCH wherever nothing
  // downstream is watching. That is the #1720/#1721 class the ruling names.
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

    // The slice trace is independent of the picture — it is the AUDIO half, and
    // it stays live even with the raymarch gated off by `screen_on`.
    try { drawSliceReadout(videoEngine); } catch { /* never nuke the rAF loop */ }

    if (!canvasEl) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      // The `screen_on` PARAM — product behaviour, distinct from the collapse.
      let screenOn = true;
      try { screenOn = videoEngine.read(nodeId, 'screenOn') !== false; }
      catch { screenOn = true; }
      if (!screenOn) {
        paintScreenOff(ctx2d, cw, ch);
        rafId = requestAnimationFrame(draw);
        return;
      }
      // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
      let blitted = false;
      try { blitted = videoEngine.blitOutputForPreview(nodeId); }
      catch { /* never nuke the rAF loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
      const src = videoEngine.canvas as CanvasImageSource;
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

<div class="mb-output" data-testid="mandelbulb-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        class="mb-canvas"
        data-testid="mandelbulb-face-canvas"
        data-node-id={nodeId}
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="mandelbulb-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the preview is collapsed and its space reclaimed. MANDELBULB keeps rendering: switching it back on shows the LIVE picture, not a stale frame. (The SCREEN control in the CAMERA band is a different thing: it gates the raymarch itself.)'
        : 'SCREEN — turn the preview off to collapse it and reclaim the vertical space. The module goes on rendering either way. (The SCREEN control in the CAMERA band is a different thing: it gates the raymarch itself.)'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>
  {#if !previewCollapsed}
    <canvas
      bind:this={sliceCanvasEl}
      width={480}
      height={72}
      class="mb-slice"
      data-testid="mandelbulb-face-slice-readout"
    ></canvas>
  {/if}
</div>

<style>
  .mb-output {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px 0 2px;
  }
  /* The switch OVERLAYS the picture's corner so it costs zero layout height —
     standard corner chrome, matching every other faced video module. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone and without a floor
       the wrap would collapse and take the absolute button with it. */
    min-height: 18px;
  }
  .mb-canvas {
    display: block;
    border-radius: 3px;
    background: #050608;
    max-width: 100%;
    height: auto;
  }
  .mb-slice {
    display: block;
    width: 100%;
    max-width: 480px;
    height: auto;
    border-radius: 2px;
    border: 1px solid var(--border);
    background: #0a0c12;
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
