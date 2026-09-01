<script lang="ts">
  // packages/web/src/lib/ui/modules/skifree/SkifreeTileBody.svelte
  //
  // The SKIFREE LANE TILE's picture.
  //
  // ⚠ WITHOUT THIS THE PROMOTED TILE IS A TITLE BAR AND FOUR JACKS. skifree
  // declares `params: []`, so `curatedFace` resolves zero cells at every lane
  // tier, and `glyph: 'none'` is FORCED (no `type: 'audio'` output, and
  // `hasVideoSurface` is `domain === 'video'` while this is an audio def with a
  // video PORT) — so the shell has nothing of its own to paint here. On a
  // module whose entire purpose is a game you watch, that tile would be worse
  // than the placeholder it replaces, which is the #1974 bar in substance even
  // though the clause SKIPS an `order: []` face by construction. Nothing else
  // in CI would notice this file disappearing; `skifree-face-model.test.ts`
  // pins its existence for that reason.
  //
  // ⚠ READ-ONLY, AND THAT IS THE POINT OF SPLITTING THE TWO SLOTS. A lane tile
  // and an open dock pane for the same node are mounted AT THE SAME TIME, so a
  // steerable tile would be a second surface writing one cursor — and a 104 px
  // picture is a glance ("is it still alive, and where is the yeti"), not an
  // instrument. Steering lives in `SkifreeSlopeBody` alone.
  //
  // The SCREEN switch is likewise dock-only: the tile has no room for it (the
  // slot is 192x180 for the whole tile, title bar and jack rail included) and
  // the dock is one click away. The tile HONOURS `node.data.previewCollapsed`,
  // so turning the slope off in the dock turns it off here too — one flag, two
  // surfaces, no way for them to disagree.
  import SkifreeScreen from './SkifreeScreen.svelte';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** Sized for the 192x180 lane slot with the title bar and the jack rail
   *  already spent. A genuine downscale of the 320 (or 640, on a retina
   *  display) source — which is why the shared blit names its destination rect
   *  and turns smoothing off rather than trusting a coincidence. */
  const TILE_SLOPE_PX = 104;
</script>

<div class="skifree-tile" data-testid="skifree-tile-host">
  <SkifreeScreen {nodeId} size={TILE_SLOPE_PX} testidPrefix="skifree-tile" />
</div>

<style>
  .skifree-tile {
    width: 100%;
    display: flex;
    justify-content: center;
    padding: 0 4px 2px;
    box-sizing: border-box;
  }
</style>
