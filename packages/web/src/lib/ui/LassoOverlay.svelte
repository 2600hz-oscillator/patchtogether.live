<script lang="ts">
  // Lasso overlay — fixed-position rectangle that tracks the cursor while
  // the user is in "Create group" lasso mode. The parent (Canvas.svelte) owns
  // the state machine; this component is pure presentation.

  interface Props {
    /** Anchor point (where the user clicked "Create group"), client px. */
    origin: { x: number; y: number };
    /** Live cursor position, client px. */
    cursor: { x: number; y: number };
  }

  let { origin, cursor }: Props = $props();

  let left = $derived(Math.min(origin.x, cursor.x));
  let top = $derived(Math.min(origin.y, cursor.y));
  let width = $derived(Math.abs(cursor.x - origin.x));
  let height = $derived(Math.abs(cursor.y - origin.y));
</script>

<div
  class="lasso-overlay"
  data-testid="lasso-overlay"
  style:left="{left}px"
  style:top="{top}px"
  style:width="{width}px"
  style:height="{height}px"
></div>

<style>
  .lasso-overlay {
    position: fixed;
    z-index: 150;
    pointer-events: none;
    border: 1px dashed var(--accent, #60a5fa);
    background: rgba(96, 165, 250, 0.08);
    border-radius: 2px;
  }
</style>
