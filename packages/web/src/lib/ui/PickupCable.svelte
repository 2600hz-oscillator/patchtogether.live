<script lang="ts">
  // Ghost cable rendered while pickup mode is active.
  //
  // When the user single-clicks a port (without dragging past the
  // connectionDragThreshold), Svelte Flow's clickConnect machinery stores
  // the source handle internally and waits for a target-handle click. To
  // make the gesture visible, we render an SVG bezier from the source
  // port's screen position to the live cursor — a "sticky" cable that
  // follows the cursor until commit (target click) or cancel (Esc).
  //
  // Why a sibling SVG instead of extending xyflow's connectionLine? The
  // xyflow connection-line only renders while connection.inProgress is
  // true (i.e. during a drag). It is NOT rendered for click-connect.
  // Adding a separate sibling lets us own the pickup-cable styling and
  // lifecycle without forking xyflow.

  import { Position, getBezierPath } from '@xyflow/system';
  import { connectDragState } from '$lib/ui/connect-drag-state.svelte';

  let path = $derived.by(() => {
    const cursor = connectDragState.pickupCursor;
    const source = connectDragState.pickupSource;
    if (!cursor || !source) return '';
    // VIRTUAL-PORT pickup (workflow assets picker & friends): no canvas
    // handle exists — the ghost hangs from the fixed screen-space anchor
    // (the clicked menu row) and drops DOWN toward the cursor.
    const virtual = connectDragState.pickupVirtual;
    if (virtual) {
      const [d] = getBezierPath({
        sourceX: virtual.anchor.x,
        sourceY: virtual.anchor.y,
        sourcePosition: Position.Bottom,
        targetX: cursor.x,
        targetY: cursor.y,
        targetPosition: Position.Left,
      });
      return d;
    }
    // Look up the source handle's screen position by data-id selector.
    // We search by [data-handleid] within the source nodeId's
    // .svelte-flow__node — works for both PatchPanel-mounted handles
    // (after they've been re-measured) and directly-rendered handles.
    const nodeEl = document.querySelector(
      `.svelte-flow__node[data-id="${source.nodeId}"]`,
    );
    if (!nodeEl) {
      // DOCK-HOSTED fallback: a PINNED drawer/panel card has NO canvas
      // element at all (no stub, no handles), so a pickup started from its
      // port rows / back jacks rendered no ghost. Hang the cable from the
      // matching edge of the card's dock frame instead. Docked NON-pinned
      // cards keep anchoring at their canvas stub (found above) — the
      // documented cable-anchor model.
      const dockEl = document.querySelector(
        `[data-dock-card="${CSS.escape(source.nodeId)}"] [data-dock-card-frame]`,
      );
      if (!dockEl) return '';
      const frame = dockEl.getBoundingClientRect();
      const fromRight = source.handleType === 'source';
      const [d] = getBezierPath({
        sourceX: fromRight ? frame.right : frame.left,
        sourceY: frame.y + frame.height / 2,
        sourcePosition: fromRight ? Position.Right : Position.Left,
        targetX: cursor.x,
        targetY: cursor.y,
        targetPosition: fromRight ? Position.Left : Position.Right,
      });
      return d;
    }
    // Prefer the handle matching the gesture's side (source vs target)
    // because some cards have both source + target handles with the
    // same handleId (rare but possible).
    const matchClass = source.handleType === 'source' ? 'source' : 'target';
    const handles = nodeEl.querySelectorAll(
      `.svelte-flow__handle[data-handleid="${source.portId}"]`,
    );
    let handleEl: Element | null = null;
    for (const h of handles) {
      if (h.classList.contains(matchClass)) {
        handleEl = h;
        break;
      }
    }
    if (!handleEl) handleEl = handles[0] ?? null;
    if (!handleEl) return '';
    const box = handleEl.getBoundingClientRect();
    const sx = box.x + box.width / 2;
    const sy = box.y + box.height / 2;
    const sourcePosition =
      source.handleType === 'source' ? Position.Right : Position.Left;
    const targetPosition =
      source.handleType === 'source' ? Position.Left : Position.Right;
    const [d] = getBezierPath({
      sourceX: sx,
      sourceY: sy,
      sourcePosition,
      targetX: cursor.x,
      targetY: cursor.y,
      targetPosition,
    });
    return d;
  });

  let cableColor = $derived.by(() => {
    const t = connectDragState.pickupSource?.cableType ?? 'audio';
    return `var(--cable-${t}, var(--cable-audio))`;
  });
</script>

{#if connectDragState.mode === 'pickup' && !connectDragState.cableHidden && path}
  <svg
    class="pickup-cable"
    data-testid="pickup-cable"
    aria-hidden="true"
  >
    <path d={path} fill="none" stroke={cableColor} stroke-width="2" stroke-dasharray="4 4" />
  </svg>
{/if}

<style>
  .pickup-cable {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 1002;
  }
</style>
