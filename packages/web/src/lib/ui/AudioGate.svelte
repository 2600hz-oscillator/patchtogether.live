<script lang="ts">
  // Audio gate overlay. Renders a translucent click target whenever the
  // shared AudioContext isn't `running`. On click, resumes the context
  // (booting the engine via the gate's registered booter if needed) and
  // fades out. Solves Chrome's autoplay policy on cold loads + post-F5
  // reloads of /r/[id], where the Yjs doc is correct but no user gesture
  // has been observed yet so AudioContext.resume() would no-op.
  //
  // Mounted near <Canvas /> in /r/[id]/+page.svelte. Single-tab/session
  // overlay — once the user clicks it, the AudioContext stays running for
  // the remainder of the session (modulo the browser auto-suspending on
  // background tabs, which the statechange listener detects).
  import type { AudioGate } from '$lib/audio/audio-gate.svelte';

  interface Props {
    gate: AudioGate;
  }
  let { gate }: Props = $props();

  // Show the overlay whenever audio isn't running. We deliberately don't
  // distinguish "never booted" from "suspended after backgrounding" — both
  // need the same one-click resume path, and a unified UI is simpler.
  let visible = $derived(!gate.running);

  async function onClick() {
    await gate.resume();
  }

  // Allow keyboard activation (Enter / Space) so screen-reader users can
  // dismiss without a pointer. Tabindex=0 + role=button below.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void gate.resume();
    }
  }
</script>

{#if visible}
  <div
    class="audio-gate"
    role="button"
    tabindex="0"
    aria-label="Click anywhere to enable audio"
    onclick={onClick}
    onkeydown={onKeyDown}
    data-testid="audio-gate"
  >
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
    cursor: pointer;
    user-select: none;
    transition: opacity 220ms ease-out;
    animation: audio-gate-fade-in 180ms ease-out;
  }
  .audio-gate:focus-visible {
    outline: 2px solid var(--cable-cv);
    outline-offset: -4px;
  }
  .audio-gate-inner {
    pointer-events: none;
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
