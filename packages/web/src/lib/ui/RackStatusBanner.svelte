<script lang="ts">
  // Rack durability status banner (persistence-hardening P1 + P2).
  //
  // PURELY PRESENTATIONAL: it renders exactly what the two status props say,
  // no timers/signals of its own. The /r/[id] page owns the state (replica
  // seed, provider synced/unsynced, offline timeout) and derives these props
  // via the pure helpers in `./rack-status`.
  //
  // CRITICAL — this is a NON-BLOCKING overlay, never a modal gate. It's
  // `position: fixed` with `pointer-events: none`, so an offline-with-local-
  // copy user (or anyone) can keep editing the canvas underneath the whole
  // time. It also sits BELOW the audio-gate overlay (z-index 1000).
  import type { RackStatus, SaveStatus } from './rack-status';

  interface Props {
    /** P1 — load/connectivity state: restoring | ready | offline. */
    status: RackStatus;
    /** P2 — ongoing-edit durability: saving | saved | idle. */
    saveStatus?: SaveStatus;
  }
  let { status, saveStatus = 'idle' }: Props = $props();

  // The connectivity banner outranks the save chip: while we're still
  // restoring or offline, that's the message that matters. Once ready, the
  // save chip takes over.
  let showConnectivity = $derived(status === 'restoring' || status === 'offline');
  let connectivityText = $derived(
    status === 'offline' ? 'Offline — working from your local copy' : 'Restoring…',
  );
  let showSave = $derived(
    !showConnectivity && (saveStatus === 'saving' || saveStatus === 'saved'),
  );
  let saveText = $derived(saveStatus === 'saving' ? 'Saving…' : 'All changes saved');
</script>

{#if showConnectivity}
  <div
    class="rack-status connectivity"
    class:offline={status === 'offline'}
    data-testid="rack-status-banner"
    data-status={status}
    role="status"
    aria-live="polite"
  >
    <span class="dot" class:pulse={status === 'restoring'} aria-hidden="true"></span>
    <span class="label">{connectivityText}</span>
  </div>
{:else if showSave}
  <div
    class="rack-status save"
    data-testid="rack-save-indicator"
    data-save-status={saveStatus}
    role="status"
    aria-live="polite"
  >
    <span class="dot" class:spin={saveStatus === 'saving'} aria-hidden="true"></span>
    <span class="label">{saveText}</span>
  </div>
{/if}

<style>
  /* Non-blocking toast anchored bottom-CENTER — clears SvelteFlow's zoom
     controls (bottom-left) and the feedback bug (bottom-right). pointer-
     events:none guarantees it NEVER intercepts a click meant for the canvas —
     editing stays live. */
  .rack-status {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: 12px;
    z-index: 900; /* below the audio-gate (1000) */
    pointer-events: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    border-radius: 4px;
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
    background: rgba(20, 23, 28, 0.92);
    border: 1px solid #2a2f3a;
    color: var(--text);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
    user-select: none;
    animation: rack-status-fade-in 160ms ease-out;
  }
  .rack-status.connectivity.offline {
    border-color: var(--cable-gate, #f97316);
    color: var(--cable-gate, #f97316);
  }
  .rack-status.save {
    color: var(--text-dim);
  }
  .dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.85;
    flex: 0 0 auto;
  }
  .dot.pulse {
    animation: rack-status-pulse 1.1s ease-in-out infinite;
  }
  .dot.spin {
    background: var(--cable-cv, #3b82f6);
    animation: rack-status-pulse 0.9s ease-in-out infinite;
  }
  .label {
    white-space: nowrap;
  }
  @keyframes rack-status-fade-in {
    from {
      opacity: 0;
      transform: translate(-50%, 4px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }
  @keyframes rack-status-pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .rack-status {
      animation: none;
    }
    .dot.pulse,
    .dot.spin {
      animation: none;
    }
  }
</style>
