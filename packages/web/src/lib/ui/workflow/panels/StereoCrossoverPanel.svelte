<script lang="ts">
  // STEREO CROSSOVER — a registered `custom` dock-sidebar panel (PF-20).
  //
  // The picture: a log frequency ruler with the module's split marked, MONO
  // below it, and above it two traces that separate by the live WIDTH. It says
  // in one glance the thing a stereo-widening voice most needs to say and that
  // no knob can — that the low end is mono NO MATTER WHERE WIDTH SITS.
  //
  // GENERIC, per the sidebar-panels contract: the split frequency and the width
  // param id are DECLARED by the face's block (`props`), never hardcoded here,
  // so any module with a fixed-split M/S stage can register the same picture.
  //
  // ⚠ It emits NO `control-<paramId>` testid — it is a READ-ONLY picture, and a
  // control-shaped testid would read as an unbacked extra control to
  // faces-parity's exact multiset (see sidebar-panels.ts rule 1).

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import { xoverFrac, xoverSpread, xoverHzText } from './stereo-crossover-model';

  interface Props {
    nodeId: string;
    /** Declared block props: `splitHz` (the crossover, Hz) + `widthParam` (the
     *  param id whose value opens the sides). */
    props?: Readonly<Record<string, string | number>>;
    /** The def's params — needed for the DEFAULT fallback below. */
    params?: readonly ParamDef[];
  }
  let { nodeId, props = {}, params = [] }: Props = $props();

  let splitHz = $derived(typeof props.splitHz === 'number' ? props.splitHz : 120);
  let widthParam = $derived(typeof props.widthParam === 'string' ? props.widthParam : 'width');

  /**
   * The live WIDTH, off the durable param (the readout rule — an engine read
   * from markup is not reactive; see ModuleShell.readoutValue).
   *
   * ⚠ THE `?? defaultValue` IS THE WHOLE FIX, not defensive noise. A freshly
   * spawned node carries only the params someone has TOUCHED — `node.params`
   * is a sparse overlay, and every other surface (card-kit's `paramVal`, the
   * sidebar's `readParam`) resolves the gap against the def. Falling back to a
   * bare 0 instead made this panel print `WIDTH 0%` next to a dial reading
   * 0.20 on a default kickdrum: a picture contradicting the control beside it,
   * which is the exact divergence class CLAUDE.md documents. Caught by looking
   * at the render; pinned by faceplate-platform.spec.ts.
   */
  let width = $derived.by(() => {
    void nodeVersion(nodeId);
    const n = patch.nodes[nodeId] as ModuleNode | undefined;
    const v = (n?.params as Record<string, number> | undefined)?.[widthParam];
    if (typeof v === 'number') return v;
    return params.find((p) => p.id === widthParam)?.defaultValue ?? 0;
  });

  // Geometry in the SVG's 0..100 × 0..40 user space.
  let splitX = $derived(4 + xoverFrac(splitHz) * 92);
  let spread = $derived(xoverSpread(width));
  /** Half-separation of the two upper traces, in user units (max 9). */
  let sep = $derived(spread * 9);
</script>

<div class="xover" data-testid="sidebar-panel-stereo-crossover">
  <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
    <!-- MONO region (below the split) -->
    <rect x="0" y="0" width={splitX} height="40" class="mono-zone" />
    <!-- the split itself -->
    <line x1={splitX} y1="2" x2={splitX} y2="38" class="split" />
    <!-- mono trace below: ONE line, dead centre -->
    <line x1="2" y1="20" x2={splitX} y2="20" class="trace mono" />
    <!-- stereo traces above: two lines separating by WIDTH -->
    <line x1={splitX} y1={20 - sep} x2="98" y2={20 - sep} class="trace side" />
    <line x1={splitX} y1={20 + sep} x2="98" y2={20 + sep} class="trace side" />
  </svg>
  <div class="xover-legend">
    <span class="lo">mono &lt; {xoverHzText(splitHz, 'Hz')}</span>
    <span class="hi" data-testid="sidebar-panel-width">width {(spread * 100).toFixed(0)}%</span>
  </div>
</div>

<style>
  .xover {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .xover svg {
    width: 100%;
    height: 46px;
    display: block;
    background: var(--inset, #0a0c0f);
    border: 1px solid var(--line, #2c3037);
    border-radius: 5px;
  }
  .mono-zone {
    fill: var(--domain, #38d3c8);
    opacity: 0.07;
  }
  .split {
    stroke: var(--domain, #38d3c8);
    stroke-width: 1;
    stroke-dasharray: 2 2;
    opacity: 0.8;
    vector-effect: non-scaling-stroke;
  }
  .trace {
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }
  .trace.mono {
    stroke: var(--dim, #9aa2ad);
  }
  .trace.side {
    stroke: var(--domain, #38d3c8);
  }
  .xover-legend {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-family: var(--f-mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .xover-legend .lo {
    color: var(--dim, #9aa2ad);
  }
  .xover-legend .hi {
    color: var(--domain, #38d3c8);
    font-weight: 700;
  }
</style>
