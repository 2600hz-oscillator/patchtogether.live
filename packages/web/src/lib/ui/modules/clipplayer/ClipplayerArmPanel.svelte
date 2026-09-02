<script lang="ts">
  // ClipplayerArmPanel — the `clipplayer-auto-arm` family's cell: EIGHT per-lane
  // automation record arms (◉), one per instrument lane.
  //
  // CLIP RECORD, CONTINUOUS OVERDUB, Deluge-like and PER LANE. Arm a lane while
  // a note clip plays in it, then move any control of a MODULE assigned to that
  // lane (screen / MIDI / Electra — CV never records): the recorder punches in
  // at THAT clip's own next loop start and overdubs every loop until the arm is
  // clicked again. There is no auto punch-out; stopping mid-loop keeps the
  // untouched tail.
  //
  // ⚠ DISTINCT FROM THE ARRANGER RECORD, and the surface has to keep saying so.
  // The red ● arranger record captures clip LAUNCHES onto a timeline; this teal
  // ◉ captures KNOB MOVES into the playing clip. They are two different
  // recorders and the card deliberately paints them apart — the face keeps the
  // arranger record in the body and the arms here.
  //
  // ⚠ THE ARM IS SINGLE-WRITER PER LANE. Arming stamps this client's id as the
  // lane's `recorderId` through the shared `toggleLaneAutomationArm` seam the
  // Launchpad's SHIFT gesture also uses, so two collaborators can record two
  // DIFFERENT lanes at once and never the same one.
  //
  // ⚠ WHAT THIS CELL DELIBERATELY DOES NOT PAINT: the 🟡🟡🔴🔴 four-beat
  // countdown. That is ENGINE state polled per frame, and a cell that ran a rAF
  // loop would put a per-frame poll in every mounted faceplate — the #2314
  // finding, one tier down. The countdown lives in the body, which polls once
  // for the whole surface.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import type { ClipPlayerData } from '$lib/audio/modules/clip-types';
  import { clipplayerLaneViews } from './clipplayer-face-model';
  import { toggleClipplayerLaneArm } from './clipplayer-face-actions';

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

<div class="lane-row" data-testid="clipplayer-face-arm-row" role="group" aria-label="channel automation arm">
  {#each lanes as l (l.lane)}
    <button
      class="lane-arm"
      class:on={l.armed}
      style={`--lane-color:${l.color}`}
      aria-pressed={l.armed}
      aria-label={`lane ${l.lane + 1} automation arm`}
      title={l.armed
        ? `Lane ${l.lane + 1} automation RECORDING (continuous overdub) — move any control of a module assigned to this lane (screen / MIDI / Electra; CV never records) and it records into the clip playing here. Click to STOP.`
        : `Arm lane ${l.lane + 1} automation (CLIP RECORD) — punches in at its playing clip's next loop start; assign modules via right-click on a module card → Assign to automation lane.`}
      data-lane={l.lane}
      data-armed={l.armed ? '1' : '0'}
      data-testid={`clipplayer-auto-arm-${l.lane}`}
      onclick={() => toggleClipplayerLaneArm(nodeId, l.lane)}>◉</button
    >
  {/each}
</div>

<style>
  .lane-row {
    display: grid;
    grid-template-columns: repeat(8, 28px);
    gap: 3px;
  }
  .lane-arm {
    width: 28px;
    height: 16px;
    padding: 0;
    font-size: 10px;
    line-height: 1;
    color: rgb(255 255 255 / 0.3);
    background: rgb(255 255 255 / 0.04);
    border: 1px solid rgb(255 255 255 / 0.1);
    border-radius: 2px;
    cursor: pointer;
  }
  .lane-arm:hover {
    color: rgb(255 255 255 / 0.6);
  }
  /* ARMED is red, not the lane colour: a recording arm has to be legible as
     "this is recording" independently of which channel it belongs to. */
  .lane-arm.on {
    color: #fff;
    background: hsl(0 62% 38%);
    border-color: hsl(0 70% 58%);
  }
</style>
