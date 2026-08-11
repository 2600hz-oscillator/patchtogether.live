<script lang="ts">
  // RingsCombPanel — the faceplate's HERO PICTURE: the 24-partial MODAL bank
  // under its cosine pickup comb, plus the POSITION dial's whole travel drawn
  // as the mirror-symmetric curve it actually is.
  //
  // ⚠ NOT A TRACE. Every bar comes from `rings-face-model`, computed through
  // `RingsModal.configure`'s own laws off the LIVE params — so the picture says
  // what the body WILL do before anything has struck it. That matters more here
  // than on most modules: RINGS is bit-silent until excited (measured peak
  // exactly 0.000e+0 on both taps), so an analyser trace of a fresh spawn is a
  // flat line, and this panel is the only surface that is alive at rest.
  //
  // ⚠ THREE THINGS IT EXISTS TO SHOW, none of which a number can say:
  //   · WHICH TAP each partial lands in. ODD holds h1 h3 h5 …, EVEN holds
  //     h2 h4 h6 …, measured 84-129 dB apart per bin. Two colours say that
  //     instantly; the docs' phrase "complementary taps" did not.
  //   · THAT HALF THE POSITION DIAL IS A DUPLICATE. cos(2*PI*(1-p)*n) =
  //     cos(2*PI*p*n), so the travel curve is symmetric about 0.5 — drawn, the
  //     redundancy is obvious; described, it is a sentence nobody reads.
  //   · WHERE THE EVEN TAP DIES. The two quarter-marks are drawn on the travel
  //     strip because a stereo pair where one side vanishes at two dial
  //     positions is exactly what a picture answers and a readout does not.
  //
  // ⚠ THIS PANEL EMITS NO `control-<paramId>` TESTID (shell-cells rule 1) and
  // WRITES NOTHING. Its one affordance is the VIEW toggle, which is PRIVATE
  // component state — flipping your own view must not re-draw a collaborator's
  // screen or dirty the patch.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import {
    ringsCombBank,
    ringsCombMirrorCurve,
    ringsFaceParams,
    type RingsFaceParams,
  } from './rings-face-model';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern). `patch.nodes[id]` is a stable SyncedStore proxy, so a derived
   *  that bumps on `nodeVersion(id)` and returns it BARE is `===` to its
   *  previous value and the whole picture freezes at first render. */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));

  let p = $derived.by<RingsFaceParams>(() =>
    ringsFaceParams((id) => {
      const v = live.n?.params?.[id];
      return typeof v === 'number' ? v : undefined;
    }),
  );

  /** AS HEARD = the bank under the pickup comb. BANK ONLY = the same bank with
   *  every pickup weight forced to 1, which is what POSITION 0 / 0.5 / 1
   *  literally are. Flipping between them is how you SEE what the comb removed.
   *  COMPONENT STATE — see the header. */
  const VIEWS = ['as heard', 'bank only'] as const;
  let view = $state<(typeof VIEWS)[number]>(VIEWS[0]);
  let weighted = $derived(view === VIEWS[0]);

  let bank = $derived(ringsCombBank(weighted ? p : { ...p, position: 0 }));
  let liveBars = $derived(bank.filter((b) => b.active));
  let travel = $derived(ringsCombMirrorCurve(p));

  const PLOT_W = 100;
  const PLOT_H = 62;
  const STRIP_H = 22;

  /** Log-frequency x for a partial, over the span the ACTIVE bank occupies. */
  function xOf(hz: number): number {
    const lo = liveBars[0]?.hz ?? 1;
    const hi = liveBars[liveBars.length - 1]?.hz ?? lo * 2;
    if (!(hi > lo)) return 0;
    return (Math.log2(hz / lo) / Math.log2(hi / lo)) * PLOT_W;
  }

  let pos = $derived(Math.max(0, Math.min(1, p.position)));
  let mirror = $derived(1 - pos);

  let travelPts = $derived(
    travel
      .map((v, i) => `${((i / (travel.length - 1)) * PLOT_W).toFixed(2)},${((1 - v) * STRIP_H).toFixed(2)}`)
      .join(' '),
  );

  /** The caption is the panel's OPERABILITY WITNESS and it is the VIEW NAME
   *  ALONE — a state word, not a sentence (owner directive 2026-08-11: a
   *  faceplate states values, it does not narrate). It still discriminates: a
   *  VIEW button that did nothing could not change it, and the button's own
   *  label is fixed so the two elements cannot be reading each other. */
  let caption = $derived(view);
</script>

