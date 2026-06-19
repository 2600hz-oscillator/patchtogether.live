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
  // FULLSCREEN: the popup is opened at the target screen's working-area rect, so
  // it already covers display 2 — but a popup window still shows the OS titlebar
  // + the thin browser strip at the top. To get ACTUAL full screen we request
  // fullscreen on this document: best-effort on open (works when the popup keeps
  // the opener's transient activation) and, as a fallback, on the first click /
  // key in the popup (requestFullscreen is user-gesture-gated). A small hint
  // tells the user to click if the auto-attempt was blocked; it hides once we're
  // actually fullscreen.
  //
  // Handshake (same-origin, opener ↔ popup):
  //   1. On mount we postMessage `present:ready` to the opener.
  //   2. The opener finds our <canvas> (data-testid=present-canvas), gets its
  //      2D context, and starts drawing the source canvas into it each frame.

  import { onMount, onDestroy } from 'svelte';

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  // True once the popup is actual-fullscreen (no OS titlebar / browser strip).
  let isFs = $state(false);

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

  /** Go true-fullscreen so the popup loses the titlebar + the thin browser strip
   *  at the top. Best-effort: requestFullscreen is gesture-gated, so a rejection
   *  is fine — the click hint covers it. */
  async function goFullscreen(): Promise<void> {
    if (typeof document === 'undefined' || document.fullscreenElement) return;
    const root = document.documentElement as HTMLElement & {
      requestFullscreen?: (o?: FullscreenOptions) => Promise<void>;
    };
    try {
      await root.requestFullscreen?.({ navigationUI: 'hide' });
    } catch {
      /* gesture-gated / unsupported — the click hint covers it */
    }
  }
  function onFsChange(): void {
    isFs = !!document.fullscreenElement;
    sizeCanvas(); // entering/leaving fullscreen resizes the viewport
  }
  function onUserGesture(): void {
    void goFullscreen();
  }
  /** The opener may DELEGATE its transient activation to us (Capability
   *  Delegation API) so we can go fullscreen with no click on the projector. */
  function onOpenerMessage(ev: MessageEvent): void {
    if (ev.origin !== window.location.origin) return;
    const d = ev.data as { type?: string } | null;
    if (d?.type === 'present:go-fullscreen') void goFullscreen();
  }

  onMount(() => {
    sizeCanvas();
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFsChange);
    // First click / key ANYWHERE in the popup → fullscreen (covers the
    // gesture-gated case + lets the user re-enter after pressing Esc). Pure
    // sink, so any input maps cleanly to "go fullscreen".
    window.addEventListener('pointerdown', onUserGesture);
    window.addEventListener('keydown', onUserGesture);
    // The opener delegates fullscreen activation to us once it sees us ready.
    window.addEventListener('message', onOpenerMessage);
    // Best-effort immediate attempt (popups opened from a click often still hold
    // transient activation for a beat).
    void goFullscreen();
    // Tell the opener we're ready to be drawn into (and to delegate fullscreen).
    if (window.opener) {
      try {
        window.opener.postMessage({ type: 'present:ready' }, window.location.origin);
      } catch {
        /* opener gone / cross-origin — nothing to do */
      }
    }
  });

  onDestroy(() => {
    if (typeof window === 'undefined') return;
    window.removeEventListener('resize', onResize);
    document.removeEventListener('fullscreenchange', onFsChange);
    window.removeEventListener('pointerdown', onUserGesture);
    window.removeEventListener('keydown', onUserGesture);
    window.removeEventListener('message', onOpenerMessage);
  });
</script>

<svelte:head>
  <title>present</title>
</svelte:head>

<div class="present-root" data-testid="present-root">
  <canvas bind:this={canvasEl} class="present-canvas" data-testid="present-canvas"></canvas>
  {#if !isFs}
    <div class="fs-hint" data-testid="present-fs-hint">⛶ click anywhere for full screen</div>
  {/if}
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
  /* Prominent, PERSISTENT affordance shown until we're actually fullscreen — a
     popup's requestFullscreen is gesture-gated, so when auto/delegated entry is
     blocked the operator needs a clear, lasting "click for fullscreen" cue (the
     old 4s-fade hint vanished before it was noticed). Centred + large so it
     reads across the room on a projector; a gentle pulse draws the eye. */
  .fs-hint {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    padding: 14px 26px;
    font: 600 22px/1.2 system-ui, sans-serif;
    letter-spacing: 0.04em;
    color: rgba(255, 255, 255, 0.92);
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.35);
    border-radius: 12px;
    pointer-events: none;
    animation: fs-hint-pulse 1.8s ease-in-out infinite;
  }
  @keyframes fs-hint-pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
  }
</style>
