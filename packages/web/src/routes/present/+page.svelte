<script lang="ts">
  // /present — the second-display SINK for "present an OUTPUT on a second
  // display". A black, chrome-less page that fills its viewport with a single
  // <canvas> the OPENER draws the live OUTPUT frame into, every frame.
  //
  // This page is intentionally a PURE SINK: no app shell, no audio/video
  // engine, no Y.Doc, no MediaStream, no <video>. It only exposes a plain
  // <canvas> sized to the viewport. The opener (same-origin) reaches this
  // window's DOM directly and runs a requestAnimationFrame loop that
  // letterbox-`drawImage`s the OUTPUT card's source canvas into it. That keeps
  // display-2 lightweight (no decode, no second engine, no autoplay/gesture
  // policy) while the patcher keeps running interactively in the main window on
  // display 1.
  //
  // Why a direct blit instead of captureStream → <video>.srcObject? A
  // cross-realm MediaStream set as a popup <video>'s srcObject frequently won't
  // render, and autoplay()/requestFullscreen() are user-gesture-gated — both
  // produced a black popup on real dual-monitor hardware. The popup is already
  // opened at the target screen's full working-area rect, so it already covers
  // display 2; no fullscreen is needed at all.
  //
  // Handshake (same-origin, opener ↔ popup):
  //   1. On mount we postMessage `present:ready` to the opener.
  //   2. The opener finds our <canvas> (data-testid=present-canvas), gets its
  //      2D context, and starts drawing the source canvas into it each frame.

  import { onMount, onDestroy } from 'svelte';

  let canvasEl = $state<HTMLCanvasElement | null>(null);

  /** Size the canvas backing store to the viewport (× DPR for crisp output).
   *  The opener reads canvas.width/height to compute the letterbox fit, so this
   *  must stay correct across resizes. */
  function sizeCanvas(): void {
    if (!canvasEl) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(2, Math.round(window.innerWidth * dpr));
    const h = Math.max(2, Math.round(window.innerHeight * dpr));
    if (canvasEl.width !== w) canvasEl.width = w;
    if (canvasEl.height !== h) canvasEl.height = h;
  }

  function onResize(): void {
    sizeCanvas();
  }

  onMount(() => {
    sizeCanvas();
    window.addEventListener('resize', onResize);
    // Tell the opener we're ready to be drawn into.
    if (window.opener) {
      try {
        window.opener.postMessage({ type: 'present:ready' }, window.location.origin);
      } catch {
        /* opener gone / cross-origin — nothing to do */
      }
    }
  });

  onDestroy(() => {
    if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
  });
</script>

<svelte:head>
  <title>present</title>
</svelte:head>

<div class="present-root" data-testid="present-root">
  <canvas bind:this={canvasEl} class="present-canvas" data-testid="present-canvas"></canvas>
</div>

<style>
  /* Pure black, chrome-less sink filling the popup viewport. */
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: #000;
    overflow: hidden;
  }
  .present-root {
    position: fixed;
    inset: 0;
    background: #000;
  }
  .present-canvas {
    display: block;
    width: 100%;
    height: 100%;
    background: #000;
  }
</style>
