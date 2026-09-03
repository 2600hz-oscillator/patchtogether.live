<script lang="ts">
  // ClipplayerTileBody — the 192 px lane tile's own strip: eight lane lamps and
  // one STOP ALL.
  //
  // ⚠ WHY THE TILE NEEDS ANYTHING AT ALL. Removing `clipplayer` from
  // `NON_SHELL_LANE_TYPES` turns a 336 px launcher into a 192×180 tile, and the
  // face's ranked cells at that tier are STEP / QNT / S&H — three global
  // playback settings. Without this strip the canvas would show a clip player
  // that cannot tell you whether anything is playing, which is the one thing a
  // launcher is looked at for. The strip is the per-node glance a shell glyph
  // structurally cannot give (`ShellExtensionGlyphProps` carries no nodeId).
  //
  // ⚠ AND IT IS DELIBERATELY THE CHEAPEST THING THAT ANSWERS THAT QUESTION.
  // NO engine read, NO rAF, NO probe, NO subscription — one pure projection of
  // `node.data` and eight spans. This surface mounts for EVERY clip player in
  // EVERY rack boot, which is exactly where #2314 found a real 4-frame encoder
  // probe running per mount; a tile body is the last place to put work.
  //
  // ⚠ STOP ALL IS HERE BECAUSE IT IS THE ONE GESTURE THAT MUST NOT NEED AN
  // EXPAND. Everything else the deck offers can wait for one click; a panic
  // stop cannot.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import type { ClipPlayerData } from '$lib/audio/modules/clip-types';
  import { clipplayerLaneViews, clipplayerPlayingLaneCount } from './clipplayer-face-model';
  import { stopAllClipplayerLanes } from './clipplayer-face-actions';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  let live = $derived.by(() => ({
    v: nodeVersion(nodeId),
    d: (patch.nodes[nodeId] as ModuleNode | undefined)?.data as ClipPlayerData | undefined,
  }));
  let lanes = $derived(clipplayerLaneViews(live.d));
  let playing = $derived(clipplayerPlayingLaneCount(live.d));
</script>

<div class="strip" data-testid="clipplayer-tile-strip">
  <!-- Eight lamps, one per lane. The COUNT of sounding lanes is on the group's
       accessible name rather than painted: a resting tile paints controls and
       captions, never a derived number. -->
  <div
    class="lanes"
    role="img"
    aria-label={playing > 0
      ? `${playing} of 8 lanes playing`
      : 'no lanes playing'}
    title={playing > 0 ? `${playing} of 8 lanes playing` : 'no lanes playing'}
  >
    {#each lanes as l (l.lane)}
      <span
        class="lamp {l.playing !== null ? 'playing' : l.queued !== null ? 'queued' : 'idle'}"
        class:muted={l.muted}
        style={`--lane-color:${l.color}`}
        data-lane={l.lane}
        data-state={l.playing !== null ? 'playing' : l.queued !== null ? 'queued' : 'idle'}
        data-testid={`clipplayer-tile-lane-${l.lane}`}
      ></span>
    {/each}
  </div>
  <button
    class="stop"
    title="Stop every lane"
    aria-label="stop all lanes"
    data-testid={`clipplayer-tile-stopall-${nodeId}`}
    onclick={() => stopAllClipplayerLanes(nodeId)}>■ ALL</button
  >
</div>

<style>
  .strip {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 6px;
    width: 100%;
  }
  .lanes {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 2px;
    height: 10px;
  }
  .lamp {
    border-radius: 2px;
    background: rgb(255 255 255 / 0.07);
    border: 1px solid rgb(255 255 255 / 0.08);
  }
  .lamp.playing {
    background: var(--lane-color);
    border-color: #fff;
  }
  .lamp.queued {
    background: color-mix(in srgb, var(--lane-color) 45%, transparent);
    border-color: rgb(255 255 255 / 0.5);
  }
  /* MUTED is a lane that is still advancing and still lit in the grid, so it
     cannot simply read as idle — it is struck through instead. */
  .lamp.muted {
    background: repeating-linear-gradient(
      -45deg,
      rgb(255 255 255 / 0.18) 0 2px,
      transparent 2px 4px
    );
  }
  .stop {
    height: 14px;
    padding: 0 5px;
    font-size: 8px;
    line-height: 1;
    letter-spacing: 0.08em;
    color: rgb(255 255 255 / 0.42);
    background: rgb(255 255 255 / 0.05);
    border: 1px solid rgb(255 255 255 / 0.1);
    border-radius: 2px;
    cursor: pointer;
  }
  .stop:hover {
    color: #fff;
  }
</style>
