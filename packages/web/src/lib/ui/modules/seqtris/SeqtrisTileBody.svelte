<script lang="ts">
  // packages/web/src/lib/ui/modules/seqtris/SeqtrisTileBody.svelte
  //
  // THE SEQTRIS LANE TILE — the live well, read-only, plus the bind lamp.
  //
  // ⚠ WHAT PROMOTION REPLACES HERE IS A BLANK PLACEHOLDER, NOT A CARD. seqtris
  // is not in NON_SHELL_LANE_TYPES, not a CARD_PRODUCER and not in
  // HEADLESS_MOUNT_LANE_TYPES, so under the shipping default shell the card is
  // NOT MOUNTED AT ALL today — the lane paints `ModuleShellPlaceholder` while
  // the game runs, the pads stay lit and PIECE / LINE / SPAWN keep firing into
  // whatever is patched. Every seqtris e2e reaches the card only through the
  // `rack` fixture, which is `?shell=legacy` by construction.
  //
  // ⚠ READ-ONLY, AND THE REASON IS SPACE — NOT THE skifree REASON. skifree's
  // tile is inert because two mounted STEERING surfaces would fight over one
  // cursor. That argument does not transfer: a seqtris press is
  // `api().press(action)`, an EVENT rather than a cursor, and a bound Launchpad
  // is already a third presser sending the same events. Two seqtris surfaces
  // both able to press would be harmless. What actually decides it is
  // `io-spec-consistency` / `_card-overflow.ts` (OVERFLOW_TOL_PX = 6) against a
  // ~192 px tile with the title bar and jack rail already spent: a well PLUS a
  // 52 px scene column PLUS a bind row PLUS a port picker PLUS a status line
  // does not fit, where the card had 260 px and no such bound. CONNECT, the
  // picker, the status line and the eight-button column are therefore DOCK-ONLY
  // (`midiCvBuddy` and `skifree` made the same call; `cameraInput` went the
  // other way, for a tile that was otherwise a thumbnail with no possible
  // stream behind it — a different condition).
  //
  // ⚠ AND THIS TILE IS NOT BLANK WITHOUT THEM, which is the whole distinction:
  // it paints two param cells, a LIVE 8x8 well and a lamp, so a glance answers
  // "is it playing, and is my Launchpad on it". The dock is one click away and
  // the EXPAND pill is a lane affordance that stays one.
  //
  // The SCREEN switch is likewise dock-only — the tile has no room for it — but
  // the tile HONOURS `node.data.previewCollapsed`, so turning the well off in
  // the dock turns it off here too. One flag, two surfaces, no way for them to
  // disagree (`SkifreeTileBody`'s exact call).
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { StatusLed } from '$lib/ui/controls';
  import type { ModuleNode } from '$lib/graph/types';
  import type { SeqtrisCardApi } from '$lib/audio/modules/seqtris';
  import type { SeqtrisLaunchpadStatus } from '$lib/audio/seqtris-launchpad';
  import SeqtrisWell from './SeqtrisWell.svelte';
  import { seqtrisRevision } from './seqtris-surface.svelte';

  interface Props {
    /** The graph node this tile is showing — the ONLY prop the slot gets. */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** Sized for the ~192 px lane slot with the title bar, two param cells and
   *  the jack rail already spent. MEASURED against `_card-overflow`, not
   *  guessed — see the header. */
  const TILE_WELL_PX = 104;

  const engineCtx = useEngine();

  // ⚠ THE BIND LAMP READS A NON-REACTIVE SEAM. `launchpadStatus()` walks a
  // per-binding closure in `seqtris-launchpad.ts` — deliberately, so the claim
  // survives with no UI mounted — so nothing invalidates it on its own. The
  // shared revision tick is what makes the DOCK's gestures reach THIS surface;
  // see `seqtris-surface.svelte.ts` for why it is page-wide rather than
  // per-component or per-node.
  let status = $derived.by<SeqtrisLaunchpadStatus | null>(() => {
    void seqtrisRevision();
    void nodeVersion(nodeId);
    const engine = engineCtx.get();
    const node = patch.nodes[nodeId] as ModuleNode | undefined;
    if (!engine || !node) return null;
    const api = (engine.read(node, 'card-api') as SeqtrisCardApi | undefined) ?? null;
    return api?.launchpadStatus() ?? null;
  });
  let bound = $derived(status?.kind === 'bound');
</script>

<div class="seqtris-tile" data-testid="seqtris-tile-host">
  <SeqtrisWell {nodeId} size={TILE_WELL_PX} testidPrefix="seqtris-tile" />
  <!-- ⚠ A LAMP, NOT THE STATUS LINE. The card's six-string `<p class="status">`
       is a dock affordance; here the same sentence reaches `aria-label` and
       `title` through `StatusLed`'s `detail` and never becomes a text node —
       the resting-text ruling's positive form, and the only shape that fits a
       tile at all. -->
  <StatusLed
    caption="PAD"
    lit={bound}
    detail={status?.message ?? 'No SEQTRIS engine on this node yet.'}
    testid="seqtris-tile-led"
  />
</div>

<style>
  .seqtris-tile {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 0 4px 2px;
    box-sizing: border-box;
  }
</style>
