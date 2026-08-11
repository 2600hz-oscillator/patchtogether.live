<script lang="ts">
  // SVF RESPONSE — a registered `custom` dock-sidebar panel (PF-20).
  //
  // The DELIVERED response of a state-variable filter at its live settings: the
  // selected mode's curve on a log frequency ruler, the CUTOFF CV window shaded
  // behind it, and the WET-ONLY curve dashed underneath so the MIX knob has
  // something to move.
  //
  // ⚠ IT SWITCHES TO PHASE IN ALLPASS, AND THAT IS THE DESIGN RATHER THAN A
  // FLOURISH. Measured on the shipping DSP, the allpass tap's output level is
  // invariant to RESONANCE to every digit the instrument has — −4.804 dB
  // broadband at resonance 0, 0.001, 0.1, 0.3, 0.6, 0.9 AND 1.0, a span of
  // exactly 0.00 dB — while `max|Δ|` against resonance 0 runs 9.3e-4 → 1.4e0
  // over the same travel. A magnitude plot would therefore draw a perfectly
  // flat line for the one mode whose dial is hardest to understand: a picture
  // certifying that the control does nothing. So AP draws its phase instead.
  // (At MIX < 1 the allpass's DELIVERED magnitude is no longer flat — the dry
  // path cancels against the rotating phase and it becomes a phaser — so the
  // magnitude trace comes back as the dashed reference and phase leads.)
  //
  // ⚠ IT DRAWS NO NUMBER OF ITS OWN. Every value comes from
  // `resofilter-face-model`, the same module the three hero readouts call, so
  // the curve and the captions cannot disagree. That is not a style rule: it is
  // what stops this face repeating the noise defect, where a hero readout and a
  // sidebar entry printed two different true values of the same quantity.
  //
  // ⚠ It emits NO `control-<paramId>` testid — a read-only picture, per
  // sidebar-panels.ts rule 1.
  //
  // GENERIC-ISH, and it says how far: the response law is the TPT SVF's, shared
  // by `pentemelodica` (whose fourth tap is the same real notch) and by any
  // future `resToK`-damped SVF. The param IDS are declared through the block's
  // `props`. What is NOT yet generic is the damping law itself — `k = 2 − 2·res`
  // is imported from resofilter's DSP lib. Widen that behind a declared prop
  // when a second adopter arrives, not now, on one module's guess.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import { RESOFILTER_MODE_SHORT } from '$lib/audio/modules/resofilter';
  import {
    MODES_WITH_PEAK,
    PLOT_FLOOR_DB,
    PLOT_TOP_DB,
    resofilterFaceParams,
    resofilterPeakText,
    resofilterWidthText,
    svfCutoffReach,
    svfPhaseCurve,
    svfPlotX,
    svfResponseCurve,
    svfWetCurve,
    type ResofilterFaceParams,
  } from '$lib/ui/modules/resofilter-face-model';

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
  let mixParam = $derived(idProp('mixParam', 'mix'));

  /**
   * Live params off the DURABLE store (the readout rule — an engine read from
   * markup is not reactive), resolving the def DEFAULT for anything untouched.
   * `node.params` is a SPARSE OVERLAY of what has been touched: reading it bare
   * draws a 20 Hz filter beside a dial saying 1.0 kHz.
   */
  let live: ResofilterFaceParams = $derived.by(() => {
    void nodeVersion(nodeId);
    const n = patch.nodes[nodeId] as ModuleNode | undefined;
    const stored = (n?.params as Record<string, number> | undefined) ?? {};
    const byDeclaredId: Record<string, string> = {
      cutoff: cutoffParam,
      resonance: resParam,
      mode: modeParam,
      mix: mixParam,
    };
    return resofilterFaceParams((id) => {
      const src = byDeclaredId[id] ?? id;
      const v = stored[src];
      if (typeof v === 'number') return v;
      return params.find((p) => p.id === src)?.defaultValue;
    });
  });

  /**
   * WHEN THE PHASE TRACE LEADS: allpass, FULLY WET — the one state in which the
   * delivered magnitude is flat by construction and a magnitude plot would draw
   * a straight line.
   *
   * ⚠ NOT "ALLPASS", WHICH IS WHAT THE FIRST VERSION SAID. Mix any dry back
   * against an allpass and its DELIVERED magnitude stops being flat: the
   * rotating phase cancels against the dry path and the response becomes a real
   * notch (measured −154.9 dB at cutoff at mix 0.5, and within 0.2 dB of
   * untouched an octave out). That notch is the phaser — the thing the player
   * hears — so drawing phase over it would hide the answer behind the
   * explanation. Two traces, one quantity each, and between them the two states
   * say the whole thing without a caption: fully wet, the dashed magnitude is
   * FLAT while the phase sweeps; mixed, the dashed wet-only magnitude is still
   * flat while the delivered curve has a null in it.
   */
  let phaseLeads = $derived(live.mode === 4 && live.mix > 0.999);

  let magCurve = $derived(svfResponseCurve(live, 128));
  let wetCurve = $derived(svfWetCurve(live, 128));
  let phaseCurve = $derived(svfPhaseCurve(live, 128));
  let reach = $derived(svfCutoffReach(live));

  // ── SVG geometry, 0..100 × 0..44 user space ────────────────────────────────
  const W = 100;
  const H = 44;
  const PAD_Y = 2;
  const px = (x: number): number => x * W;
  const py = (y: number): number => H - PAD_Y - y * (H - 2 * PAD_Y);
  const pathOf = (pts: readonly { x: number; y: number }[]): string =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(2)},${py(p.y).toFixed(2)}`).join(' ');

  let magPath = $derived(pathOf(magCurve));
  let wetPath = $derived(pathOf(wetCurve));
  let phasePath = $derived(pathOf(phaseCurve));
  /** The 0 dB line — the passband a resonant peak rides ON TOP of. Nothing in
   *  this module is gain-compensated, which is why the peak leaves the box. */
  let unityY = $derived(py((0 - PLOT_FLOOR_DB) / (PLOT_TOP_DB - PLOT_FLOOR_DB)));
  let cutoffX = $derived(px(svfPlotX(live.cutoff)));
  let reachX0 = $derived(px(svfPlotX(reach.loHz)));
  let reachX1 = $derived(px(svfPlotX(reach.hiHz)));

  let modeTag = $derived(RESOFILTER_MODE_SHORT[live.mode] ?? '—');
  /** The value that IS live in this mode — the peak where there is one, the
   *  width where there is not. Both come from the same model the hero prints,
   *  so the legend can never contradict the readout two inches above it. */
  let legendValue = $derived(
    MODES_WITH_PEAK.has(live.mode) ? resofilterPeakText(live) : resofilterWidthText(live),
  );
</script>

<div class="svfr" data-testid="sidebar-panel-svf-response">
  <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
    <!-- THE CV REACH WINDOW: where a full-scale CUTOFF CV can throw the
         corner. The same endpoints the hero strip prints, drawn. -->
    <rect x={reachX0} y="0" width={Math.max(0, reachX1 - reachX0)} height={H} class="reach" />
    <!-- 0 dB: the passband. -->
    <line x1="0" y1={unityY} x2={W} y2={unityY} class="unity" />
    <!-- the corner / centre frequency -->
    <line x1={cutoffX} y1="0" x2={cutoffX} y2={H} class="corner" />
    {#if phaseLeads}
      <!-- ALLPASS, FULLY WET: the flat dashed magnitude and the sweeping phase
           over it are the two halves of "the level does not move and the
           signal does" (see the header note). -->
      <path d={magPath} class="wet" />
      <path d={phasePath} class="curve" />
    {:else}
      <!-- Everywhere else: the WET-only response dashed under the DELIVERED
           one, so MIX is the gap between them. They coincide at mix 1, which
           is the def default. -->
      <path d={wetPath} class="wet" />
      <path d={magPath} class="curve" />
    {/if}
  </svg>
  <div class="svfr-legend">
    <span class="lo" data-testid="sidebar-panel-svf-mode">{modeTag}</span>
    <span class="hi" data-testid="sidebar-panel-svf-value">{legendValue}</span>
  </div>
</div>

<style>
  .svfr {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .svfr svg {
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
  .wet {
    fill: none;
    stroke: var(--dim, #9aa2ad);
    stroke-width: 1;
    stroke-dasharray: 3 2;
    opacity: 0.5;
    vector-effect: non-scaling-stroke;
  }
  .curve {
    fill: none;
    stroke: var(--domain, #38d3c8);
    stroke-width: 1.5;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }
  .svfr-legend {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-family: var(--f-mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .svfr-legend .lo {
    color: var(--dim, #9aa2ad);
  }
  .svfr-legend .hi {
    color: var(--domain, #38d3c8);
    font-weight: 700;
  }
</style>
