<script lang="ts">
  // Shared BREATHE button + percent fader for all 5 sequencer cards.
  //
  // BREATHE alternates inhale/exhale Euclidean gate-density mutations on each
  // loop wrap. The button is a binary on/off toggle; the fader sets the
  // fraction of gates flipped per breath (0..1, default 0.25).
  //
  // The card owns the patch read/write — this component is presentation only.
  // It emits onToggleEnabled() + onSetPercent(v) and reads `enabled` + `percent`
  // from props.
  import Fader from './Fader.svelte';

  interface Props {
    /** Card / module instance id — used to scope test IDs across multiple
     *  sequencer modules on the same canvas. */
    nodeId: string;
    enabled: boolean;
    percent: number;
    onToggleEnabled: () => void;
    onSetPercent: (v: number) => void;
  }

  let { nodeId, enabled, percent, onToggleEnabled, onSetPercent }: Props = $props();
</script>

<div class="breathe-row" data-testid={`breathe-row-${nodeId}`}>
  <button
    type="button"
    class="breathe-btn"
    class:on={enabled}
    data-testid={`breathe-toggle-${nodeId}`}
    data-breathe-enabled={enabled ? '1' : '0'}
    title={enabled ? 'BREATHE on — gate density oscillates each loop pass' : 'BREATHE off'}
    onclick={onToggleEnabled}
  >BRTH</button>
  <Fader
    value={percent}
    min={0}
    max={1}
    defaultValue={0.25}
    label="%"
    curve="linear"
    onchange={onSetPercent}
  />
</div>

<style>
  .breathe-row {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding-left: 8px;
  }
  .breathe-btn {
    height: 22px;
    min-width: 38px;
    padding: 0 6px;
    background: #14171c;
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 0.62rem;
    cursor: pointer;
    line-height: 1;
  }
  .breathe-btn.on {
    background: var(--cable-gate);
    color: #1a1d23;
    border-color: var(--cable-gate);
  }
  .breathe-btn:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
</style>
