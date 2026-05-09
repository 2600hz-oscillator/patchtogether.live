<script lang="ts">
  // Shared "QUICKSAVE" + 1-4 slot buttons + SAVE/LOAD/QUEUE mode buttons +
  // PLAY / RESET. Used by Sequencer / DRUMSEQZ / SCORE cards.
  //
  // Spec: .myrobots/plans/sequencer-transport-and-quicksave.md
  //
  // The component is "controlled": parent passes the slot map + pendingMode
  // + queuedSlot + isPlaying via props, and receives action callbacks. The
  // parent's onSlotClick handler resolves what the click means (save / load
  // / queue) by reading pendingMode itself — this component just reports
  // "user clicked slot N" and "user armed mode M".
  import {
    type SlotKey,
    type SlotMap,
    type PendingMode,
    SLOT_KEYS,
  } from '$lib/audio/modules/transport-helpers';

  interface Props {
    /** Used in test selectors: `quicksave-{kind}-{nodeId}-{N}`. */
    nodeId: string;
    slots: SlotMap;
    pendingMode: PendingMode;
    /** Slot waiting to load on next sequence-end (pulses). */
    queuedSlot: SlotKey | null;
    /** Slot that was most recently loaded (subtle outline). */
    lastLoadedSlot: SlotKey | null;
    isPlaying: boolean;
    onSetMode: (mode: PendingMode) => void;
    onSlotClick: (slot: SlotKey) => void;
    onPlayToggle: () => void;
    onReset: () => void;
  }

  const {
    nodeId,
    slots,
    pendingMode,
    queuedSlot,
    lastLoadedSlot,
    isPlaying,
    onSetMode,
    onSlotClick,
    onPlayToggle,
    onReset,
  }: Props = $props();

  function isModeActive(m: 'save' | 'load' | 'queue'): boolean {
    return pendingMode === m;
  }

  function slotHasData(k: SlotKey): boolean {
    return slots[k] !== null;
  }

  function toggleMode(m: 'save' | 'load' | 'queue') {
    onSetMode(pendingMode === m ? null : m);
  }
</script>

<div class="qs-row" data-testid={`quicksave-${nodeId}`}>
  <span class="qs-label">QUICKSAVE</span>

  {#each SLOT_KEYS as k (k)}
    <button
      type="button"
      class="qs-slot"
      class:has-data={slotHasData(k)}
      class:queued={queuedSlot === k}
      class:last-loaded={lastLoadedSlot === k}
      data-testid={`quicksave-slot-${nodeId}-${k}`}
      data-slot={k}
      data-has-data={slotHasData(k) ? 'true' : 'false'}
      data-queued={queuedSlot === k ? 'true' : 'false'}
      title={slotHasData(k) ? `Slot ${k} (filled)` : `Slot ${k} (empty)`}
      onclick={() => onSlotClick(k)}
    >{k}</button>
  {/each}

  <div class="qs-modes">
    <button
      type="button"
      class="qs-mode"
      class:active={isModeActive('save')}
      data-testid={`quicksave-mode-save-${nodeId}`}
      title="Arm SAVE — next 1-4 click writes the current pattern into that slot"
      onclick={() => toggleMode('save')}
    >SAVE</button>
    <button
      type="button"
      class="qs-mode"
      class:active={isModeActive('load')}
      data-testid={`quicksave-mode-load-${nodeId}`}
      title="Arm LOAD — next 1-4 click instantly switches to that pattern"
      onclick={() => toggleMode('load')}
    >LOAD</button>
    <button
      type="button"
      class="qs-mode"
      class:active={isModeActive('queue')}
      data-testid={`quicksave-mode-queue-${nodeId}`}
      title="Arm QUEUE — next 1-4 click queues that pattern to play at end of current sequence"
      onclick={() => toggleMode('queue')}
    >QUEUE</button>
  </div>

  <div class="qs-transport">
    <button
      type="button"
      class="qs-transport-btn"
      class:playing={isPlaying}
      data-testid={`quicksave-play-${nodeId}`}
      title={isPlaying ? 'Stop' : 'Play'}
      onclick={onPlayToggle}
    >{isPlaying ? '■ STOP' : '▶ PLAY'}</button>
    <button
      type="button"
      class="qs-transport-btn"
      data-testid={`quicksave-reset-${nodeId}`}
      title="Reset playhead to step 0"
      onclick={onReset}
    >⟲ RESET</button>
  </div>
</div>

<style>
  .qs-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 22px;
    flex-wrap: wrap;
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
  }
  .qs-label {
    color: var(--text-dim);
    letter-spacing: 0.08em;
    margin-right: 2px;
  }
  .qs-slot {
    width: 22px;
    height: 22px;
    background: #14171c;
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.7rem;
    line-height: 1;
    padding: 0;
  }
  .qs-slot.has-data {
    color: var(--cable-pitch);
    border-color: var(--cable-pitch);
  }
  .qs-slot.last-loaded {
    box-shadow: 0 0 0 1px var(--accent-dim) inset;
  }
  .qs-slot.queued {
    background: var(--cable-gate);
    color: #1a1d23;
    border-color: var(--cable-gate);
    animation: qs-pulse 0.9s ease-in-out infinite;
  }
  @keyframes qs-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
  .qs-slot:hover {
    border-color: var(--accent-dim);
    color: var(--text);
  }
  .qs-modes,
  .qs-transport {
    display: flex;
    gap: 3px;
    margin-left: 4px;
  }
  .qs-mode,
  .qs-transport-btn {
    height: 22px;
    background: #14171c;
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.65rem;
    line-height: 1;
    padding: 0 6px;
  }
  .qs-mode.active {
    border-color: var(--accent);
    color: var(--accent);
    background: rgba(0, 240, 255, 0.08);
  }
  .qs-mode:hover,
  .qs-transport-btn:hover {
    border-color: var(--accent-dim);
    color: var(--text);
  }
  .qs-transport-btn.playing {
    background: var(--cable-gate);
    color: #1a1d23;
    border-color: var(--cable-gate);
  }
</style>
