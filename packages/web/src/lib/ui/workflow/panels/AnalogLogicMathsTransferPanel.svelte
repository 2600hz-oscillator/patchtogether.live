<script lang="ts">
  // THE TRANSFER CURVE — a registered `custom` dock-sidebar panel (PF-20) for
  // ANALOGLOGICMATHS.
  //
  // This picture exists for ONE fact, and it is the fact the module's two dials
  // and five jacks cannot state between them: SUM BENDS AND DIFF DOES NOT, AND
  // IT IS THE STRAIGHT LINE THAT LEAVES THE RAIL. `glyph: 'none'` (five `cv`
  // outputs, no `audio`), so the shell paints no tile — this is the module's
  // only drawing.
  //
  // Measured on the shipping worklet
  // (art/scenarios/analog-logic-maths/face-audit.test.ts): with both dials at
  // their shipped +1, a full-scale common-mode input leaves SUM at 0.964 — a
  // −6.34 dB compression against the un-clipped ×2.00 — while DIFF's worst case
  // is ±2.00 with no clip at all. Four numbers say that; one drawing shows it.
  //
  // ⚠ ONE STIMULUS FOR BOTH CURVES, and that is a decision rather than a
  // convenience. Both are traced under a COMMON-MODE input — the same drive the
  // `sum` and `diff` readouts are stated at — so the picture and the readout row
  // two inches away cannot disagree. Driving DIFF anti-phase instead would have
  // drawn a livelier line and a different measurement from the printed one.
  //
  // What that buys, and it is the module's most useful gesture: at the shipped
  // defaults SUM is the bent curve and DIFF lies FLAT ON ZERO (the common-mode
  // null). Invert ATT B and the two SWAP — SUM collapses to the flat line and
  // DIFF becomes the steep straight one running out past the rail.
  //
  // NOT A TRACE, deliberately. Every mark comes from `analog-logic-maths-face-
  // model` — the live dial values and nothing else — so the tile is
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
    ALM_PROBE,
    almFaceParams,
    almTransferCurves,
    almTransferSpan,
    type AlmTransferCurve,
  } from '$lib/ui/modules/analog-logic-maths-face-model';

  interface Props {
    nodeId: string;
    props?: Readonly<Record<string, string | number>>;
    /** The def's params — needed for the DEFAULT fallback below. */
    params?: readonly ParamDef[];
  }
  let { nodeId, params = [] }: Props = $props();

  /**
   * THE `?? defaultValue` IS LOAD-BEARING. `node.params` is a SPARSE overlay of
   * what has been TOUCHED, so reading it bare draws two flat lines beside two
   * faders sitting at +1 on a fresh spawn (the StereoCrossoverPanel scar).
   *
   * THE VERSION IS READ INSIDE THE DERIVED (the ModuleShell `liveCell`
   * pattern): `patch.nodes[id]` is a stable SyncedStore proxy, so a derived that
   * does not touch `nodeVersion(id)` freezes at first render.
   */
  let atts = $derived.by<number[]>(() => {
    void nodeVersion(nodeId);
    const n = patch.nodes[nodeId] as ModuleNode | undefined;
    const live = n?.params as Record<string, number> | undefined;
    return almFaceParams((id) => {
      const v = live?.[id];
      if (typeof v === 'number') return v;
      return params.find((p) => p.id === id)?.defaultValue;
    });
  });

  let curves = $derived<AlmTransferCurve[]>(almTransferCurves(atts));
  let span = $derived(almTransferSpan(atts));

  // ── Geometry ────────────────────────────────────────────────────────────
  //
  // A square-ish viewBox: input on x ∈ [−probe, +probe], output on y ∈
  // [−span, +span]. The RAIL marks are drawn at ±probe on the y axis, which is
  // the whole reason `span` is derived from the dials rather than pinned — a
  // pair at ±0.4 would otherwise draw two near-flat lines in the middle of an
  // empty box.
  const W = 100;
  const H = 76;
  const PAD_L = 3;
  const PAD_R = 3;
  const PAD_Y = 5;
  /** How many points per traced curve. Even a straight line is sampled, so both
   *  paths are the same kind of object and a future non-linear DIFF would need
   *  no new code. */
  const STEPS = 48;

  const px = (x: number) => PAD_L + ((x + ALM_PROBE) / (2 * ALM_PROBE)) * (W - PAD_L - PAD_R);
  let py = $derived((y: number) => H / 2 - (y / span) * (H / 2 - PAD_Y));

  let paths = $derived(
    curves.map((c) => {
      const pts: string[] = [];
      for (let i = 0; i <= STEPS; i++) {
        const x = -ALM_PROBE + (2 * ALM_PROBE * i) / STEPS;
        const y = c.at(x);
        pts.push(`${i === 0 ? 'M' : 'L'} ${px(x).toFixed(2)} ${py(y).toFixed(2)}`);
      }
      return { outId: c.outId, clipped: c.clipped, d: pts.join(' ') };
    }),
  );

  /** The ±1 rail, in panel y. Drawn only when it is inside the box — which,
   *  given `almTransferSpan`'s floor, it always is. */
  let railHi = $derived(py(ALM_PROBE));
  let railLo = $derived(py(-ALM_PROBE));
