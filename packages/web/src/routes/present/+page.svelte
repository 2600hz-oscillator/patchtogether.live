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
  //      2D context, and installs `window.__presentFrame` here.
  //   3. Our rAF pulls that function every frame (#2235 — the SINK owns the
  //      clock) and READS WHAT IT RETURNS. A frame that painted no source
  //      pixels, or a frame function that has vanished, is reported on screen
  //      instead of leaving the last good frame up forever. See
  //      $lib/ui/modules/present-link for the state machine and why every
  //      threshold is counted in SINK FRAMES rather than milliseconds.

  import { onMount, onDestroy } from 'svelte';
  import {
    type PresentLinkMonitor,
    type PresentLinkState,
    type PresentPullSample,
    createPresentLinkMonitor,
  } from '$lib/ui/modules/present-link';
  import { testHooksEnabled } from '$lib/dev/test-hooks';

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let pullRaf: number | null = null;
  // True once the popup is actual-fullscreen (no OS titlebar / browser strip).
  let isFs = $state(false);
  // A fullscreen retry loop is in flight (plain state — nothing renders it).
  let fsLoopActive = false;

  // ── THE LINK MONITOR ──────────────────────────────────────────────────────
  // The sink used to own ONLY the clock: it called `window.__presentFrame?.()`
  // and never learned anything back. So the two states a performer most needs
  // told apart — "my source is drawing" and "my source is gone" — looked
  // identical from here, and the visible result of the second was a FROZEN LAST
  // FRAME: bright, plausible, and wrong, on a wall, in front of an audience.
  //
  // The opener now returns a per-frame status (PresentPullStatus). This derives
  // link health from it in SINK FRAMES — no wall clock, because the projector's
  // frame rate is whatever the venue's hardware says it is.
  // Unarmed until mount proves this sink was opened BY something: a /present
  // tab a human opened by hand has no source to lose, and telling its viewer
  // the link is lost would be a lie about a link that never existed.
  let link: PresentLinkMonitor = createPresentLinkMonitor({ armed: false });
  let linkState = $state<PresentLinkState>('waiting');
  /** Which (node, display) this sink serves, from `?slot=`. Shown in the
   *  disconnect notice so a four-projector rig knows WHICH one dropped. */
  let slot = $state('');

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
  /** Machine-readable fullscreen state for the opener (fs-report above is the
   *  human console line). `entered:false` ARMS the opener's next-gesture
   *  delegation; `entered:true` disarms it. Sent from the retry loop's
   *  failures and from an actual fullscreen ENTRY — deliberately NOT from an
   *  operator's focused Esc, which must stay respected (see onFsChange). */
  function reportFsState(entered: boolean, permission?: string): void {
    try {
      window.opener?.postMessage(
        { type: 'present:fs-state', entered, permission },
        window.location.origin,
      );
    } catch {
      /* opener gone */
    }
  }
  /** What the browser says about the Automatic Fullscreen content setting.
   *  'granted' is what made the gesture-less loop below work on Edge ≤151 with
   *  the AutomaticFullscreenAllowedForUrls policy applied; 'denied' means the
   *  loop cannot ever succeed on its own and only a gesture (delegated or in
   *  this window) will. Best-effort: the descriptor is Chromium-only. */
  async function automaticFullscreenPermission(): Promise<string> {
    try {
      const status = await navigator.permissions.query({
        name: 'fullscreen',
        allowWithoutGesture: true,
      } as unknown as PermissionDescriptor);
      return status.state;
    } catch {
      return 'unavailable';
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
    // ONE loop at a time. Both onMount and the opener's delegated
    // go-fullscreen call this; stacking a second 40-attempt loop is what
    // printed the owner's failure line TWICE per toggle.
    if (fsLoopActive) return;
    fsLoopActive = true;
    try {
      await runFullscreenLoop();
    } finally {
      fsLoopActive = false;
    }
  }
  async function runFullscreenLoop(): Promise<void> {
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
      if (attempt === 0 && last) {
        // The FIRST refusal, reported separately from the retries: without an
        // automatic-fullscreen grant every gesture-less attempt fails the same
        // way, and burying that behind the 40-attempt summary cost a day of
        // diagnosis. The fs-state post is also what ARMS the opener's
        // next-gesture delegation, so the fix starts here, not at attempt 40.
        reportToOpener(`fullscreen blocked on first attempt: ${last}`);
        const permission = await automaticFullscreenPermission();
        reportFsState(false, permission);
        if (permission === 'denied') {
          // DETERMINISTIC refusal: with the automatic-fullscreen permission
          // denied and no gesture, the remaining 39 attempts produce 39
          // identical rejections (measured on the owner's rig — Edge 152,
          // AutomaticFullscreenAllowedForUrls wiped: two full loops of
          // "TypeError: Permissions check failed"). The retry loop below is
          // for the GRANTED-but-refused-while-sizing/focusing case only.
          // Stop; the opener prints the one actionable advisory and arms the
          // next patcher gesture, and a click/key here still works.
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    reportToOpener(
      `fullscreen NOT entered after 40 attempts; last error = ${last ?? 'none (request resolved but no fullscreenElement)'}; automatic-fullscreen permission = ${await automaticFullscreenPermission()}`,
    );
    reportFsState(false);
  }

  /**
   * THE PROJECTOR'S OWN FRAME CLOCK (#2235).
   *
   * The opener installs `window.__presentFrame` and this pulls it. It used to
   * be the other way round — the opener ran the rAF and pushed pixels in — and
   * that made the projector a hostage of the patcher window's focus: Chrome
   * throttles rAF in an unfocused window, so the recorder's directory picker,
   * a permission prompt or any OS dialog froze every output instantly.
   *
   * This window is the one on the projector and is always visible, so its clock
   * keeps running regardless. The frame function still executes in the OPENER's
   * realm (same-origin) — the engine work did not move, only the timing.
   */
  function pullFrames(): void {
    pullRaf = requestAnimationFrame(pullFrames);
    const host = window as Window & {
      __presentFrame?: () => { painted?: number; errors?: number } | void;
    };
    let sample: PresentPullSample = { sourcePresent: false };
    try {
      const frame = host.__presentFrame;
      if (typeof frame === 'function') {
        const status = frame();
        sample = {
          sourcePresent: true,
          painted: status?.painted,
          errors: status?.errors,
        };
      }
    } catch {
      // The opener is mid-teardown — skip this frame, keep the loop alive. It
      // counts as a MISSING source, not a healthy one: a throwing frame
      // function is exactly the case that used to leave a frozen picture up.
      sample = { sourcePresent: false };
    }
    const next = link.tick(sample);
    // Assigning the same value is a no-op in Svelte 5, so the projector does no
    // reactive work per frame — only on an actual state change.
    linkState = next;
    publishStats();
  }

  /** Receiver-side counters for the continuity gate, under the SAME gate as
   *  every other Playwright hook. They are diagnostics, never the assertion:
   *  the gate reads PIXELS off this canvas and uses these to say WHY. */
  function publishStats(): void {
    if (!testHooksEnabled()) return;
    (window as unknown as { __presentStats?: unknown }).__presentStats = {
      state: link.state,
      ticks: link.ticks,
      painted: link.painted,
      errors: link.errors,
      ticksSincePaint: link.ticksSincePaint,
      everPainted: link.everPainted,
      slot,
    };
  }

  function onFsChange(): void {
    isFs = !!document.fullscreenElement;
    sizeCanvas(); // entering/leaving fullscreen resizes the viewport
    // Entering fullscreen stands the opener's next-gesture delegation down.
    // An EXIT deliberately posts nothing here: a focused Esc is the operator's
    // and must not be undone by their next patcher click — the unfocused
    // (modal-stolen) exit below re-arms via the retry loop's own failure
    // reports instead.
    if (document.fullscreenElement) reportFsState(true);
    // ⚠ RECOVER FROM A MODAL THAT TOOK OUR FULLSCREEN (#2235). Chrome resolves
    // any modal browser surface by EXITING fullscreen, and the recorder's
    // directory picker is one — so a projector silently dropped to a windowed
    // popup mid-set with nothing to re-enter it.
    //
    // `document.hasFocus()` is the discriminator, and it is an honest one: an
    // Esc can only be pressed in a window that HAS focus, while a modal in the
    // patcher takes ours away. So an unfocused exit was done TO us and we undo
    // it; a focused exit was the operator and we respect it.
    if (!document.fullscreenElement && !document.hasFocus()) {
      void goFullscreenPersistently();
    }
  }
  function onUserGesture(): void {
    void goFullscreen();
  }
  /** The opener may DELEGATE its transient activation to us (Capability
   *  Delegation API) so we can go fullscreen with no click on the projector. */
  function onOpenerMessage(ev: MessageEvent): void {
    if (ev.origin !== window.location.origin) return;
    const d = ev.data as { type?: string } | null;
    if (d?.type === 'present:go-fullscreen') {
      // The delegated activation token is short-lived and single-use: spend it
      // NOW on a direct attempt — a loop already in flight would spend it too
      // (≤150ms later), but only if it survives that long. Then make sure a
      // loop is running to mop up if the token was refused (no-op if active).
      void goFullscreen();
      void goFullscreenPersistently();
    }
  }

  onMount(() => {
    // `?slot=` is the sink's identity, written by startPresent. It is what lets
    // a native shell's window-open handler tell an output slot's sink from a
    // patch's restored projector — they are otherwise the same URL, the same
    // window name and the same feature string.
    try {
      slot = new URL(window.location.href).searchParams.get('slot') ?? '';
    } catch {
      slot = '';
    }
    // ARM only when something opened us. `window.opener` is the honest test:
    // every projector session has one, and a hand-opened /present tab does not.
    link = createPresentLinkMonitor({ armed: window.opener != null });
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
    pullFrames();
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
    if (pullRaf !== null) cancelAnimationFrame(pullRaf);
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

<div
  class="present-root"
  data-testid="present-root"
  data-link-state={linkState}
  data-slot={slot}
>
  <canvas bind:this={canvasEl} class="present-canvas" data-testid="present-canvas"></canvas>
  {#if !isFs}
    <div class="fs-hint" data-testid="present-fs-hint">⛶ click anywhere for full screen</div>
  {/if}
  <!-- THE PROJECTOR SAYS WHEN IT IS DEAD. Without this, a lost or stalled link
       shows the LAST GOOD FRAME forever — a picture that looks alive to the room
       and to the operator across the venue, which is strictly worse than a
       closed window. A corner strip rather than a full-screen takeover: if the
       link recovers, the show was never covered up. -->
  {#if linkState === 'lost' || linkState === 'stalled'}
    <div class="link-notice" data-testid="present-link-notice" role="status" aria-live="polite">
      {linkState === 'lost' ? 'SOURCE DISCONNECTED' : 'NO PICTURE FROM SOURCE'}
      {#if slot}<span class="slot">· {slot}</span>{/if}
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
  /* Bottom-left, deliberately NOT centred and NOT full-bleed: it must be
     unmissable to anyone looking for it and must not become the show. */
  .link-notice {
    position: fixed;
    left: 18px;
    bottom: 18px;
    padding: 8px 14px;
    font: 600 15px/1.2 ui-monospace, monospace;
    letter-spacing: 0.08em;
    color: #ffd9d9;
    background: rgba(60, 8, 8, 0.86);
    border: 1px solid rgba(255, 120, 120, 0.6);
    border-radius: 6px;
    pointer-events: none;
  }
  .link-notice .slot {
    opacity: 0.75;
    font-weight: 400;
  }
</style>
