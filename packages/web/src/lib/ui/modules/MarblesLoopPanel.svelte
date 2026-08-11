<script lang="ts">
  // MarblesLoopPanel — the marbles faceplate's HERO: the two loops and the
  // quantiser grid the X voltages are being snapped to.
  //
  // ⚠ WHY A PICTURE. Three of this module's controls are unreadable from their
  // own positions, and all three are structural rather than a matter of taste:
  //
  //   · LENGTH and X LENGTH are BIT-EXACTLY inert at DÉJÀ VU 0 — the shipped
  //     default — because `p = (2·dv − 1)²` is 1 there, so every step overwrites
  //     the slot it is about to read. A dial reading `8` beside a loop that does
  //     not exist is the defect; a row that draws ONE slot instead of eight is
  //     the fix, and it needs no caption.
  //   · DÉJÀ VU's maximum is its MIDDLE. Both sections repeat most at 0.5 and
  //     less at 1 (measured period-8 repetition 49/60/76/99.7/77/65/64/62 % on T
  //     and 0/18/68/99.7/65/19/12/11 % on X). The slot opacity is `1 − p`, so
  //     the row brightens INTO the middle of the knob and dims again above it.
  //   · SCALE does nothing at all below STEPS 0.536, and only the degrees whose
  //     WEIGHT clears the level's threshold survive above it. The ruler draws
  //     the surviving degrees solid and the discarded ones faint, so "SCALE is
  //     inert right now" is a ruler with no solid ticks on it.
  //
  // ⚠ NO PROSE ON THIS PANEL — owner directive 2026-08-11. Everything above is
  // the REASON the shapes are what they are; none of it is painted. What paints
  // is two labelled rows, a ruler, an axis of bare values and a scale name.
  //
  // ⚠ AND IT HAS NO CLOCK. There is no playhead, no running step, no analyser:
  // every pixel is a pure function of the live params through
  // `marblesLoopPlan`. marbles FREE-RUNS from the moment it spawns, so anything
  // time-derived would make the VRT baseline a race against boot latency — this
  // tile is identical on a running graph, a frozen one and a silent rack, which
  // is a stronger guarantee than #1420's freeze and does not depend on it.
  //
  // ⚠ THIS PANEL EMITS NO `control-<paramId>` TESTID (shell-cells rule 1). Its
  // one writable affordance is the AXIS MODE, which is PRIVATE VIEW STATE
  // (component state, never `node.data`: relabelling your own picture must not
  // relabel a collaborator's screen or dirty the patch).

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import { marblesDef } from '$lib/audio/modules/marbles';
  import {
    marblesFaceParams,
    marblesLoopPlan,
    marblesRingCaption,
    type MarblesRingAxis,
  } from './marbles-face-model';

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

  /** DURABLE params — the same reader `ModuleShell.readoutValue` uses, so the
   *  picture and the numbers beside it can never disagree. All thirteen of this
   *  module's params are ordinary stored values. */
  let p = $derived.by(() => {
    const node = live.n;
    return marblesFaceParams((id) => {
      const v = node?.params?.[id];
      if (typeof v === 'number') return v;
      return marblesDef.params.find((q) => q.id === id)?.defaultValue;
    });
  });

  let plan = $derived(marblesLoopPlan(p));

  /** COMPONENT STATE — see the header. `step` numbers the slots; `time` prints
   *  where each lands at the current RATE. The flip is also this panel's
   *  declared operability probe: it drives the axis row's text, and the two
   *  labellings can never coincide (asserted in marbles-face-model.test.ts). */
  let axis = $state<MarblesRingAxis>('step');

  /** The axis prints at most this many captions — beyond it a 16-slot row's
   *  labels collide. The SLOTS are always all drawn. */
  const MAX_CAPTIONS = 8;
  let captionSlots = $derived.by(() => {
    const n = Math.max(plan.t.slots, plan.x.slots);
    if (n <= MAX_CAPTIONS) return Array.from({ length: n }, (_, i) => i);
    const stride = Math.ceil(n / MAX_CAPTIONS);
    const out: number[] = [];
    for (let i = 0; i < n; i += stride) out.push(i);
    return out;
  });

  /** Slot fill = how much of the loop survives a step, `1 − p`. Floored so a
   *  fully-free row is still visible as a row. */
  const fill = (pp: number): number => 0.3 + 0.7 * (1 - pp);
</script>

