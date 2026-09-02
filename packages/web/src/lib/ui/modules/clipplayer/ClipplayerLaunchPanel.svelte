<script lang="ts">
  // ClipplayerLaunchPanel — the clip player's HERO: the 8×8 launch grid.
  //
  // COLUMNS ARE THE 8 INSTRUMENT LANES, ROWS ARE THE 8 CLIP SLOTS (the scenes),
  // which is the transposed-Launchpad / Ableton-Session convention the card and
  // the hardware already use. The flat storage key is `clipIndex(slot, lane)`.
  //
  // ⚠ WHY A PF-14 PANEL AND NOT A ROW OF CELLS. `kria` is the precedent, stated
  // in its own face: the grid IS the module, everything a player plays lives in
  // `node.data`, and the only two controls the PARAM system knows about here are
  // global playback settings. A launcher whose faceplate paints seven knobs and
  // no pads is not a launcher. It ranks through `face.hero.cell`, which is what
  // makes a panel reachable at rank 1 at all (PF-22 `laneOrder`).
  //
  // ⚠ THE PAD GEOMETRY IS PIXEL-FROZEN, AND IT IS NOT A STYLE CHOICE. 28×28 with
  // a 3 px gap, and the scene column is `position: absolute` OUTSIDE the row's
  // flex, exactly as the card has it — so adding or removing a scene control can
  // never shift a pad and the VRT baseline stays deterministic. The card's own
  // comment records that this was learned the hard way.
  //
  // ⚠ NO `control-<paramId>` TESTID ANYWHERE (shell-cells panel rule 1): every
  // affordance here writes `node.data`, not a ParamDef.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import { CLIP_LANES, CLIP_SLOTS, type ClipPlayerData } from '$lib/audio/modules/clip-types';
  import {
    clipplayerLaneViews,
    clipplayerPadViews,
    type ClipplayerMenuAt,
  } from './clipplayer-face-model';
  import {
    ensureClipplayerClip,
    launchClipplayerPad,
    launchClipplayerScene,
    setClipplayerLaneColor,
  } from './clipplayer-face-actions';
  import { clipplayerSelectClip } from './clipplayer-face-selection.svelte';
  import ClipplayerClipMenu from './ClipplayerClipMenu.svelte';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern). `patch.nodes[id]` is a stable SyncedStore proxy, so a `$derived`
   *  that bumps on `nodeVersion(id)` and returns it BARE is `===` to its
   *  previous value and the whole grid freezes at first render — the
   *  proxy-identity trap this repo has shipped more than once. */
  let live = $derived.by(() => ({
    v: nodeVersion(nodeId),
    d: (patch.nodes[nodeId] as ModuleNode | undefined)?.data as ClipPlayerData | undefined,
  }));

  let pads = $derived(clipplayerPadViews(live.d));
  let lanes = $derived(clipplayerLaneViews(live.d));
  /** Pads indexed by `[slot][lane]` for the row-major render. */
  let rows = $derived(
    Array.from({ length: CLIP_SLOTS }, (_, slot) =>
      Array.from({ length: CLIP_LANES }, (_, lane) => pads[lane * CLIP_SLOTS + slot]!),
    ),
  );

  let menu = $state<ClipplayerMenuAt | null>(null);

  // Single-click launches; double-click opens the editor instead. The card's
  // 220 ms debounce, verbatim — without it every double-click also fires a
  // launch on its way to the editor.
  let clickTimer: ReturnType<typeof setTimeout> | null = null;
  function onPadClick(index: number, ev: MouseEvent) {
    const now = ev.shiftKey;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      launchClipplayerPad(nodeId, index, now);
    }, 220);
  }
  function onPadDblClick(index: number) {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    ensureClipplayerClip(nodeId, index);
    clipplayerSelectClip(nodeId, index);
  }
  $effect(() => () => {
    if (clickTimer) clearTimeout(clickTimer);
  });

  function openPadMenu(e: MouseEvent, idx: number) {
    e.preventDefault();
    e.stopPropagation(); // don't also open the node's "Module actions" menu
    menu = { kind: 'clip', x: e.clientX, y: e.clientY, idx };
  }
</script>

