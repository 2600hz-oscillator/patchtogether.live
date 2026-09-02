<script lang="ts">
  // The ARCHIVIST lane tile's own controls: search the archive, re-roll, and
  // drive the transport — without expanding the module.
  //
  // ⚠ WITHOUT THIS THE TILE IS A DEAD END, which is cameraInput's lesson
  // (#2140) applied to the module it applies to hardest. archivist's picture
  // arrives in the tile for free from `hasVideoSurface(def)`, but a fresh
  // archivist has NO item — `node.data.item` is null until a search writes one
  // — so a `fullViewBody`-only extension would paint an idle blue gradient in
  // the lane with no way to put anything in it. The player would have to know
  // to open the dock before the module could do anything at all.
  //
  // ⚠ NO MOUNT-TIME WORK, and this is a named constraint rather than an
  // accident: recorderbox (#2314) shipped a 60-scene VRT regression because a
  // tile `$effect` ran a real encoder probe on every rack boot. Everything this
  // tile mounts is cheap and local — one non-reactive `onMount` read of
  // `node.data` and one registry `subscribe`. It issues NO fetch, touches no
  // element and probes nothing; the first archive.org request happens when a
  // player presses Search.
  //
  // The picture itself is NOT here: the shell's glyph slot already paints a
  // live thumbnail for any video face (`VideoTileThumb`, gated on
  // `hasVideoSurface`). This adds the controls that thumbnail needs to have
  // something to show.
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ArchivistData } from '$lib/video/modules/archivist';
  import { buildDetailsUrl, hasCleanOutput } from '$lib/video/modules/archivist-query';
  import ArchivistBrowseControls from './ArchivistBrowseControls.svelte';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  // Leaf derivations with the node signal touched inside — the shape
  // `ArchivistArchiveBody` documents at length and for the same measured
  // reason (a derivation returning the NODE is value-equal and notifies
  // nobody).
  function data(): Partial<ArchivistData> | undefined {
    void nodeVersion(nodeId);
    return patch.nodes[nodeId]?.data as Partial<ArchivistData> | undefined;
  }

  let itemTitle = $derived<string | null>(data()?.item?.title ?? null);
  let itemType = $derived(data()?.item?.type ?? null);
  let itemIdentifier = $derived<string | null>(data()?.item?.identifier ?? null);
  let durationSec = $derived<number>(data()?.item?.duration ?? 0);
  let isPlaying = $derived<boolean>(data()?.isPlaying ?? false);
  let hasItem = $derived<boolean>(itemIdentifier !== null);
  let cleanOutput = $derived<boolean>(itemType ? hasCleanOutput(itemType) : false);
  let detailsUrl = $derived<string>(itemIdentifier ? buildDetailsUrl(itemIdentifier) : '');
</script>

<div class="tile-archivist">
  <ArchivistBrowseControls
    {nodeId}
    testidPrefix="archivist-tile"
    compact
    {hasItem}
    {itemTitle}
    {itemType}
    {durationSec}
    {isPlaying}
    {cleanOutput}
    {detailsUrl}
  />
</div>

<style>
  .tile-archivist {
    width: 100%;
    padding: 2px 4px 4px;
    box-sizing: border-box;
  }
</style>
