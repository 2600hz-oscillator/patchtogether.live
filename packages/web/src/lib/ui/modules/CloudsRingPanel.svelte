<script lang="ts">
  // CloudsRingPanel — the faceplate's HERO: two seconds of tape, the window
  // POSITION reads from, and the grains overlapping inside it.
  //
  // ⚠ WHY A PICTURE AND NOT A NUMBER. POSITION is the strongest control on this
  // module and the ONLY one that cannot be a readout: it moves the output
  // waveform entirely (max|Δ| 0.99 against a marked source) while moving its
  // level by 0.17 dB, so every RMS-based instrument in the repo reports it dead.
  // What it actually does is pick WHERE on the tape the grains read, and that is
  // a place, not a quantity. The hero prints the place as seconds beside the
  // dial and draws it here.
  //
  // ── ⚠ IT HAS NO CLOCK, AND THAT IS THE DESIGN ────────────────────────────
  //
  // The obvious hero for a granular module is a live write head sweeping the
  // ring. It is the wrong thing to draw here, for two independent reasons and
  // either alone would settle it:
  //
  //   * THERE IS NOTHING HONEST TO READ. The quantity a fill indicator needs is
  //     the worklet's `fillLevel`, which is not an AudioParam and is never
  //     posted to the host. `readParam` reaches AudioParams only, so a "buffer
  //     43 %" readout could only be synthesised from `AudioContext.currentTime`
  //     minus a remembered spawn time — a guess that a FREEZE, a suspend or a
  //     re-spawn all invalidate silently.
  //   * IT WOULD MAKE THE BASELINE A RACE. A picture that depends on WHEN the
  //     capture lands is a VRT scene whose content is decided by boot latency.
  //     #1420 freezes the AudioContext before the tile is framed, which would
  //     probably hold it still — but "probably, via a shared mechanism" is a
  //     worse guarantee than "the picture is a pure function of six numbers",
  //     which is what this is.
  //
  // So every pixel below comes from the live PARAMS through the grain
  // scheduler's own laws (clouds-face-model), and the two facts a clock would
  // have shown are printed as numbers instead — `silent for` and `full level
  // at`, in the sidebar — where they are true without one. MEASURED: three
  // consecutive dock captures of this panel are byte-identical.
  //
  // ⚠ THIS PANEL EMITS NO `control-<paramId>` TESTID (shell-cells rule 1). Its
  // one writable affordance is the AXIS MODE, which is PRIVATE VIEW STATE
  // (component state, never `node.data`: relabelling your own picture must not
  // relabel every collaborator's screen or dirty the patch).

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import { cloudsDef } from '$lib/audio/modules/clouds';
  import {
    cloudsAxisCaption,
    cloudsFaceParams,
    cloudsRingPlan,
    type CloudsAxisMode,
  } from './clouds-face-model';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern). `patch.nodes[id]` is a stable SyncedStore proxy, so a derived
   *  that bumps on `nodeVersion(id)` and returns it BARE is `===` to its
   *  previous value and the picture freezes at first render. */
  let live = $derived.by(() => ({
    v: nodeVersion(nodeId),
    n: patch.nodes[nodeId] as ModuleNode | undefined,
  }));

  /** DURABLE params, deliberately — the same reader `ModuleShell.readoutValue`
   *  uses, so the picture and the captions beside it can never disagree. Every
   *  one of this module's six macros is an ordinary stored value (unlike
   *  bluebox, whose momentary keys forced an engine poll), so there is nothing
   *  the durable read is blind to. */
  let p = $derived.by(() => {
    const node = live.n;
    return cloudsFaceParams((id) => {
      const v = node?.params?.[id];
      if (typeof v === 'number') return v;
      return cloudsDef.params.find((q) => q.id === id)?.defaultValue;
    });
  });

  let plan = $derived(cloudsRingPlan(p));

  /** COMPONENT STATE — see the header. `time` labels the tape in seconds behind
   *  the write head; `grains` labels it in grain lengths, which is the frame the
   *  scheduler actually works in. The flip is also this panel's declared
   *  operability probe: it drives the axis row's text, which a dead button
   *  cannot change. */
  let axisMode = $state<CloudsAxisMode>('time');
  const TICKS = [0, 0.25, 0.5, 0.75, 1] as const;
  const pct = (x: number): string => `${(x * 100).toFixed(3)}%`;
</script>

