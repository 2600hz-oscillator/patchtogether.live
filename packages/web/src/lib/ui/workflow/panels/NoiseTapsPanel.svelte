<script lang="ts">
  // THE THREE TAPS — a registered `custom` dock-sidebar panel (PF-20) for NOISE.
  //
  // The picture, in two halves, because this module has exactly two facts and
  // they are of different kinds:
  //
  //   ABOVE — the SHAPES. Each tap's power spectral density relative to the
  //     WHITE tap, in dB, on a log frequency ruler. White is therefore a flat
  //     0 dB reference by construction and the other two are drawn against it.
  //     The one thing this says that no knob, no meter and no doc sentence in
  //     the repo said before: BROWN IS A LOW-PASS, NOT A SLOPE. It is flat
  //     below ≈ 77 Hz and only −6 dB/oct above, so the def's own "1/f², heavy
  //     low-frequency content" describes it everywhere except the bottom two
  //     octaves, where it is white with a +15.9 dB shelf.
  //
  //   BELOW — the LEVELS. One bar per tap at its RMS in dBFS at the live
  //     LEVEL, on a −60…0 dBFS ruler with the full-scale edge marked. This is
  //     the half that MOVES, and it is the half the single knob is blind to:
  //     one gain writes all three, and they come out 12.3 dB and 7.1 dB apart.
  //
  // ⚠ NEITHER HALF IS A TRACE. Every point comes from `noise-face-model`, whose
  // curves are the generators' own arithmetic — brown's exact one-pole
  // transfer, pink's zero-order-hold row sum — pinned against a Welch PSD of
  // the SHIPPING generators by `noise-face-model.test.ts`. That matters here
  // more than usual: NOISE is FREE-RUNNING (all three tables `.start()` at
  // factory time), so a live analyser trace would be a different picture on
  // every frame and would make the VRT baseline a race. Drawn from the model,
  // the tile is deterministic on a running graph, a frozen one and a silent
  // rack alike.
  //
  // ⚠ THE SPECTRUM HALF IS LEVEL-INVARIANT ON PURPOSE. LEVEL is a scalar gain
  // on all three taps, so it genuinely cannot change a RELATIVE spectrum. A
  // picture that moved with it would be lying; the ladder underneath is where
  // the knob shows up.
  //
  // ⚠ It emits NO `control-<paramId>` testid — it is a READ-ONLY picture, and a
  // control-shaped testid would read as an unbacked extra control to
  // faces-parity's exact multiset (see sidebar-panels.ts rule 1).

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import {
    NOISE_LADDER_FLOOR_DB,
    NOISE_PLOT_MAX_HZ,
    NOISE_PLOT_MIN_HZ,
    NOISE_TAPS,
    noiseBrownCornerHz,
    noiseBrownCornerText,
    noiseFaceParams,
    noiseLadderFill,
    noisePlotX,
    noisePlotY,
    noiseTapDbText,
    noiseTapRelDb,
    type NoiseFaceParams,
    type NoiseTap,
  } from '$lib/ui/modules/noise-face-model';

  interface Props {
    nodeId: string;
    props?: Readonly<Record<string, string | number>>;
    /** The def's params — needed for the DEFAULT fallback below. */
    params?: readonly ParamDef[];
  }
  let { nodeId, params = [] }: Props = $props();

  /**
   * ⚠ THE `?? defaultValue` IS LOAD-BEARING. `node.params` is a SPARSE overlay
   * of what has been TOUCHED, so reading it bare draws an empty ladder beside a
   * dial reading 0.50 on a fresh spawn (the StereoCrossoverPanel scar).
   *
   * ⚠ THE VERSION IS READ INSIDE THE DERIVED (the ModuleShell `liveCell`
   * pattern): `patch.nodes[id]` is a stable SyncedStore proxy, so a derived
   * that does not touch `nodeVersion(id)` freezes at first render.
   */
  let voice = $derived.by<NoiseFaceParams>(() => {
    void nodeVersion(nodeId);
    const n = patch.nodes[nodeId] as ModuleNode | undefined;
    const live = n?.params as Record<string, number> | undefined;
    return noiseFaceParams((id) => {
      const v = live?.[id];
      if (typeof v === 'number') return v;
      return params.find((p) => p.id === id)?.defaultValue;
    });
  });

  const W = 100;
  /** The spectrum bay. */
  const SPEC_H = 46;

  /** One tap's relative-PSD curve as a polyline over the log axis. */
  function curve(tap: NoiseTap): string {
    const STEPS = 72;
    const pts: string[] = [];
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const hz = NOISE_PLOT_MIN_HZ * Math.pow(NOISE_PLOT_MAX_HZ / NOISE_PLOT_MIN_HZ, t);
      pts.push(`${(t * W).toFixed(2)},${(noisePlotY(noiseTapRelDb(tap, hz)) * SPEC_H).toFixed(2)}`);
    }
    return pts.join(' ');
  }

  /** Decade rules, so the log axis reads as frequency and not just as "left is
   *  low". 100 Hz / 1 kHz / 10 kHz are the three inside the window. */
  const DECADES = [100, 1000, 10000] as const;
  const cornerX = noisePlotX(noiseBrownCornerHz()) * W;
  /** The 0 dB reference row — where the white tap's flat line sits. */
  const zeroY = noisePlotY(0) * SPEC_H;
