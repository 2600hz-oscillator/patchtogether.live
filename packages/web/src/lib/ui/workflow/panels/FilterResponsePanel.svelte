<script lang="ts">
  // FILTER RESPONSE — a registered `custom` dock-sidebar panel (PF-20).
  //
  // The picture: the SELECTED mode's magnitude response on a log frequency
  // ruler, at the LIVE cutoff and resonance, with the CV REACH window shaded
  // behind it — so the plot and the hero strip's `cv reach` are the same fact
  // drawn twice.
  //
  // WHY IT IS A SIDEBAR PANEL AND NOT A `hero.cell`. A hero picture is a PF-14
  // panel CELL, and `module-face-lint` refuses a panel selected at a lane tier;
  // with five params a panel key lands at rank 6, inside `faceTierCap('full')`,
  // so it would fail outright. A sidebar panel gets the same picture for ZERO
  // contract lines, no ControlFamily and no operability probe.
  //
  // WHY A PICTURE AT ALL. The face's glyph is `scope` — a live trace of the
  // module's own output — and a filter is an INSERT, so on a silent rack it is
  // a flat line, which is most of the time a player is looking at it. This is
  // param-derived, so it is alive with nothing patched, and it makes visible
  // three things the module only states in prose: the HP's 6 dB/oct tail below
  // fc/Q, the BP's 3 dB centre dip at zero resonance, and the uncompensated
  // peak riding on an unmoved passband.
  //
  // ⚠ IT DRAWS NO NUMBER OF ITS OWN. Every value comes from
  // `filter-face-model`, the same module `filter-peak-db` maximises — one
  // source of truth for the response law, so the curve and the caption cannot
  // disagree.
  //
  // ⚠ It emits NO `control-<paramId>` testid — a read-only picture, per
  // sidebar-panels.ts rule 1.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import {
    PLOT_FLOOR_DB,
    PLOT_TOP_DB,
    filterCutoffReach,
    filterFaceParams,
    filterPeakDbText,
    filterPlotX,
    filterQ,
    filterResponseCurve,
  } from '$lib/ui/modules/filter-face-model';

  interface Props {
    nodeId: string;
    /** Declared block props: the param ids this picture reads. Kept in the
     *  DECLARATION rather than hardcoded, per the sidebar-panels contract. */
    props?: Readonly<Record<string, string | number>>;
    /** The def's params — the DEFAULT fallback for an untouched node. */
    params?: readonly ParamDef[];
  }
  let { nodeId, props = {}, params = [] }: Props = $props();

  const idProp = (k: string, fallback: string): string =>
    typeof props[k] === 'string' ? (props[k] as string) : fallback;

  let cutoffParam = $derived(idProp('cutoffParam', 'cutoff'));
  let resParam = $derived(idProp('resParam', 'resonance'));
  let modeParam = $derived(idProp('modeParam', 'mode'));
  let depthParam = $derived(idProp('depthParam', 'cutoff_cv_amt'));

  /**
   * Live params off the DURABLE store (the readout rule — an engine read from
   * markup is not reactive), resolving the def DEFAULT for anything untouched.
   * `node.params` is a sparse overlay: reading it bare draws a picture of a
   * 20 Hz filter beside a dial saying 1.0 kHz.
   */
  let live = $derived.by(() => {
    void nodeVersion(nodeId);
    const n = patch.nodes[nodeId] as ModuleNode | undefined;
    const stored = (n?.params as Record<string, number> | undefined) ?? {};
    const byDeclaredId: Record<string, string> = {
      cutoff: cutoffParam,
      resonance: resParam,
      mode: modeParam,
      cutoff_cv_amt: depthParam,
    };
    return filterFaceParams((id) => {
      const src = byDeclaredId[id] ?? id;
      const v = stored[src];
      if (typeof v === 'number') return v;
      return params.find((p) => p.id === src)?.defaultValue;
    });
  });

  let curve = $derived(filterResponseCurve(live, 128));
  let reach = $derived(filterCutoffReach(live));
  let q = $derived(filterQ(live.resonance));

  // ── SVG geometry, 0..100 × 0..44 user space ────────────────────────────────
  const W = 100;
  const H = 44;
  const PAD_Y = 2;
  const px = (x: number): number => x * W;
  const py = (y: number): number => H - PAD_Y - y * (H - 2 * PAD_Y);

  let path = $derived(
    curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(2)},${py(p.y).toFixed(2)}`).join(' '),
  );
  /** The 0 dB line — the passband the peak rides ON TOP of, uncompensated. */
  let unityY = $derived(py((0 - PLOT_FLOOR_DB) / (PLOT_TOP_DB - PLOT_FLOOR_DB)));
  let cutoffX = $derived(px(filterPlotX(live.cutoff)));
  let reachX0 = $derived(px(filterPlotX(reach.lo)));
  let reachX1 = $derived(px(filterPlotX(reach.hi)));
  let modeName = $derived(['LP', 'HP', 'BP'][Math.round(live.mode)] ?? '—');
</script>

<div class="fresp" data-testid="sidebar-panel-filter-response">
  <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
    <!-- THE CV REACH WINDOW: where a full-scale CV can throw the corner. The
         same endpoints the hero strip prints, drawn. Absent when the depth
         knob is at 0, which is exactly when the jack does nothing. -->
    {#if !reach.muted}
      <rect x={reachX0} y="0" width={Math.max(0, reachX1 - reachX0)} height={H} class="reach" />
    {/if}
    <!-- 0 dB: the passband. The resonant peak sits ABOVE it because nothing
         here is gain-compensated. -->
    <line x1="0" y1={unityY} x2={W} y2={unityY} class="unity" />
    <!-- the corner / centre frequency -->
    <line x1={cutoffX} y1="0" x2={cutoffX} y2={H} class="corner" />
    <path d={path} class="curve" />
  </svg>
  <div class="fresp-legend">
    <span class="lo">{modeName} · q {q.toFixed(1)}</span>
    <span class="hi" data-testid="sidebar-panel-filter-peak">{filterPeakDbText(live)}</span>
  </div>
</div>

<style>
  .fresp {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .fresp svg {
    width: 100%;
    height: 84px;
    display: block;
    background: var(--inset, #0a0c0f);
    border: 1px solid var(--line, #2c3037);
    border-radius: 5px;
  }
  .reach {
    fill: var(--domain, #38d3c8);
    opacity: 0.08;
  }
  .unity {
    stroke: var(--dim, #9aa2ad);
    stroke-width: 1;
    stroke-dasharray: 2 3;
    opacity: 0.45;
    vector-effect: non-scaling-stroke;
  }
  .corner {
    stroke: var(--domain, #38d3c8);
    stroke-width: 1;
    stroke-dasharray: 2 2;
    opacity: 0.6;
    vector-effect: non-scaling-stroke;
  }
  .curve {
    fill: none;
    stroke: var(--domain, #38d3c8);
    stroke-width: 1.5;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }
  .fresp-legend {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-family: var(--f-mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .fresp-legend .lo {
    color: var(--dim, #9aa2ad);
  }
  .fresp-legend .hi {
    color: var(--domain, #38d3c8);
    font-weight: 700;
  }
</style>
