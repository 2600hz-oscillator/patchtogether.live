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

  // ── Geometry ────────────────────────────────────────────────────────────
  //
  // A 100-wide viewBox, one lane per channel, row count derived.
  //
  // ⚠ TWO DECISIONS HERE ARE CORRECTIONS TO WHAT THE FIRST LINUX CAPTURE
  // ACTUALLY DREW, and both were bugs a DOM assertion could not see:
  //
  //  1. THE LOGIC BLOCK IS ABOVE THE LANES, not below them. Below, the tap
  //     rail had to run down PAST in3 and in4 to reach it, crossing two wires
  //     belonging to channels the logic block does not touch — in a picture
  //     whose entire job is to say which channels it touches. Above, each tap
  //     rises from its own lane and the only wire it can cross belongs to the
  //     OTHER tapped channel, which is true rather than misleading. The two
  //     taps also leave at DIFFERENT x so they read as two taps, not one bus.
  //  2. THERE ARE TWO BUSES AND THE PICTURE DRAWS TWO. The first version drew
  //     ONE vertical line labelled `sum` at the top and `diff` at the bottom,
  //     which says "one bus with two names" — and worse, it hung the +/− marks
  //     on it, implying the polarity split applies to both. It does not: EVERY
  //     channel enters SUM positively and only DIFF splits. Two lines, one
  //     +/− column against DIFF alone.
  const W = 100;
  const LANE_H = 14;
  /** Room above lane 0 for the logic block. */
  const TOP = 22;
  const X_IN = 1;
  /** Where each LOGIC tap leaves the raw line — UPSTREAM of the triangle, and
   *  one x per tapped channel so two taps do not draw as one. */
  const tapX = (i: number) => 17 + i * 4;
  const X_TRI = 29;
  const TRI_W = 12;
  const X_SUM = 66;
  const X_DIFF = 82;
  const LOGIC_Y = 9;

  let H = $derived(TOP + rows.length * LANE_H + 12);
  const laneY = (i: number) => TOP + i * LANE_H + LANE_H / 2;
  const fillW = (a: number) => Math.min(1, Math.abs(a)) * TRI_W;
  let lastY = $derived(laneY(rows.length - 1));
</script>

<div class="illogic-routing" data-testid="sidebar-panel-illogic-routing">
  <svg viewBox="0 0 {W} {H}" role="img" aria-label="illogic routing: logic taps sit before the attenuverters">
    <!-- LOGIC TAP RAIL: drawn FIRST and in a lighter weight so it reads as a
         separate, parallel path rather than a continuation of the mix chain. -->
    {#each rows as r (r.paramId)}
      {#if r.logic}
        <path
          class="tap"
          d="M {tapX(r.index)} {laneY(r.index)} L {tapX(r.index)} {LOGIC_Y}"
          fill="none"
        />
        <circle class="tap-dot" cx={tapX(r.index)} cy={laneY(r.index)} r="1.2" />
      {/if}
    {/each}

    <!-- THE LOGIC BLOCK, fed only by the raw taps above the attenuverters. -->
    <rect class="logic-box" x="12" y={LOGIC_Y - 5} width="56" height="10" rx="1.5" />
    <text class="logic-lbl" x="40" y={LOGIC_Y + 1.9} text-anchor="middle">and or nand not</text>

    {#each rows as r (r.paramId)}
      {@const y = laneY(r.index)}
      <!-- the raw input line, all the way to the triangle -->
      <line class="wire" x1={X_IN + 11} y1={y} x2={X_TRI} y2={y} />
      <text class="lbl" x={X_IN} y={y + 1.9}>{illogicChannelInputId(r.index)}</text>

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
        points="{X_TRI},{y - 4.5} {X_TRI + TRI_W},{y} {X_TRI},{y + 4.5}"
      />
      <clipPath id="illogic-clip-{nodeId}-{r.index}">
        <rect x={X_TRI} y={y - 4.5} width={fillW(r.amount)} height="9" />
      </clipPath>
      <polygon
        class="tri-fill"
        class:neg={r.amount < 0}
        points="{X_TRI},{y - 4.5} {X_TRI + TRI_W},{y} {X_TRI},{y + 4.5}"
        clip-path="url(#illogic-clip-{nodeId}-{r.index})"
      />

      <!-- POST-ATTENUVERTER, to BOTH mix buses. Every channel enters SUM
           positively (the dot on the first bus); only DIFF splits, so the
           +/− column sits against DIFF alone. -->
      <line class="wire" x1={X_TRI + TRI_W} y1={y} x2={X_DIFF} y2={y} />
      <circle class="junction" cx={X_SUM} cy={y} r="1.2" />
      <circle class="junction" cx={X_DIFF} cy={y} r="1.2" />
      <text class="sign" class:neg={r.diffSign < 0} x={X_DIFF - 3} y={y - 1.6} text-anchor="end"
        >{r.diffSign < 0 ? '−' : '+'}</text
      >
    {/each}

    <!-- THE TWO MIX BUSES, drawn as two. -->
    <line class="bus" x1={X_SUM} y1={laneY(0)} x2={X_SUM} y2={lastY + 5} />
    <line class="bus" x1={X_DIFF} y1={laneY(0)} x2={X_DIFF} y2={lastY + 5} />
    <text class="bus-lbl" x={X_SUM} y={lastY + 11} text-anchor="middle">sum</text>
    <text class="bus-lbl" x={X_DIFF} y={lastY + 11} text-anchor="middle">diff</text>
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
  /* A junction dot means "this wire CONNECTS here", the schematic convention —
     without it a wire that merely crosses a bus is indistinguishable from one
     that joins it, and this picture has both. */
  .junction {
    fill: var(--cable-cv, #7aa2f7);
    opacity: 0.9;
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
    font-size: 4px;
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  /* ⚠ THE BOX IS 56 WIDE FOR 14 CHARACTERS AT 4px. The first linux capture
     shipped this label CLIPPED — "and or nand no" — because the box was 30
     wide and the text was left-anchored inside it. A DOM assertion cannot see
     an overflowing <text>, so the geometry carries the margin instead: centred
     in the box, and the box sized for the string it holds. */
  .logic-lbl {
    fill: var(--cable-gate, #9ece6a);
    font-size: 4px;
  }
  .bus-lbl {
    fill: var(--cable-cv, #7aa2f7);
  }
  /* THE POLARITY COLUMN, against DIFF alone. It is the only mark on the picture
     that distinguishes the two buses, so it is drawn at full contrast rather
     than in the dim label colour — a `−` nobody can read makes DIFF look like a
     second SUM, which is the exact misreading this panel exists to prevent. */
  .sign {
    fill: var(--cable-cv, #7aa2f7);
    font-size: 5px;
  }
  .sign.neg {
    fill: var(--warn, #e0af68);
  }
</style>
