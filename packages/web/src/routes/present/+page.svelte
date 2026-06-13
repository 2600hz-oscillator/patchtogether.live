<script lang="ts">
  // /present — the second-display SINK for "present an OUTPUT on a second
  // display". A black, chrome-less page that fills its viewport with a single
  // <video> (object-fit: contain, black letterbox) fed a live MediaStream
  // captured from an OUTPUT card's canvas in the OPENER window.
  //
  // This page is intentionally a PURE SINK: no app shell, no audio/video
  // engine, no Y.Doc. It only displays the stream its opener hands it. That
  // keeps display-2 lightweight (one decode, no second engine) while the
  // patcher keeps running interactively in the main window on display 1.
  //
  // Handshake (same-origin, opener ↔ popup):
  //   1. On mount we postMessage `present:ready` to the opener.
  //   2. The opener assigns the MediaStream to `window.__presentStream` (a
  //      stream can't be structured-cloned through postMessage) and posts
  //      `present:stream-ready`.
  //   3. We read `window.__presentStream`, set it as the <video>.srcObject,
  //      mute + play, and best-effort requestFullscreen() on this display.
  //
  // Autoplay/fullscreen may require a user gesture (browser policy). If
  // play()/requestFullscreen() reject without one, we surface a tiny
  // "Click to present" affordance; the click is the gesture that starts both.

  import { onMount, onDestroy } from 'svelte';

  let videoEl = $state<HTMLVideoElement | null>(null);
  let stream = $state<MediaStream | null>(null);
  // Shown when autoplay/fullscreen needs a user gesture, or while we wait for
  // the opener to deliver the stream.
  let needsGesture = $state(false);
  let waiting = $state(true);

  // Same-origin handle the opener stashes the stream on (structured clone
  // can't carry a MediaStream). Typed locally to avoid `any`.
  interface PresentWindow extends Window {
    __presentStream?: MediaStream;
  }

  /** Attach the delivered stream to the <video>, mute + play, then best-effort
   *  fullscreen. Any policy rejection flips `needsGesture` so the click
   *  affordance can retry from inside a user gesture. */
  async function attachAndPlay(): Promise<void> {
    const s = (window as PresentWindow).__presentStream ?? null;
    if (!s || !videoEl) return;
    stream = s;
    waiting = false;
    videoEl.srcObject = s;
    videoEl.muted = true; // display 2 is video-only; audio stays on display 1.
    try {
      await videoEl.play();
      needsGesture = false;
    } catch {
      // Autoplay blocked — need a gesture.
      needsGesture = true;
    }
    // Best-effort fullscreen of the whole page on THIS display. The popup was
    // already placed on the target screen by the opener, so plain fullscreen
    // here lands on the right monitor.
    void requestFs();
  }

  async function requestFs(): Promise<void> {
    const el = document.documentElement;
    if (typeof el.requestFullscreen !== 'function') return;
    try {
      await el.requestFullscreen();
    } catch {
      // Fullscreen needs a gesture — surface the affordance (play may already
      // be running, but we keep the click path available for fullscreen).
      needsGesture = true;
    }
  }

  /** The click affordance handler — a guaranteed user gesture, so retry both
   *  play() and requestFullscreen(). */
  async function onGesture(): Promise<void> {
    if (!videoEl) return;
    try {
      await videoEl.play();
    } catch {
      /* keep the affordance up if it still fails */
    }
    await requestFs();
    // Hide the affordance once we're actually playing.
    if (!videoEl.paused) needsGesture = false;
  }

  function onMessage(ev: MessageEvent): void {
    // Same-origin only.
    if (ev.origin !== window.location.origin) return;
    const data = ev.data as { type?: string } | null;
    if (data?.type === 'present:stream-ready') {
      void attachAndPlay();
    }
  }

  onMount(() => {
    window.addEventListener('message', onMessage);
    // Tell the opener we're ready to receive the stream.
    if (window.opener) {
      try {
        window.opener.postMessage({ type: 'present:ready' }, window.location.origin);
      } catch {
        /* opener gone / cross-origin — nothing to do */
      }
    }
    // The opener may have set __presentStream before our listener attached
    // (fast popup). Poll briefly so we don't miss it.
    const t = setInterval(() => {
      if ((window as PresentWindow).__presentStream && !stream) {
        void attachAndPlay();
      }
      if (stream) clearInterval(t);
    }, 100);
    // Stop polling after 10s regardless (opener never delivered).
    const stopPoll = setTimeout(() => clearInterval(t), 10_000);
    return () => {
      clearInterval(t);
      clearTimeout(stopPoll);
    };
  });

  onDestroy(() => {
    if (typeof window !== 'undefined') window.removeEventListener('message', onMessage);
    // Detach so the decoder releases the stream when the popup closes.
    if (videoEl) videoEl.srcObject = null;
  });
</script>

<svelte:head>
  <title>present</title>
</svelte:head>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  class="present-root"
  data-testid="present-root"
  onclick={onGesture}
  role="presentation"
>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    bind:this={videoEl}
    class="present-video"
    data-testid="present-video"
    autoplay
    muted
    playsinline
  ></video>

  {#if waiting}
    <div class="affordance" data-testid="present-waiting">waiting for stream…</div>
  {:else if needsGesture}
    <div class="affordance" data-testid="present-gesture">
      click to present · press Esc to exit
    </div>
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
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .present-video {
    width: 100%;
    height: 100%;
    /* contain: never crop the source; black letterbox on the short axis. */
    object-fit: contain;
    background: #000;
    display: block;
  }
  .affordance {
    position: absolute;
    bottom: 6%;
    left: 50%;
    transform: translateX(-50%);
    color: rgba(255, 255, 255, 0.78);
    background: rgba(0, 0, 0, 0.55);
    padding: 8px 16px;
    border-radius: 6px;
    font:
      0.9rem/1.2 ui-sans-serif,
      system-ui,
      sans-serif;
    letter-spacing: 0.03em;
    pointer-events: none;
    user-select: none;
  }
</style>