<div class="loop" data-testid="marbles-loop">
  <div class="rows">
    {#each [plan.t, plan.x] as sec, si (si)}
      <div class="row">
        <span class="tag">{si === 0 ? 'T' : 'X'}</span>
        <!-- A section with NO loop is drawn as a HATCHED strip, not as one
             giant slot: "there is no loop here" and "the loop is one step
             long" are different states and must not paint the same. -->
        <div class="slots" class:free={!sec.state.lengthLive} style={`--n:${sec.slots}`}>
          {#each Array.from({ length: sec.slots }, (_, i) => i) as i (i)}
            <span class="slot" style={`--a:${fill(sec.state.p)}`}></span>
          {/each}
        </div>
      </div>
    {/each}
  </div>

  <!-- ⚠ THE AXIS ROW IS THE PANEL'S OPERABILITY PROBE TARGET. Its text is
       computed from the axis mode AND from the live RATE, so a MODE button
       that did nothing cannot change it.

       ⚠ NO `text-overflow: ellipsis`, DELIBERATELY (the bluebox precedent): a
       CSS ellipsis leaves NO TRACE in `textContent`, and this row is exactly
       what faces-parity reads with `toHaveText`. -->
  <div class="axis" data-testid="marbles-loop-axis" style={`--n:${captionSlots.length}`}>
    {#each captionSlots as i (i)}<span>{marblesRingCaption(i, p, axis)}</span>{/each}
  </div>

  <!-- ONE OCTAVE of the selected scale. Solid = a degree this quantiser level
       keeps; faint = a degree it discards. An empty ruler IS "the quantiser is
       off", drawn rather than stated. -->
  <div class="ruler" aria-label="{plan.scaleName}: {plan.degrees.length} of {plan.allDegrees.length} degrees">
    {#each plan.allDegrees as v (v)}
      <span class="deg" class:on={plan.degrees.includes(v)} style={`--x:${(v * 100).toFixed(3)}%`}></span>
    {/each}
  </div>

  <div class="key">
    <span class="k-scale" data-testid="marbles-loop-scale">{plan.scaleName}</span>
    <span class="k-deg">{plan.degrees.length}/{plan.allDegrees.length}</span>
    <button
      type="button"
      class="mode"
      data-testid="marbles-loop-mode"
      title="Label the slots by step number, or by where they land at the current RATE. Your screen only: this is not shared or saved."
      onclick={() => (axis = axis === 'step' ? 'time' : 'step')}>{axis === 'step' ? '#' : 't'}</button
    >
  </div>
</div>

<style>
  .loop {
    width: 100%;
    display: grid;
    grid-template-rows: auto auto auto auto;
    gap: 5px;
  }

  .rows {
    display: grid;
    gap: 4px;
  }
  .row {
    display: grid;
    grid-template-columns: 12px 1fr;
    align-items: center;
    gap: 6px;
  }
  .tag {
    font-size: 9px;
    letter-spacing: 0.06em;
    color: rgb(255 255 255 / 0.42);
  }
  .slots {
    display: grid;
    grid-template-columns: repeat(var(--n), 1fr);
    gap: 2px;
    height: 24px;
  }
  /* NO LOOP — the section is re-rolling every step, so there is nothing to
     draw slots for. A diagonal hatch reads as "empty" where a single filled
     rectangle read as "one very long step". */
  .slots.free {
    background: repeating-linear-gradient(
      -45deg,
      rgb(255 255 255 / 0.06) 0 4px,
      transparent 4px 8px
    );
    border: 1px dashed rgb(255 255 255 / 0.14);
    border-radius: 3px;
  }
  .slots.free .slot {
    display: none;
  }
  /* OPACITY IS `1 − p`: the row is brightest at DÉJÀ VU 0.5 and dims toward
     BOTH ends of the knob, which is the module's behaviour and not a gradient
     chosen to look nice. */
  .slot {
    background: var(--domain, #4dd6c1);
    opacity: var(--a);
    border-radius: 2px;
  }

  .axis {
    display: grid;
    grid-template-columns: repeat(var(--n), 1fr);
    font-size: 9px;
    color: rgb(255 255 255 / 0.42);
    font-variant-numeric: tabular-nums;
    padding-left: 18px;
  }
  .axis > span {
    white-space: nowrap;
    overflow: visible;
    text-align: center;
  }
  .axis > span:first-child {
    text-align: left;
  }
  .axis > span:last-child {
    text-align: right;
  }

  .ruler {
    position: relative;
    height: 14px;
    margin-left: 18px;
    background: rgb(0 0 0 / 0.35);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 3px;
  }
  .deg {
    position: absolute;
    top: 2px;
    bottom: 2px;
    left: var(--x);
    width: 2px;
    background: rgb(255 255 255 / 0.14);
  }
  .deg.on {
    background: var(--domain, #4dd6c1);
    top: 0;
    bottom: 0;
  }

  .key {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .k-scale {
    color: var(--domain, #4dd6c1);
  }
  .k-deg {
    color: rgb(255 255 255 / 0.42);
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
    padding: 1px 6px;
    cursor: pointer;
  }
  .key .mode:hover {
    background: rgb(255 255 255 / 0.12);
  }
</style>
