<script lang="ts">
  // packages/web/src/lib/ui/modules/skifree/SkifreeSlopeBody.svelte
  //
  // The SKIFREE dock full-view body: the live slope, its SCREEN switch, and the
  // module's ONE direct-manipulation instrument — the mouse.
  //
  // ⚠ THIS IS THE ONLY SURFACE A PLAYER CAN STEER FROM. skifree declares
  // `params: []`, so there is no ranked cell anywhere and no `ParamCellKind`
  // mounts a canvas; without this slot a promoted skifree would be a game with
  // no controls and no picture. The lane's counterpart (`SkifreeTileBody`) is
  // deliberately read-only: two mounted steering surfaces would fight over one
  // cursor, and they CAN be mounted at once (a faced module's lane tile and its
  // open dock pane coexist).
  //
  // Everything else — the blit, the DPR crop fix, the pointer→cursor map, the
  // overlays, the lamps and the accessible name — lives in the shared
  // `SkifreeScreen`, so the two surfaces cannot show different pictures. Read
  // its header for the two shipping defects this promotion repairs.
  //
  // ⚠ SCREEN OFF IS NOT A KILL SWITCH HERE, and the reason is structural rather
  // than careful: the game is created in the module's FACTORY and its snapshot
  // is assembled on the shared SCHEDULER CLOCK, so collapsing the slope skips a
  // `drawImage` and NOTHING else — the skier keeps skiing, `gate` keeps pulsing
  // on every crash, and the `out` video port keeps carrying the slope
  // (`drawFrame` reads the factory's own controller, never this component).
  // ⚠ WHAT IT DOES COST, stated rather than glossed: with the picture gone
  // there is no surface to point at, so a run that has NEVER been started
  // cannot be started by mouse while the screen is off. A run in progress
  // continues — `player.isMoving` latches — and CV steering is unaffected. The
  // card had no SCREEN switch at all, so this is an addition with a named edge,
  // not a parity loss.
  import SkifreeScreen from './SkifreeScreen.svelte';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** The card's own geometry, carried over unchanged: the game's logical canvas
   *  is 320 square, so this is the one size at which the blit is 1:1 in CSS px
   *  and the 1991 pixel grid lands on whole pixels. ⚠ NOT INFLATED TO FILL A
   *  WIDE PLATE — "we do not want useless gray horizontal space on cards,
   *  ever. prefer compact." */
  const DOCK_SLOPE_PX = 320;
</script>

<div class="skifree-slope" data-testid="skifree-face-body">
  <SkifreeScreen
    {nodeId}
    size={DOCK_SLOPE_PX}
    steerable
    screenToggle
    testidPrefix="skifree-face"
  />
</div>

<style>
  .skifree-slope {
    display: flex;
    justify-content: center;
    padding: 4px 0 2px;
  }
</style>
