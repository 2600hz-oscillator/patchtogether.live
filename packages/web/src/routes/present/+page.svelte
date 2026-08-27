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
  async function goFullscreen(): Promise<string | null> {
    if (typeof document === 'undefined' || document.fullscreenElement) return null;
    const root = document.documentElement as HTMLElement & {
      requestFullscreen?: (o?: FullscreenOptions) => Promise<void>;
    };
    try {
      await root.requestFullscreen?.({ navigationUI: 'hide' });
      return null;
    } catch (e) {
      // Report rather than swallow. A silent catch here cost two wrong
      // diagnoses of why an F5 lands windowed while a fresh load does not.
      const err = e as { name?: string; message?: string };
      return `${err?.name ?? 'Error'}: ${err?.message ?? String(e)}`;
    }
  }

  /** Surface a sink-side failure in the OPENER's console — the popup's own
   *  devtools are impractical to reach on a projector. */
  function reportToOpener(detail: string): void {
    try {
      window.opener?.postMessage(
        { type: 'present:fs-report', detail },
        window.location.origin,
      );
    } catch {
      /* opener gone */
    }
  }
  /** Keep asking for a short window rather than accepting the first refusal.
   *
   *  With the Automatic Fullscreen content setting granted (Chrome 126 / Edge
   *  132) a request needs no gesture — but a request issued while window.open
   *  is still sizing and placing this popup can still be refused, and nothing
   *  retried it. Measured on the owner's rig: "load performance" and a fresh
   *  browser load both came up fullscreen first try, a plain F5 did not, with
   *  the permission reporting `granted` in all three. The operator then has to
   *  walk to the projector and click it, which is the whole complaint.
   *
   *  Stops the moment we are fullscreen, so a user who presses Esc inside the
   *  window keeps their exit — the loop is already finished by then. */
  async function goFullscreenPersistently(): Promise<void> {
    let last: string | null = null;
    // MEASURED on the owner's rig (Edge 151 / macOS, F5 with a projector
    // attached): entered on attempt 10, ~1.35s in.
    //
    // ⚠ THE focus() CALL IS THE LOAD-BEARING PART, not the retry count. A
    // 12-attempt (~1.65s) loop WITHOUT focus() had already been tried and still
    // landed windowed — it reached that same point in time and was refused. So
    // what unblocks this is the window being focused, not more waiting: an F5
    // leaves focus on the patcher, and Chromium refuses fullscreen from an
    // unfocused window even with Automatic Fullscreen granted.
    //
    // The retry is still required (10 attempts, so one shot cannot work —
    // focus() does not take effect synchronously). 40 is ~4x the observed need,
    // as headroom for a slower machine or a longer Space animation; it costs
    // nothing when the first attempt succeeds, which is every non-F5 path.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (document.fullscreenElement) {
        if (attempt > 0) reportToOpener(`fullscreen entered on attempt ${attempt + 1}`);
        return;
      }
      try { window.focus(); } catch { /* focus is best-effort */ }
      last = await goFullscreen();
      if (document.fullscreenElement) {
        if (attempt > 0) reportToOpener(`fullscreen entered on attempt ${attempt + 1}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    reportToOpener(`fullscreen NOT entered after 40 attempts; last error = ${last ?? 'none (request resolved but no fullscreenElement)'}`);
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
    if (d?.type === 'present:go-fullscreen') void goFullscreenPersistently();
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
    // Best-effort immediate attempt, then keep trying briefly — see
    // goFullscreenPersistently for why one shot is not enough.
    void goFullscreenPersistently();
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
