<script lang="ts">
  // ClipplayerRatePanel — the `clipplayer-rate` family's cell: EIGHT per-lane
  // clock-rate selects, one per instrument lane.
  //
  // Each divides or multiplies that lane's step rate off the GLOBAL STEP grid
  // (1/8 · 1/4 · 1/2 · 1 · 2x · 4x) — polyrhythms without leaving the surface.
  // All lanes count from a shared phase origin (transport start or RST), so a
  // divided lane stays locked to the others rather than drifting.
  //
  // ⚠ EIGHT AT ONCE — the same argument the mono row makes: the reason to look
  // at this control is to see which lanes are OFF the grid, which is a
  // comparison across all eight.
  //
  // ⚠ THE ROSTER IS IMPORTED, NEVER RE-TYPED. `RATE_LABELS` is the same array
  // the engine indexes with `RATE_MULTS` and the Launchpad's per-lane RATE row
  // paints; a local copy would let this surface offer a division the clock does
  // not implement.
  //
  // ⚠ A CYCLING BUTTON, WHERE THE CARD DRAWS A `<select>`, AND THE REASON IS
  // THE GATE RATHER THAN TASTE. A panel cell declares an operability probe, and
  // the sweep's only interactions are CLICK and DRAG — clicking a native
  // `<select>` opens a menu the harness cannot commit, so a select row is a
  // cell that cannot be proven alive. The gesture this becomes is not invented
  // for the occasion: the def's own docs already describe the Launchpad deck's
  // per-lane RATE row as "tap to cycle up", so the face and the hardware now
  // perform the same gesture and the card keeps its dropdown. Shift-click (or
  // right-click) cycles DOWN, so any of the six values is at most three clicks
  // away in either direction.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import type { ClipPlayerData } from '$lib/audio/modules/clip-types';
  import { RATE_DEFAULT_INDEX, RATE_LABELS } from '$lib/audio/modules/clip-clock';
  import { clipplayerLaneViews } from './clipplayer-face-model';
  import { setClipplayerLaneRate } from './clipplayer-face-actions';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  let live = $derived.by(() => ({
    v: nodeVersion(nodeId),
    d: (patch.nodes[nodeId] as ModuleNode | undefined)?.data as ClipPlayerData | undefined,
  }));
  let lanes = $derived(clipplayerLaneViews(live.d));

  /** Step one lane's rate around the roster, wrapping in both directions. */
  function cycle(lane: number, cur: number, dir: 1 | -1) {
    const n = RATE_LABELS.length;
    setClipplayerLaneRate(nodeId, lane, (cur + dir + n) % n);
  }
</script>

<div class="lane-row" data-testid="clipplayer-face-rate-row" role="group" aria-label="channel clock rate">
  {#each lanes as l (l.lane)}
    <button
      class="lane-rate"
      class:offgrid={l.rate !== RATE_DEFAULT_INDEX}
      style={`--lane-color:${l.color}`}
      title={`Ch ${l.lane + 1} clock rate — ×/÷ the STEP grid (now ${l.rateLabel}). Click to cycle up, shift- or right-click to cycle down.`}
      aria-label={`channel ${l.lane + 1} clock rate ${l.rateLabel}`}
      data-lane={l.lane}
      data-rate={l.rate}
      data-testid={`clipplayer-rate-${l.lane}`}
      onclick={(e) => cycle(l.lane, l.rate, e.shiftKey ? -1 : 1)}
      oncontextmenu={(e) => {
        e.preventDefault();
        cycle(l.lane, l.rate, -1);
      }}>{l.rateLabel}</button
    >
  {/each}
</div>

<style>
  .lane-row {
    display: grid;
    grid-template-columns: repeat(8, 28px);
    gap: 3px;
  }
  .lane-rate {
    width: 28px;
    height: 16px;
    padding: 0;
    font-size: 9px;
    line-height: 1;
    color: rgb(255 255 255 / 0.42);
    background: rgb(255 255 255 / 0.04);
    border: 1px solid rgb(255 255 255 / 0.1);
    border-radius: 2px;
    cursor: pointer;
  }
  /* A lane that is NOT on the STEP grid is the whole reason to look at this
     row, so it is the state that gets the lane's colour. */
  .lane-rate.offgrid {
    color: #fff;
    border-color: var(--lane-color);
    background: color-mix(in srgb, var(--lane-color) 26%, transparent);
  }
</style>
