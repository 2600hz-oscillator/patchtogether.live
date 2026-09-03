<script lang="ts">
  // ClipplayerMonoPanel — the `clipplayer-mono` family's cell: EIGHT lane
  // mono/poly badges, one per instrument lane, in column order.
  //
  // ⚠ EIGHT AT ONCE, NOT ONE FOR A "SELECTED" LANE, and that is the whole
  // reason this is a panel rather than a `toggle` cell. A shell cell binds ONE
  // control; kria's per-track cells solve that by reading a SELECTED track out
  // of `node.data`. A launcher cannot: the thing a player does here is compare
  // the eight lanes against each other, and a face that shows one lane's badge
  // and hides the other seven is a functional loss dressed as tidiness.
  //
  // ⚠ MONOPHONY IS AN EDIT-TIME CONSTRAINT AND THE ENGINE NEVER READS IT.
  // `laneMono` is consumed by the card, the monome control and `toggleNoteAt`
  // only: on ADD, MONO clears every note whose span covers the column and
  // places one (replace-on-add); POLY caps the column at the poly cable's voice
  // width and steals the oldest. Playback plays whatever the column holds.
  //
  // The glyphs are `1` (mono) and `∑` (poly). They replaced a literal "5" that
  // had drifted from a long-dead cable width — which is why the tooltip
  // INTERPOLATES `POLY_CHANNEL_PAIRS` instead of restating a number.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import type { ClipPlayerData } from '$lib/audio/modules/clip-types';
  import { POLY_CHANNEL_PAIRS } from '$lib/audio/poly';
  import { clipplayerLaneViews } from './clipplayer-face-model';
  import { toggleClipplayerLaneMono } from './clipplayer-face-actions';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  let live = $derived.by(() => ({
    v: nodeVersion(nodeId),
    d: (patch.nodes[nodeId] as ModuleNode | undefined)?.data as ClipPlayerData | undefined,
  }));
  let lanes = $derived(clipplayerLaneViews(live.d));
</script>

<div class="lane-row" data-testid="clipplayer-face-mono-row" role="group" aria-label="channel mono or poly">
  {#each lanes as l (l.lane)}
    <button
      class="mono"
      class:on={l.mono}
      style={`--lane-color:${l.color}`}
      aria-pressed={l.mono}
      aria-label={`channel ${l.lane + 1} ${l.mono ? 'mono' : 'poly'}`}
      title={l.mono
        ? `Channel ${l.lane + 1} is MONO — one note per column (adding a note replaces the one under it). Click for POLY.`
        : `Channel ${l.lane + 1} is POLY — notes stack into a chord, up to the poly cable's ${POLY_CHANNEL_PAIRS} voices. Click for MONO.`}
      data-lane={l.lane}
      data-mono={l.mono ? '1' : '0'}
      data-testid={`clipplayer-mono-${l.lane}`}
      onclick={() => toggleClipplayerLaneMono(nodeId, l.lane)}>{l.mono ? '1' : '∑'}</button
    >
  {/each}
</div>

<style>
  /* The same 8 × 28 px track the launch grid uses, so a lane's badge sits under
     its own column of pads when the two cells land in one plate. */
  .lane-row {
    display: grid;
    grid-template-columns: repeat(8, 28px);
    gap: 3px;
  }
  .mono {
    width: 28px;
    height: 16px;
    padding: 0;
    font-size: 10px;
    line-height: 1;
    color: rgb(255 255 255 / 0.42);
    background: rgb(255 255 255 / 0.04);
    border: 1px solid rgb(255 255 255 / 0.1);
    border-radius: 2px;
    cursor: pointer;
  }
  .mono.on {
    color: #fff;
    border-color: var(--lane-color);
    background: color-mix(in srgb, var(--lane-color) 30%, transparent);
  }
  .mono:hover {
    color: #fff;
  }
</style>