</script>

<div class="taps" data-testid="sidebar-panel-noise-taps">
  <svg
    class="spectra"
    viewBox="0 0 {W} {SPEC_H}"
    preserveAspectRatio="none"
    role="img"
    aria-label="white, pink and brown spectra relative to the white tap, on a log frequency axis, with brown's low-pass corner marked"
  >
    {#each DECADES as d (d)}
      <line class="decade" x1={noisePlotX(d) * W} x2={noisePlotX(d) * W} y1="0" y2={SPEC_H} />
    {/each}
    <line class="zero" x1="0" x2={W} y1={zeroY} y2={zeroY} />
    <!-- Brown's −3 dB corner. The one annotation on the picture, because it is
         the one number that changes what the tap IS rather than how loud. -->
    <line class="corner" x1={cornerX} x2={cornerX} y1="0" y2={SPEC_H} />
    {#each NOISE_TAPS as tap (tap)}
      <polyline class="curve c-{tap}" points={curve(tap)} />
    {/each}
  </svg>
  <div class="spec-legend">
    <span class="corner-note" data-testid="noise-corner-note"
      >brown −3 dB at {noiseBrownCornerText()} · 48 kHz</span
    >
    <span class="axis-note">20 Hz – 20 kHz</span>
  </div>

  <div class="ladder">
    {#each NOISE_TAPS as tap (tap)}
      <!-- `data-fill` carries the FRACTION, not a pixel width: an e2e that
           measured the rendered box would be measuring the sidebar's layout as
           much as the model, and would move with every column-width change. -->
      <div class="rung" data-testid="noise-ladder-{tap}" data-fill={noiseLadderFill(tap, voice).toFixed(4)}>
        <span class="rung-label">{tap}</span>
        <span class="rung-track">
          <span class="rung-fill c-{tap}" style={`width:${(noiseLadderFill(tap, voice) * 100).toFixed(2)}%`}
          ></span>
        </span>
        <span class="rung-db">{noiseTapDbText(tap, voice)}</span>
      </div>
    {/each}
  </div>
  <div class="ladder-legend">
    <span>{NOISE_LADDER_FLOOR_DB} dBFS</span>
    <span>one LEVEL · three levels</span>
    <span>0</span>
  </div>
</div>

<style>
  .taps {
    display: grid;
    gap: 4px;
  }
  .spectra {
    width: 100%;
    height: 66px;
    display: block;
    background: rgb(0 0 0 / 0.35);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 3px;
  }
  .curve {
    fill: none;
    stroke-width: 1.25;
    vector-effect: non-scaling-stroke;
  }
  /* The three taps keep ONE colour each across both halves of the panel, so
     the ladder underneath needs no second key. */
  .c-white {
    stroke: #dfe7ec;
    background: #dfe7ec;
  }
  .c-pink {
    stroke: #ef7fa6;
    background: #ef7fa6;
  }
  .c-brown {
    stroke: #c98b4b;
    background: #c98b4b;
  }
  .decade {
    stroke: rgb(255 255 255 / 0.07);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .zero {
    stroke: rgb(255 255 255 / 0.16);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .corner {
    stroke: #c98b4b;
    stroke-width: 1;
    stroke-dasharray: 2 2;
    opacity: 0.55;
    vector-effect: non-scaling-stroke;
  }
  .spec-legend,
  .ladder-legend {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    font-size: 9px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    opacity: 0.72;
  }
  .corner-note {
    color: #c98b4b;
    opacity: 0.95;
  }
  .ladder {
    display: grid;
    gap: 2px;
  }
  .rung {
    display: grid;
    grid-template-columns: 38px 1fr 54px;
    align-items: center;
    gap: 5px;
    font-size: 9px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .rung-label {
    opacity: 0.72;
  }
  .rung-track {
    display: block;
    height: 6px;
    border-radius: 2px;
    background: rgb(0 0 0 / 0.35);
    border: 1px solid rgb(255 255 255 / 0.08);
    overflow: hidden;
  }
  .rung-fill {
    display: block;
    height: 100%;
  }
  .rung-db {
    text-align: right;
    font-variant-numeric: tabular-nums;
    opacity: 0.88;
  }
</style>
