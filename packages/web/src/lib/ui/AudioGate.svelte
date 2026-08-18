<script lang="ts">
  // Audio gate overlay. Renders a translucent notice whenever the shared
  // AudioContext isn't `running`. The first real user gesture ANYWHERE in the
  // document resumes the context (booting the engine via the gate's registered
  // booter if needed) and the notice fades out. Solves Chrome's autoplay policy
  // on cold loads + post-F5 reloads, where the Yjs doc is correct but no user
  // gesture has been observed yet so AudioContext.resume() would no-op.
  //
  // Mounted near <Canvas /> in `/r/[id]/+page.svelte` AND `/rack/+page.svelte`.
  // Which routes must mount it is not a matter of memory: it is derived from
  // "every route that renders Canvas" and asserted in
  // `routes/canvas-routes-audio-gate.test.ts`.
  //
  // Single-tab/session — once resumed, the AudioContext stays running for the
  // remainder of the session (modulo the browser auto-suspending on background
  // tabs, which the statechange listener detects and which re-raises this).
  //
  // ── ⚠ "CLICK ANYWHERE" IS LITERAL, AND THAT IS LOAD-BEARING (#1826) ────────
  //
  // This used to be a MODAL scrim: `role="button"`, `tabindex=0`, an `onclick`
  // on the full-viewport div. It sat at `inset: 0; z-index: 1000` and SWALLOWED
  // the click — the user's first click enabled audio and did nothing else, so
  // aiming at a knob cost two clicks.
  //
  // That was survivable while the overlay lived only on `/r/[id]`. Mounting it
  // on `/rack` — the default route, and the one essentially the whole test suite
  // drives — made it a click trap over the entire app until dismissed: MEASURED,
  // 29 e2e tests across 13 spec files failed outright, every one of them a
  // click that the scrim intercepted rather than a behavior that changed.
  //
  // A prompt reading "Click anywhere to enable audio" that also EATS the click
  // is the defect, not the tests. So the overlay is now inert to pointer input
  // (`pointer-events: none`, no role, no tabindex) and the resume is driven off
  // a WINDOW-level first-gesture listener instead. One click now enables audio
  // AND does what the user aimed at.
  //
  // Nothing is lost in the trade: the click path, the keyboard path, and the
  // "any interaction dismisses it" contract all still hold — they are simply
  // sourced from the window rather than from a div that has to be hit first.
  import type { AudioGate } from '$lib/audio/audio-gate.svelte';

  interface Props {
    gate: AudioGate;
  }
  let { gate }: Props = $props();

  // Show the overlay whenever audio isn't running. We deliberately don't
  // distinguish "never booted" from "suspended after backgrounding" — both
  // need the same one-gesture resume path, and a unified UI is simpler.
  let visible = $derived(!gate.running);

  // FIRST-GESTURE RESUME. Listeners live on `window` in the CAPTURE phase and
  // only while the overlay is up:
  //
  //   * capture — a canvas/card handler calling stopPropagation() on pointerdown
  //     (xyflow does this on drags) must not be able to hide the gesture from us.
  //   * `pointerdown` rather than `click` — it fires at the START of the
  //     interaction, so a click-and-drag on a knob unlocks audio for the drag it
  //     is beginning rather than at its end.
  //   * scoped to `visible` — once audio runs there is nothing to listen for,
  //     and a permanently-attached window listener on the app's busiest event is
  //     not free.
  //
  // ⚠ `resume()` awaits, which outlives TRANSIENT user activation — that is
  // fine and is what the old onclick handler did too: Chrome gates AudioContext
  // on STICKY activation (`hasBeenActive`), which never expires for the document.
  $effect(() => {
    if (!visible) return;
    const onGesture = (): void => {
      void gate.resume();
    };
    const opts = { capture: true } as const;
    window.addEventListener('pointerdown', onGesture, opts);
    window.addEventListener('keydown', onGesture, opts);
    // Some touch surfaces dispatch touchstart without a preceding pointerdown.
    window.addEventListener('touchstart', onGesture, opts);
    return () => {
      window.removeEventListener('pointerdown', onGesture, opts);
      window.removeEventListener('keydown', onGesture, opts);
      window.removeEventListener('touchstart', onGesture, opts);
    };
  });
</script>

{#if visible}
  <!-- `role="status"` + aria-live: this is a NOTICE now, not a control. It is
       inert to pointer and keyboard input (see the block comment) — the thing
       that dismisses it is any interaction with the app behind it, so there is
       nothing here to focus or activate. -->
  <div class="audio-gate" role="status" aria-live="polite" data-testid="audio-gate">
    <div class="audio-gate-inner">
      <div class="audio-gate-title">Click anywhere to enable audio</div>
      <div class="audio-gate-subtitle">
        {#if gate.busy}
          Starting audio…
        {:else if gate.error}
          {gate.error}
        {:else}
          Browser autoplay policy requires a click before sound can play.
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .audio-gate {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(14, 17, 22, 0.78);
    backdrop-filter: blur(2px);
    color: var(--text);
    user-select: none;
    transition: opacity 220ms ease-out;
    animation: audio-gate-fade-in 180ms ease-out;
    /* ⚠ THE OVERLAY MUST NOT EAT THE CLICK IT IS ASKING FOR. It spans the whole
       viewport above the canvas, so anything but `none` here makes the app
       unreachable until dismissed — see the #1826 note in the script block. The
       gesture is picked up by a window-level capture listener instead. */
    pointer-events: none;
  }
  .audio-gate-inner {
    text-align: center;
    padding: 24px 32px;
    border: 1px solid #2a2f3a;
    border-radius: 8px;
    background: rgba(20, 23, 28, 0.9);
    max-width: 420px;
  }
  .audio-gate-title {
    font-size: 1.05rem;
    font-weight: 500;
    margin-bottom: 8px;
  }
  .audio-gate-subtitle {
    font-size: 0.8rem;
    color: var(--text-dim);
  }
  @keyframes audio-gate-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