</script>

<div class="alm-transfer" data-testid="sidebar-panel-alm-transfer">
  <svg
    viewBox="0 0 {W} {H}"
    role="img"
    aria-label="analoglogicmaths transfer: SUM saturates, DIFF stays linear and crosses the rail"
  >
    <!-- ZERO axes first, so the curves read as marks ON a grid. -->
    <line class="axis" x1={PAD_L} y1={H / 2} x2={W - PAD_R} y2={H / 2} />
    <line class="axis" x1={px(0)} y1={PAD_Y} x2={px(0)} y2={H - PAD_Y} />

    <!-- THE ±1 RAIL. The one reference mark on the picture: everything inside
         these two lines is on the bus convention, everything outside is not. -->
    <line class="rail" x1={PAD_L} y1={railHi} x2={W - PAD_R} y2={railHi} />
    <line class="rail" x1={PAD_L} y1={railLo} x2={W - PAD_R} y2={railLo} />

    {#each paths as p (p.outId)}
      <path class="curve {p.clipped ? 'clipped' : 'linear'}" d={p.d} fill="none" />
    {/each}

    <!-- Plain labels, no prose (owner ruling 2026-08-11). -->
    {#each paths as p, i (p.outId)}
      <text class="tag {p.clipped ? 'clipped' : 'linear'}" x={W - PAD_R} y={PAD_Y + 6 + i * 8}>
        {p.outId}
      </text>
    {/each}
    <text class="rail-tag" x={PAD_L + 1} y={railHi - 1.5}>±1</text>
  </svg>
</div>

<style>
  .alm-transfer {
    width: 100%;
    padding: 2px 0;
  }
  .alm-transfer svg {
    width: 100%;
    height: auto;
    display: block;
  }
  .axis {
    stroke: var(--panel-border, #3a3a3a);
    stroke-width: 0.5;
  }
  .rail {
    stroke: var(--text-dim, #808080);
    stroke-width: 0.5;
    stroke-dasharray: 2 2;
    opacity: 0.75;
  }
  .curve {
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .curve.clipped {
    stroke: var(--cable-cv, #7fd1b9);
  }
  .curve.linear {
    stroke: var(--cable-gate, #e0a458);
  }
  .tag {
    font-size: 6px;
    text-anchor: end;
    font-family: var(--font-mono, monospace);
  }
  .tag.clipped {
    fill: var(--cable-cv, #7fd1b9);
  }
  .tag.linear {
    fill: var(--cable-gate, #e0a458);
  }
  .rail-tag {
    font-size: 5px;
    fill: var(--text-dim, #808080);
    font-family: var(--font-mono, monospace);
  }
</style>