<div class="ring" data-testid="clouds-buffer">
  <div
    class="tape"
    role="img"
    aria-label="two seconds of ring buffer, newest at the left; the read window sits {plan.secondsBack.toFixed(
      2,
    )} seconds behind the write head with {plan.grainCount.toFixed(0)} grains overlapping"
  >
    <!-- THE NEAR BAND. A grain always starts at least one grain-length behind
         the write head (`offset = safeLen + position·headroom`), so POSITION
         can never place a read START inside this stripe. It is also exactly the
         window the module is silent for at spawn — the same number, drawn once.
         No dial on this panel says either. -->
    <div class="nose" style={`--to:${pct(plan.deadNoseTo)}`}></div>

    <!-- THE READ WINDOW + its grains. Each bar is one concurrent grain, offset
         by one spawn interval from the last, so the overlap is the picture
         rather than a claim. Capped at 12 drawn bars: past that the comb is
         solid and the count is printed instead. -->
    <div class="window" style={`--from:${pct(plan.readFrom)};--to:${pct(plan.readTo)}`}></div>
    {#each plan.grains as g, i (i)}
      <div class="grain" style={`--from:${pct(g.from)};--to:${pct(g.to)};--i:${i}`}></div>
    {/each}

    <!-- The write head, pinned at NOW. It does not move, because nothing here
         is a clock — see the header. -->
    <div class="head"></div>
  </div>

  <!-- ⚠ THE AXIS ROW IS THE PANEL'S OPERABILITY PROBE TARGET. Its text is
       computed from the axis mode AND from the live grain length, so a MODE
       button that did nothing cannot change it. `clouds-face-model.test.ts`
       asserts the two modes can never render the same string for any tick at
       any SIZE, which is what makes the `text` probe a real liveness assertion
       rather than a button relabelling itself.

       ⚠ NO `text-overflow: ellipsis`, DELIBERATELY (the bluebox precedent): a
       CSS ellipsis leaves NO TRACE in `textContent`, and this row is exactly
       what faces-parity reads with `toHaveText`. -->
  <div class="axis" data-testid="clouds-ring-axis">
    {#each TICKS as t (t)}<span>{cloudsAxisCaption(t, p, axisMode)}</span>{/each}
  </div>

  <div class="key">
    <span class="k-now">now</span>
    <span class="k-nose">never read</span>
    <span class="k-win">reading</span>
    <span class="k-count" data-testid="clouds-ring-count"
      >{plan.grainCount >= 24 ? '24' : plan.grainCount.toFixed(1)} / 24{plan.poolFull
        ? ' FULL'
        : ''}</span
    >
    <!-- ⚠ A `SIZE CLAMPED` BADGE USED TO SIT HERE, and its deletion is the
         visible half of #1456. The grain ceiling (800 ms) contradicted the SIZE
         law's top (1500 ms), so the dial's top 19.50 % rendered bit-identical
         output and this panel refused to paint it as working. The ceiling is
         now derived from the law, the whole travel is alive, and a badge that
         can never light is a mechanism with nothing left to measure. -->
    <button
      type="button"
      class="mode"
      data-testid="clouds-ring-scale"
      title="Label the tape in SECONDS behind the write head, or in GRAIN LENGTHS (the frame the scheduler works in). Your screen only: this is not shared or saved."
      onclick={() => (axisMode = axisMode === 'time' ? 'grains' : 'time')}
    >{axisMode === 'time' ? 's' : 'grains'}</button>
  </div>
</div>

<style>
  .ring {
    width: 100%;
    display: grid;
    grid-template-rows: 1fr auto auto;
    gap: 3px;
  }

  /* NEWEST AT THE LEFT. The write head is a fixed anchor and the tape runs away
     from it, which is the frame every number on this faceplate uses ("1.15 s
     back"). Drawing it the other way round would make the picture and the
     readouts disagree about which end is now. */
  .tape {
    position: relative;
    height: 104px;
    padding: 0;
    background: rgb(0 0 0 / 0.35);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 3px;
    overflow: hidden;
  }

  .nose {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: var(--to);
    background: repeating-linear-gradient(
      -45deg,
      rgb(255 255 255 / 0.05) 0 4px,
      transparent 4px 8px
    );
    border-right: 1px dashed rgb(255 255 255 / 0.14);
  }

  .window {
    position: absolute;
    top: 4px;
    bottom: 4px;
    left: var(--from);
    width: calc(var(--to) - var(--from));
    background: rgb(255 255 255 / 0.05);
    border: 1px solid var(--domain, #4dd6c1);
    border-radius: 2px;
  }

  /* One bar per concurrent grain, stacked down the window so the OVERLAP is
     visible as depth rather than asserted in a caption. */
  .grain {
    position: absolute;
    left: var(--from);
    width: calc(var(--to) - var(--from));
    top: calc(8px + var(--i) * 7px);
    height: 4px;
    background: var(--domain, #4dd6c1);
    opacity: 0.55;
    border-radius: 2px;
  }

  .head {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 2px;
    background: #f0a44a;
  }

  /* MIRRORS the tape's own 0..1 axis: five ticks, evenly spread, first
     left-aligned and last right-aligned so a caption never hangs off the end. */
  .axis {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    font-size: 9px;
    color: rgb(255 255 255 / 0.42);
    font-variant-numeric: tabular-nums;
  }
  .axis > span {
    text-align: center;
    overflow: visible;
    white-space: nowrap;
  }
  .axis > span:first-child {
    text-align: left;
  }
  .axis > span:last-child {
    text-align: right;
  }

  .key {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .k-now {
    color: #f0a44a;
  }
  .k-nose {
    color: rgb(255 255 255 / 0.42);
  }
  .k-win {
    color: var(--domain, #4dd6c1);
  }
  .k-count {
    color: var(--domain, #4dd6c1);
    font-variant-numeric: tabular-nums;
  }
  .key .mode {
    margin-left: auto;
    appearance: none;
    background: rgb(255 255 255 / 0.06);
    border: 1px solid rgb(255 255 255 / 0.12);
    border-radius: 3px;
    color: rgb(255 255 255 / 0.42);
    font: inherit;
    letter-spacing: normal;
    text-transform: none;
    padding: 1px 5px;
    cursor: pointer;
  }
  .key .mode:hover {
    background: rgb(255 255 255 / 0.12);
  }
</style>