<div class="rings-comb" data-testid="rings-comb">
  <svg
    viewBox="0 0 {PLOT_W} {PLOT_H}"
    preserveAspectRatio="none"
    role="img"
    aria-label="the {liveBars.length} active modal partials on a log-frequency axis, coloured by output tap, each scaled by its cosine pickup weight"
  >
    <line class="base" x1="0" x2={PLOT_W} y1={PLOT_H} y2={PLOT_H} />
    {#each liveBars as b (b.index)}
      <line
        class="bar {b.tap}"
        x1={xOf(b.hz)}
        x2={xOf(b.hz)}
        y1={PLOT_H}
        y2={PLOT_H - b.height * PLOT_H}
      />
    {/each}
  </svg>

  <!-- THE TRAVEL STRIP: the pickup comb's mean weight over the WHOLE dial. It
       is symmetric about the centre line, and that symmetry IS the finding. -->
  <svg
    class="strip"
    viewBox="0 0 {PLOT_W} {STRIP_H}"
    preserveAspectRatio="none"
    role="img"
    aria-label="pickup weight across the whole POSITION travel — symmetric about 0.5, with the EVEN tap's two silent nodes marked"
  >
    <polyline class="travel" points={travelPts} />
    <line class="axis-mid" x1={PLOT_W / 2} x2={PLOT_W / 2} y1="0" y2={STRIP_H} />
    {#each [0.25, 0.75] as n (n)}
      <line class="node" x1={n * PLOT_W} x2={n * PLOT_W} y1="0" y2={STRIP_H} />
    {/each}
    <line class="mirror" x1={mirror * PLOT_W} x2={mirror * PLOT_W} y1="0" y2={STRIP_H} />
    <line class="here" x1={pos * PLOT_W} x2={pos * PLOT_W} y1="0" y2={STRIP_H} />
  </svg>

  <div class="axis">
    <span class="cap" data-testid="rings-comb-caption">{caption}</span>
    <button
      type="button"
      class="win"
      data-testid="rings-comb-view"
      title="Flip between the bank as heard (under the pickup comb) and the bank alone. Your screen only: this is not shared or saved."
      onclick={() => (view = view === VIEWS[0] ? VIEWS[1] : VIEWS[0])}
    >view</button>
  </div>

  <!-- A COLOUR LEGEND, not a caption: which colour is which output. The tap
       CONTENTS (h1 h3 h5 against h2 h4 h6), the mirror partner and the picture's
       reference rate were all drawn here in an earlier pass and cut — they are
       explanation, and they live in `docs.outputs` / `docs.controls.position`
       for right-click → annotate to source. -->
  <div class="key">
    <span class="k-odd">ODD</span>
    <span class="k-even">EVEN</span>
  </div>
</div>

<style>
  .rings-comb {
    width: 100%;
    display: grid;
    grid-template-rows: 1fr auto auto auto;
    gap: 3px;
    font-family: var(--font-display, monospace);
  }
  .rings-comb svg {
    width: 100%;
    height: 116px;
    background: var(--bg-sunken, #0e0e0e);
    border: 1px solid var(--border, #444);
  }
  .rings-comb svg.strip {
    height: 34px;
  }
  .base {
    stroke: var(--border, #444);
    stroke-width: 0.5;
    vector-effect: non-scaling-stroke;
  }
  .bar {
    stroke-width: 2.5;
    vector-effect: non-scaling-stroke;
    stroke-linecap: butt;
  }
  .bar.odd { stroke: var(--cable-audio, #6cf); }
  .bar.even { stroke: var(--accent-warm, #f9a03f); }
  .travel {
    fill: none;
    stroke: var(--text-muted, #999);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .axis-mid {
    stroke: var(--border, #444);
    stroke-width: 0.5;
    stroke-dasharray: 2 2;
    vector-effect: non-scaling-stroke;
  }
  .node {
    stroke: var(--accent-warm, #f9a03f);
    stroke-width: 1;
    stroke-dasharray: 3 2;
    vector-effect: non-scaling-stroke;
    opacity: 0.75;
  }
  .mirror {
    stroke: var(--text-muted, #999);
    stroke-width: 1;
    stroke-dasharray: 1 2;
    vector-effect: non-scaling-stroke;
  }
  .here {
    stroke: var(--cable-audio, #6cf);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .axis {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-size: 0.6rem;
    color: var(--text-muted, #999);
  }
  .cap {
    letter-spacing: 0.04em;
  }
  .win {
    border: 1px solid var(--border, #555);
    background: var(--bg-elevated, #1a1a1a);
    color: var(--text, #eee);
    font-family: inherit;
    font-size: 0.6rem;
    padding: 1px 6px;
    cursor: pointer;
    white-space: nowrap;
  }
  .win:hover { background: var(--bg-hover, #2a2a2a); }
  .key {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 0.58rem;
    color: var(--text-muted, #999);
  }
  .k-odd { color: var(--cable-audio, #6cf); }
  .k-even { color: var(--accent-warm, #f9a03f); }
</style>
