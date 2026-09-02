<script lang="ts">
  // packages/web/src/lib/ui/modules/moog956/Moog956TileBody.svelte
  //
  // THE 956's LANE STRIP — the same playable ribbon, tile-sized, where a
  // player normally meets the module.
  //
  // ⚠ WITHOUT IT THE PROMOTION LOSES HALF THE INSTRUMENT ON THE LANE, and the
  // arithmetic is the argument: `faceTierCap('compact', 'none')` is 3, so the
  // compact tile paints ranks 1-3 (`pos`, `scale`, `offset`) and `gate` — one
  // of this module's two OUTPUTS — falls off. A tile that can set a pitch and
  // not sound it is a controller you cannot play. Ranking `gate` into the top
  // three instead would only trade `offset` away AND would still split one
  // pointer stroke into two gestures, which is precisely what the strip exists
  // to keep whole. Same finding as skifree and audioIn: a module whose only
  // non-param control lives in the full view is unusable from the lane.
  //
  // ⚠ IT IS THE `fullViewBody`'s COUNTERPART, NEVER ITS SIBLING. `ModuleShell`
  // renders `tileBody` only `{#if !extBody}`, so exactly one of the two paints
  // per shell instance — but the lane tile and an open dock pane are two
  // instances for the SAME node, mounted at once, which is why the shared strip
  // takes a `testidPrefix` and this mount uses `moog956-tile-*`.
  //
  // ⚠ IT IS PLAYABLE, unlike skifree's read-only tile, and the difference is
  // real rather than an oversight: skifree's two surfaces would fight over ONE
  // cursor steering ONE game. A ribbon press is a discrete captured gesture on
  // a param — two strips over one node are no more contentious than two knobs,
  // and the shared `ribbon-actions` seam is what makes them agree.
  import Moog956RibbonStrip from './Moog956RibbonStrip.svelte';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();
</script>

<div
  class="tile-ribbon"
  role="group"
  aria-label="956 ribbon controller — press and slide to play"
  data-testid="moog956-tile-body"
>
  <Moog956RibbonStrip {nodeId} testidPrefix="moog956-tile" compact />
</div>

<style>
  .tile-ribbon {
    width: 100%;
    padding: 2px 4px 4px;
    box-sizing: border-box;
  }
</style>