<div class="launch" data-testid="clipplayer-face-grid">
  <!-- CHANNEL HEADER — one COLOUR swatch per lane. It is the only writer in the
       app of `node.data.laneColor`, which the shell reads live to paint the
       already-shipped mixmstrs face's channel accents: dropping it would freeze
       every channel accent in the rack at its default with no gate able to see
       it. So it is on the hero, not in a body. -->
  <div class="head" role="row">
    {#each lanes as l (l.lane)}
      <span class="head-cell" style={`--lane-color:${l.color}`}>
        <input
          class="lane-color"
          type="color"
          value={l.color}
          title={`Channel ${l.lane + 1} clip colour — tints its whole column, its Launchpad pads and every mixmstrs channel accent bound to this lane`}
          aria-label={`channel ${l.lane + 1} colour`}
          data-lane={l.lane}
          data-testid={`clipplayer-color-${l.lane}`}
          oninput={(e) => setClipplayerLaneColor(nodeId, l.lane, e.currentTarget.value)}
        />
      </span>
    {/each}
  </div>

  <div class="grid" role="grid" aria-label="clip launch grid">
    {#each rows as row, slot (slot)}
      <div class="grid-row" role="row">
        <!-- SCENE LAUNCH — fire this slot across every content lane. ABSOLUTELY
             POSITIONED outside the row's flex so the fixed-integer pad geometry
             never shifts (VRT determinism). -->
        <button
          class="scene-launch"
          title={`Launch scene ${slot + 1} (this slot across all channels)`}
          aria-label={`launch scene ${slot + 1}`}
          data-slot={slot}
          data-testid={`clipplayer-scene-launch-${slot}`}
          onclick={(e) => launchClipplayerScene(nodeId, slot, e.shiftKey)}>▶</button
        >
        {#each row as pad (pad.index)}
          <button
            class="pad {pad.state}"
            role="gridcell"
            style={`--lane-color:${lanes[pad.lane]!.color}`}
            aria-label={`lane ${pad.lane + 1} slot ${pad.slot + 1} ${pad.state}${
              pad.hasAuto ? ' (has automation)' : ''
            }`}
            title={pad.hasClip
              ? 'Click: launch/stop · Double-click: edit · Right-click: note probability, pitch probability, skip every, copy / paste / clear'
              : 'Click: launch/stop · Double-click: edit · Right-click: paste a copied clip here'}
            data-clip={pad.index}
            data-lane={pad.lane}
            data-slot={pad.slot}
            data-state={pad.state}
            data-auto={pad.hasAuto ? '1' : undefined}
            data-testid={`clipplayer-pad-${pad.index}`}
            onclick={(e) => onPadClick(pad.index, e)}
            ondblclick={() => onPadDblClick(pad.index)}
            oncontextmenu={(e) => openPadMenu(e, pad.index)}
            >{#if pad.hasAuto}<span class="auto-dot" aria-hidden="true"></span>{/if}</button
          >
        {/each}
      </div>
    {/each}
  </div>
</div>

<ClipplayerClipMenu {nodeId} at={menu} onclose={() => (menu = null)} />

<style>
  .launch {
    display: grid;
    gap: 4px;
    justify-items: start;
  }
  /* The header aligns to the pad columns below: same 28 px track, same 3 px gap,
     and the same 14 px left inset the scene column occupies. */
  .head {
    display: grid;
    grid-template-columns: repeat(8, 28px);
    gap: 3px;
    margin-left: 14px;
  }
  .head-cell {
    display: block;
    width: 28px;
  }
  .lane-color {
    display: block;
    width: 28px;
    height: 12px;
    padding: 0;
    border: 1px solid rgb(255 255 255 / 0.16);
    border-radius: 2px;
    background: var(--lane-color);
    cursor: pointer;
  }
  /* Chrome/Safari draw their own swatch chrome inside the control; strip it so
     the row reads as eight flat colour chips. */
  .lane-color::-webkit-color-swatch-wrapper {
    padding: 0;
  }
  .lane-color::-webkit-color-swatch {
    border: none;
    border-radius: 1px;
  }

  .grid {
    display: grid;
    gap: 3px;
  }
  /* `position: relative` + an ABSOLUTE scene column is what keeps the pad row a
     pure 8×28 px track — the card's rule, carried over. */
  .grid-row {
    position: relative;
    display: grid;
    grid-template-columns: repeat(8, 28px);
    gap: 3px;
    margin-left: 14px;
  }
  .scene-launch {
    position: absolute;
    right: 100%;
    top: 0;
    bottom: 0;
    width: 12px;
    display: grid;
    place-items: center;
    padding: 0;
    font-size: 8px;
    line-height: 1;
    color: rgb(255 255 255 / 0.42);
    background: rgb(255 255 255 / 0.04);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 2px;
    cursor: pointer;
  }
  .scene-launch:hover {
    color: #fff;
    background: rgb(255 255 255 / 0.12);
  }

  .pad {
    position: relative;
    width: 28px;
    height: 28px;
    padding: 0;
    border-radius: 3px;
    border: 1px solid rgb(255 255 255 / 0.1);
    background: rgb(255 255 255 / 0.04);
    cursor: pointer;
  }
  .pad.loaded {
    background: color-mix(in srgb, var(--lane-color) 38%, transparent);
    border-color: color-mix(in srgb, var(--lane-color) 60%, transparent);
  }
  .pad.playing {
    background: var(--lane-color);
    border-color: #fff;
  }
  /* QUEUED WINS OVER PLAYING and it BLINKS, because "a change is coming" is the
     single most important thing this grid can say. */
  .pad.queued {
    background: color-mix(in srgb, var(--lane-color) 55%, transparent);
    border-color: #fff;
    animation: clipplayer-pad-blink 0.5s steps(2, end) infinite;
  }
  @keyframes clipplayer-pad-blink {
    0% {
      opacity: 1;
    }
    100% {
      opacity: 0.45;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pad.queued {
      animation: none;
      opacity: 0.7;
    }
  }
  .auto-dot {
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #4dd6c1;
  }
</style>
