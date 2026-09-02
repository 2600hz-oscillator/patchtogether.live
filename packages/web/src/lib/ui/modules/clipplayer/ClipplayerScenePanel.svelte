<script lang="ts">
  // ClipplayerScenePanel — the `clipplayer-scene-repeat` family's cell: EIGHT
  // per-scene repeat counts, one per row of the launch grid.
  //
  // A launched scene loops forever by default (∞). Give it a finite count and
  // after that many passes of the scene's LONGEST clip the player auto-launches
  // the next content scene DOWN, skipping empty rows, through the normal
  // quantized launch path. Click cycles ∞ → 2 → 3 → 4 → 8 → ∞.
  //
  // ⚠ THE DEF'S DOCS FOR THIS FAMILY WERE STALE AND THIS PR CORRECTS THEM.
  // They still described a "small read-only ×N" whose count is "SET on a
  // Launchpad" with "card-side editing … a follow-up". The card grew the click
  // gesture (`cycleSceneRepeat`) and its own comment says so — "SCENE-REPEAT
  // SET (Part A group 2, was read-only)" — but the prose in `clipplayer.ts` was
  // never re-read. A read-only family has no honest operability probe, so the
  // stale sentence would have argued this cell out of existence.
  //
  // ⚠ THE CYCLE IS IMPORTED FROM THE MODEL, not re-typed here: the card runs
  // the identical gesture and two copies of the ring would let the two surfaces
  // disagree about what the next press does.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import type { ClipPlayerData } from '$lib/audio/modules/clip-types';
  import { clipplayerSceneViews } from './clipplayer-face-model';
  import { cycleClipplayerSceneRepeat, launchClipplayerScene } from './clipplayer-face-actions';
  import { clipplayerNowSticky } from './clipplayer-face-selection.svelte';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  let live = $derived.by(() => ({
    v: nodeVersion(nodeId),
    d: (patch.nodes[nodeId] as ModuleNode | undefined)?.data as ClipPlayerData | undefined,
  }));
  let scenes = $derived(clipplayerSceneViews(live.d));
  /** The SAME sticky NOW the launch grid's toggle sets — one modifier per node,
   *  as on the card, where `launchScene` and `launchPad` read one flag. */
  let nowSticky = $derived(clipplayerNowSticky(nodeId));
</script>

<div class="scenes" data-testid="clipplayer-face-scene-row" role="group" aria-label="scene repeats">
  {#each scenes as s (s.slot)}
    <span class="scene">
      <span class="n" aria-hidden="true">{s.slot + 1}</span>
      <button
        class="scene-flair"
        class:finite={s.count > 0}
        title={s.count === 0
          ? `Scene ${s.slot + 1} repeats forever. Click to set a finite count — after that many passes of the scene's longest clip the player auto-advances to the next content scene.`
          : `Scene ${s.slot + 1} plays ${s.count} times, then auto-advances to the next content scene. Click to change.`}
        aria-label={`scene ${s.slot + 1} repeats ${s.count === 0 ? 'infinite' : s.count} — click to change`}
        data-slot={s.slot}
        data-repeat={s.count}
        data-testid={`clipplayer-scene-repeat-${s.slot}`}
        onclick={() => cycleClipplayerSceneRepeat(nodeId, s.slot)}>{s.label}</button
      >
      <button
        class="scene-go"
        title={`Launch scene ${s.slot + 1} (this slot across all channels)${nowSticky ? ' — NOW' : ''}`}
        aria-label={`launch scene ${s.slot + 1} from the scenes band`}
        data-slot={s.slot}
        data-testid={`clipplayer-face-scene-go-${s.slot}`}
        onclick={(e) => launchClipplayerScene(nodeId, s.slot, e.shiftKey || nowSticky)}>▶</button
      >
    </span>
  {/each}
</div>

<style>
  .scenes {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px 8px;
  }
  .scene {
    display: grid;
    grid-template-columns: 12px 1fr 14px;
    align-items: center;
    gap: 3px;
  }
  .n {
    font-size: 9px;
    color: rgb(255 255 255 / 0.3);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .scene-flair,
  .scene-go {
    height: 16px;
    padding: 0 2px;
    font-size: 9px;
    line-height: 1;
    color: rgb(255 255 255 / 0.42);
    background: rgb(255 255 255 / 0.04);
    border: 1px solid rgb(255 255 255 / 0.1);
    border-radius: 2px;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  /* A FINITE count is the state worth seeing across eight rows at a glance;
     infinite is the quiet default and stays dim. */
  .scene-flair.finite {
    color: #fff;
    border-color: var(--domain, #4dd6c1);
    background: color-mix(in srgb, var(--domain, #4dd6c1) 22%, transparent);
  }
  .scene-flair:hover,
  .scene-go:hover {
    color: #fff;
  }
</style>
