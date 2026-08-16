<script lang="ts">
  // THE ROUTING MAP — a registered `custom` dock-sidebar panel (PF-20) for
  // ILLOGIC.
  //
  // This picture exists for ONE fact, and it is the fact the module's four
  // knobs and ten jacks cannot state between them: THE LOGIC TAPS LEAVE THE
  // INPUT LINE BEFORE THE ATTENUVERTER. Measured on the shipping factory
  // (art/scenarios/illogic/face-audit.test.ts): sweeping any attenuverter its
  // full -1 -> +1 travel moves AND / NAND / OR / NOT by bit-exactly 0.0000e+0,
  // while it moves that channel's ATT jack and both mix buses. A card showing
  // four faders above ten jacks makes that look impossible; a drawing in which
  // the boolean taps branch UPSTREAM of the triangles makes it obvious.
  //
  // The second thing only a drawing says: the four channels are NOT
  // interchangeable. Channels 1-2 are added in the DIFF bus and tapped by the
  // logic block; channels 3-4 are SUBTRACTED there and reach no boolean jack at
  // all. That asymmetry is the whole ranking argument, and it is drawn rather
  // than argued.
  //
  // The triangle is the standard attenuverter symbol: filled from the left in
  // proportion to |amount|, and HATCHED when the coefficient is negative, so
  // the one thing a level meter is structurally blind to — the sign flip — is
  // the most visible mark on the row.
  //
  // NOT A TRACE, deliberately. Every mark comes from `illogic-face-model` — the
  // live attenuverter values plus the structural routing — so the tile is
  // deterministic on a running graph, a frozen one and a silent rack alike, and
  // its VRT baseline is not a race.
  //
  // It emits NO `control-<paramId>` testid: this is a READ-ONLY picture, and a
  // control-shaped testid would read as an unbacked extra control to
  // faces-parity's exact multiset (see sidebar-panels.ts rule 1).

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import {
    illogicChannelRows,
    illogicChannelInputId,
    type IllogicChannelRow,
  } from '$lib/ui/modules/illogic-face-model';

  interface Props {
    nodeId: string;
    props?: Readonly<Record<string, string | number>>;
    /** The def's params — needed for the DEFAULT fallback below. */
    params?: readonly ParamDef[];
  }
  let { nodeId, params = [] }: Props = $props();

  /**
   * THE `?? defaultValue` IS LOAD-BEARING. `node.params` is a SPARSE overlay of
   * what has been TOUCHED, so reading it bare draws every triangle empty beside
   * four faders sitting at +1 on a fresh spawn (the StereoCrossoverPanel scar).
   *
   * THE VERSION IS READ INSIDE THE DERIVED (the ModuleShell `liveCell`
   * pattern): `patch.nodes[id]` is a stable SyncedStore proxy, so a derived
   * that does not touch `nodeVersion(id)` freezes at first render.
   */
  let rows = $derived.by<IllogicChannelRow[]>(() => {
    void nodeVersion(nodeId);
    const n = patch.nodes[nodeId] as ModuleNode | undefined;
    const live = n?.params as Record<string, number> | undefined;
    return illogicChannelRows((id) => {
      const v = live?.[id];
      if (typeof v === 'number') return v;
      return params.find((p) => p.id === id)?.defaultValue;
    });
  });

  // Geometry: a 100-wide viewBox, one lane per channel, rows derived.
  const W = 100;
  const LANE_H = 15;
  const TOP = 9;
  const X_IN = 2;
  /** Where the LOGIC tap leaves the raw line — UPSTREAM of the triangle. */
  const X_TAP = 25;
  const X_TRI = 35;
  const TRI_W = 14;
  const X_BUS = 76;

  let H = $derived(TOP + rows.length * LANE_H + 22);
  let logicY = $derived(TOP + rows.length * LANE_H + 12);
  const laneY = (i: number) => TOP + i * LANE_H + LANE_H / 2;
  const fillW = (a: number) => Math.min(1, Math.abs(a)) * TRI_W;
</script>

