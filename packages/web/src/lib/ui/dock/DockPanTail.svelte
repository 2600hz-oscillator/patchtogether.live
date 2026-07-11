<script lang="ts" module>
  /** One tail: a docked-with-edges node's stub (world space) → its rail
   *  card (screen space). Built ONCE at gesture start by Canvas — the rail
   *  end is fixed for the whole gesture, only the stub end re-projects. */
  export interface DockTailSpec {
    nodeId: string;
    /** Stub anchor in FLOW coordinates (stub top-left + face-center offset).
     *  Projected to screen px per gesture frame via `toScreen`. */
    flow: { x: number; y: number };
    /** Rail-card anchor in SCREEN px (gBCR edge-center, measured at gesture
     *  start — rails are viewport-fixed, so it cannot move mid-gesture). */
    rail: { x: number; y: number };
    /** Zone the rail sits in — orients the bezier's control handles. */
    zone: 'top' | 'left' | 'bottom' | 'right';
  }
</script>

<script lang="ts">
  // DockPanTail — the SCREEN-SPACE cable tail (P2.5b; recommendation §2.4
  // "the tail" graft). During a canvas pan/zoom GESTURE, edges to a docked
  // module ride the world-space viewport with the stub while the rail card
  // stays screen-fixed — the accepted drift. This overlay bridges that gap
  // VISUALLY: one lightweight bezier per docked-with-edges node, from the
  // stub's current (transformed) position to the rail card's fixed anchor.
  //
  //  * PickupCable pattern: a sibling fixed SVG in client coordinates —
  //    zero xyflow forking, zero flowNodes churn.
  //  * Endpoints are STORE-DERIVED: the stub end goes through xyflow's
  //    flowToScreenPosition (same-frame viewport math, drift-free mid-pan),
  //    re-run per gesture frame via the `tick` prop Canvas bumps in onmove.
  //    The rail end is measured once at gesture start (it can't move).
  //  * PRESENTATION-ONLY, forever: pointer-events none, no hover/select/
  //    delete — all interaction stays on the real world-space edge, so the
  //    global.css z-order/hover contract is never re-implemented.
  //  * Lifecycle: Canvas mounts tails on onmovestart and KILLS them on
  //    onmoveend (drift ends, stub edges snap back under their rail) —
  //    zero DOM and zero per-frame work while no gesture is active or when
  //    no docked node has edges.

  import { Position, getBezierPath } from '@xyflow/system';

  interface Props {
    /** The gesture's tails (empty ⇒ this component renders nothing). */
    tails: DockTailSpec[];
    /** flowApi.flowToScreenPosition — the store-derived projection. */
    toScreen: (p: { x: number; y: number }) => { x: number; y: number };
    /** Version tick bumped by Canvas per onmove frame — the ONLY per-frame
     *  reactivity driver (tails/toScreen stay identity-stable). */
    tick: number;
  }
  let { tails, toScreen, tick }: Props = $props();

  /** Stub-side bezier direction: the tail leaves the stub TOWARD its rail. */
  const STUB_SIDE: Record<DockTailSpec['zone'], Position> = {
    top: Position.Top,
    left: Position.Left,
    bottom: Position.Bottom,
    right: Position.Right,
  };
  /** Rail-side direction: the tail enters the card from the canvas side. */
  const RAIL_SIDE: Record<DockTailSpec['zone'], Position> = {
    top: Position.Bottom,
    left: Position.Right,
    bottom: Position.Top,
    right: Position.Left,
  };

  let paths = $derived.by(() => {
    void tick; // re-project the stub end every gesture frame
    return tails.map((t) => {
      const s = toScreen(t.flow);
      const [d] = getBezierPath({
        sourceX: s.x,
        sourceY: s.y,
        sourcePosition: STUB_SIDE[t.zone],
        targetX: t.rail.x,
        targetY: t.rail.y,
        targetPosition: RAIL_SIDE[t.zone],
      });
      return { id: t.nodeId, d };
    });
  });
</script>

{#if paths.length > 0}
  <svg class="dock-pan-tail" data-testid="dock-pan-tail" aria-hidden="true">
    {#each paths as p (p.id)}
      <path class="dock-pan-tail-path" data-tail-node={p.id} d={p.d} />
    {/each}
  </svg>
{/if}

<style>
  .dock-pan-tail {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    /* Above the canvas + top/left rails (15/16) so the tip landing on the
       rail card's inner edge stays visible; below menus/toasts. The bottom
       drawer (z 30) may clip the last few px of a bottom tail — fine, the
       endpoint is exactly at its top edge. */
    z-index: 25;
  }
  .dock-pan-tail-path {
    fill: none;
    stroke: var(--accent, #00f0ff);
    stroke-width: 1.5;
    stroke-dasharray: 6 4;
    opacity: 0.55;
  }
</style>