<div class="illogic-routing" data-testid="sidebar-panel-illogic-routing">
  <svg viewBox="0 0 {W} {H}" role="img" aria-label="illogic routing: logic taps sit before the attenuverters">
    <!-- LOGIC TAP RAIL: drawn FIRST and in a lighter weight so it reads as a
         separate, parallel path rather than a continuation of the mix chain. -->
    {#each rows as r (r.paramId)}
      {#if r.logic}
        <path
          class="tap"
          d="M {X_TAP} {laneY(r.index)} L {X_TAP} {logicY} L {X_TAP + 6} {logicY}"
          fill="none"
        />
        <circle class="tap-dot" cx={X_TAP} cy={laneY(r.index)} r="1.3" />
      {/if}
    {/each}

    {#each rows as r (r.paramId)}
      {@const y = laneY(r.index)}
      <!-- the raw input line, all the way to the triangle -->
      <line class="wire" x1={X_IN + 12} y1={y} x2={X_TRI} y2={y} />
      <text class="lbl" x={X_IN} y={y + 2.6}>{illogicChannelInputId(r.index)}</text>

      <!-- the attenuverter triangle. The row carries its own state as data-
           attributes so the e2e can read WHAT WAS DRAWN rather than infer it
           from pixels: the sign, the amount, the DIFF polarity, and whether the
           logic block taps this channel. -->
      <polygon
        class="tri"
        data-testid="illogic-row-{illogicChannelInputId(r.index)}"
        data-amount={r.amount}
        data-neg={r.amount < 0}
        data-diff-sign={r.diffSign}
        data-logic={r.logic}
        points="{X_TRI},{y - 5} {X_TRI + TRI_W},{y} {X_TRI},{y + 5}"
      />
      <clipPath id="illogic-clip-{nodeId}-{r.index}">
        <rect x={X_TRI} y={y - 5} width={fillW(r.amount)} height="10" />
      </clipPath>
      <polygon
        class="tri-fill"
        class:neg={r.amount < 0}
        points="{X_TRI},{y - 5} {X_TRI + TRI_W},{y} {X_TRI},{y + 5}"
        clip-path="url(#illogic-clip-{nodeId}-{r.index})"
      />

      <!-- post-attenuverter: to the mix buses, with the DIFF polarity marked -->
      <line class="wire" x1={X_TRI + TRI_W} y1={y} x2={X_BUS} y2={y} />
      <text class="sign" x={X_BUS - 8} y={y + 2.6}>{r.diffSign < 0 ? '−' : '+'}</text>
    {/each}

    <!-- the two mix buses -->
    <line class="bus" x1={X_BUS} y1={laneY(0)} x2={X_BUS} y2={laneY(rows.length - 1)} />
    <text class="bus-lbl" x={X_BUS + 3} y={laneY(0) + 2.6}>sum</text>
    <text class="bus-lbl" x={X_BUS + 3} y={laneY(rows.length - 1) + 2.6}>diff</text>

    <!-- the logic block, fed only by the tapped raw lines -->
    <rect class="logic-box" x={X_TAP + 6} y={logicY - 5} width="30" height="10" rx="1.5" />
    <text class="logic-lbl" x={X_TAP + 8} y={logicY + 2.6}>and or nand not</text>
  </svg>
</div>

<style>
  .illogic-routing {
    width: 100%;
  }
  .illogic-routing svg {
    display: block;
    width: 100%;
    height: auto;
  }
  .wire {
    stroke: var(--cable-cv, #7aa2f7);
    stroke-width: 0.9;
    opacity: 0.75;
  }
  .bus {
    stroke: var(--cable-cv, #7aa2f7);
    stroke-width: 1.6;
    opacity: 0.9;
  }
  /* The logic path is a DIFFERENT WEIGHT on purpose — it is a second, parallel
     signal path, not a branch of the mix chain. */
  .tap {
    stroke: var(--cable-gate, #9ece6a);
    stroke-width: 0.55;
    stroke-dasharray: 2 1.4;
    opacity: 0.85;
  }
  .tap-dot {
    fill: var(--cable-gate, #9ece6a);
    opacity: 0.85;
  }
  .tri {
    fill: none;
    stroke: var(--text-dim, #8b93a7);
    stroke-width: 0.7;
  }
  .tri-fill {
    fill: var(--cable-cv, #7aa2f7);
    opacity: 0.55;
  }
  /* THE SIGN, made visible. A level meter cannot see it; this can. */
  .tri-fill.neg {
    fill: var(--warn, #e0af68);
    opacity: 0.75;
  }
  .logic-box {
    fill: none;
    stroke: var(--cable-gate, #9ece6a);
    stroke-width: 0.7;
    opacity: 0.9;
  }
  text {
    fill: var(--text-dim, #8b93a7);
    font-size: 4.2px;
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .logic-lbl {
    fill: var(--cable-gate, #9ece6a);
    font-size: 3.8px;
  }
  .bus-lbl {
    fill: var(--cable-cv, #7aa2f7);
  }
  .sign {
    font-size: 5px;
  }
</style>
